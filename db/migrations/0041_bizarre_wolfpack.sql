-- 本次迁移会对 sale_order_payments 取 ACCESS EXCLUSIVE（ADD CONSTRAINT 全表扫描），
-- 且该锁一直持有到事务提交。drizzle 把**所有**待应用迁移放进同一个事务
-- （已核 drizzle-orm 0.45.1 `pg-core/dialect.cjs`：迁移循环写在 `session.transaction()` 里面），
-- 所以待迁条数越多，这个锁窗口越长。
-- 小程序端是 7×24 在写的，一旦排在某条长查询后面，整张表的读写都会堆在锁队列里。
-- 宁可迁移失败重来，也不要把业务卡住 —— 3 秒拿不到锁就放弃。
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP VIEW "public"."sale_item_performance_events";--> statement-breakpoint
DROP VIEW "public"."sale_order_performance_events";--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "chk_sop_attribution_date_present" CHECK ("sale_order_payments"."performance_attribution_date" IS NOT NULL);--> statement-breakpoint
CREATE VIEW "public"."sale_item_performance_events" AS (
  WITH performance_events AS (
    
  SELECT
    sop.id AS sale_payment_id,
    sop.sale_order_id,
    so.store_id,
    so.sale_order_type,
    so.legacy_source,
    sop.change_type,
    sop.payment_method,
    sop.status,
    sop.amount,
    sop.paid_at,
    sop.performance_attribution_date AS performance_date,
    (
      sop.status = '已支付'
      AND sop.amount::numeric > 0
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
      AND NOT EXISTS (
        SELECT 1
        FROM sale_order_payments prior
        WHERE prior.sale_order_id = sop.sale_order_id
          AND prior.status = '已支付'
          AND prior.amount::numeric > 0
          AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
          AND (
            COALESCE(prior.paid_at, prior.created_at),
            prior.id
          ) < (
            COALESCE(sop.paid_at, sop.created_at),
            sop.id
          )
      )
    ) AS is_initial_event
  FROM sale_order_payments sop
  JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id

  ),
  paid_receipts AS (
    SELECT
      spir.id,
      spir.sale_payment_id,
      spir.sale_order_id,
      spir.sale_item_id,
      spir.amount,
      spir.sales_category,
      spe.store_id,
      spe.change_type,
      spe.performance_date,
      spe.is_initial_event
    FROM sale_payment_item_receipts spir
    JOIN performance_events spe
      ON spe.sale_payment_id = spir.sale_payment_id
     AND spe.status = '已支付'
  ),
  receipt_totals AS (
    SELECT sale_item_id, SUM(amount)::numeric(10, 2) AS amount
    FROM paid_receipts
    GROUP BY sale_item_id
  ),
  residuals AS (
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      so.store_id,
      ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2)::numeric(10, 2) AS amount,
      si.sales_category,
      so.performance_attribution_date
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    LEFT JOIN receipt_totals rt ON rt.sale_item_id = si.sale_item_id
    WHERE ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2) <> 0
  )
  SELECT
    'receipt:' || pr.id::text AS event_key,
    pr.id AS receipt_id,
    pr.sale_payment_id,
    pr.sale_order_id,
    pr.sale_item_id,
    pr.store_id,
    pr.amount,
    pr.sales_category,
    pr.change_type,
    pr.performance_date,
    pr.is_initial_event,
    false AS is_legacy_residual
  FROM paid_receipts pr
  UNION ALL
  SELECT
    'residual:' || r.sale_item_id AS event_key,
    NULL::bigint AS receipt_id,
    NULL::bigint AS sale_payment_id,
    r.sale_order_id,
    r.sale_item_id,
    r.store_id,
    r.amount,
    r.sales_category,
    '首次支付'::payment_change_type AS change_type,
    r.performance_attribution_date AS performance_date,
    true AS is_initial_event,
    true AS is_legacy_residual
  FROM residuals r
);--> statement-breakpoint
CREATE VIEW "public"."sale_order_performance_events" AS (
  SELECT
    sop.id AS sale_payment_id,
    sop.sale_order_id,
    so.store_id,
    so.sale_order_type,
    so.legacy_source,
    sop.change_type,
    sop.payment_method,
    sop.status,
    sop.amount,
    sop.paid_at,
    sop.performance_attribution_date AS performance_date,
    (
      sop.status = '已支付'
      AND sop.amount::numeric > 0
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
      AND NOT EXISTS (
        SELECT 1
        FROM sale_order_payments prior
        WHERE prior.sale_order_id = sop.sale_order_id
          AND prior.status = '已支付'
          AND prior.amount::numeric > 0
          AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
          AND (
            COALESCE(prior.paid_at, prior.created_at),
            prior.id
          ) < (
            COALESCE(sop.paid_at, sop.created_at),
            sop.id
          )
      )
    ) AS is_initial_event
  FROM sale_order_payments sop
  JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
);--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════════
-- 款项业绩归属日期收敛为唯一口径（issue #137，2026-09-14 需求）
--
-- 上面 drizzle 生成的部分做了两件事：把两个视图的 performance_date 从
-- 「CASE 三分支 + LATERAL 配对」改成直读 sale_order_payments.performance_attribution_date，
-- 并给该列加上 chk_sop_attribution_date_present（等价 NOT NULL）。
-- 下面三段是让这条直读长期成立的前提：
--   ① 回填：首次支付行重新对齐订单级归属日期
--   ② 收敛后自检：直读值 与 旧 CASE 表达式 逐行比对，有偏差就 RAISE 阻断迁移
--   ③ 订单级归属日期变更 → 款项行同步，从应用层下沉为 sale_orders 的 AFTER UPDATE trigger
--   ④ 给 0039 的 BEFORE trigger 补行锁，堵住「改期与首次支付/卡行入账并发」的脏读
--
-- 关于非空约束：0039 的注释里担心"绕过 trigger 的写入路径会直接 500"。实测
-- `initialize_payment_performance_attribution_date()` 是 BEFORE INSERT OR UPDATE OF ...，
-- INSERT 恒触发，三端云函数不带这一列的 INSERT 也会被填上。查询侧直读列之后，
-- NULL 会让业绩事件整行从报表里消失（比 500 更难发现），因此把约束补上。
--
-- 用 CHECK 而不是 SET NOT NULL：`.notNull()` 会让 drizzle 的 $inferInsert 把这一列变成必填，
-- 三端 7 处 INSERT 都得自己算一遍归属日期，正好与本次收敛相反；改用
-- `.notNull().default(...)` 更糟 —— DEFAULT 在 BEFORE trigger 之前生效，
-- trigger 里的 `IF NEW.performance_attribution_date IS NULL` 将永不成立，
-- 回款/退款会被静默落到 DEFAULT 那一天而不是 paid_at 当天。
-- ════════════════════════════════════════════════════════════════════════════

-- ── ① 回填：首次支付行重新对齐订单级 ────────────────────────────────────────
-- 0039 已经做过同一件事，这里必须再做一次：0039 之后**又**攒下了新的脱拍行。
-- 根因是订单级归属日期的调整入口（admin `updatePerformanceAttributionDate` /
-- staffApi `updatePerformanceAttribution`）靠应用层 UPDATE 同步首次支付行，而带这段逻辑的
-- 版本至今没有部署到 prod —— 2026-09-14 实测 prod 有 14 单只改了 sale_orders、没同步款项行
-- （全部是 2026-09-12 之后人工调整过归属日期的销售单）。
-- 旧视图的 CASE 对首次支付恒取订单级，所以这些脱拍在报表上看不出来；一旦改成直读列，
-- 这 14 单的首次支付业绩就会落到调整前的日子。本段把它们拉回来，③ 的 trigger 负责杜绝再发生。
--
-- 会触发 sale_order_payments 的 BEFORE trigger（UPDATE OF performance_attribution_date），
-- 它重新从 sale_orders 取同一个值，幂等；其反向同步块会连带把同次储值卡从行一起拉齐。
UPDATE sale_order_payments p
SET performance_attribution_date = so.performance_attribution_date
FROM sale_orders so
WHERE so.sale_order_id = p.sale_order_id
  AND p.change_type = '首次支付'
  AND p.performance_attribution_date IS DISTINCT FROM so.performance_attribution_date;--> statement-breakpoint

-- ── ② 收敛后自检：直读列 vs 旧 CASE 表达式 ──────────────────────────────────
-- fail-closed：drizzle 的 migration 跑在单事务里，RAISE EXCEPTION 会整体回滚，
-- 视图、CHECK 约束与 trigger 都不会半落地。偏差需要人工判读后再决定回填还是改口径，
-- 不在这里自动纠正（自动纠正会掩盖上游写入路径的缺陷）。
--
-- 首次支付那一支已由 ① 回填拉齐，这里主要盯的是储值卡抵扣：旧视图对卡行**优先取配对主流水**
-- 的归属日（优先级高于自身列值），直读之后取的是自身列值。0038/0039 的回填与 trigger 已让两者
-- 在写入时一致，这里做实测确认（2026-09-14 prod 实测该类偏差 0 行）。
DO $$
DECLARE
  drift_count bigint;
  drift_sample text;
BEGIN
  WITH legacy AS (
    SELECT
      sop.id,
      sop.sale_order_id,
      sop.change_type::text AS change_type,
      sop.performance_attribution_date AS column_value,
      CASE
        WHEN sop.change_type = '首次支付' THEN so.performance_attribution_date
        -- 卡行只在「已支付」时受 trigger 管（③ 的第一条 UPDATE 带 status='已支付'）。
        -- 不加这个条件的话，待审批/已作废的卡行会在订单级改期后被判成漂移 —— 那类行
        -- 被所有报表的 status='已支付' 过滤掉，属于无害漂移，不该 fail-closed 卡住迁移。
        WHEN sop.change_type = '储值卡抵扣' AND sop.status = '已支付'
          AND paired_payment.performance_date IS NOT NULL
          THEN paired_payment.performance_date
        ELSE COALESCE(
          sop.performance_attribution_date,
          (sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
          (sop.created_at AT TIME ZONE 'Asia/Shanghai')::date
        )
      END AS legacy_value
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN primary_payment.change_type = '首次支付'
            THEN so.performance_attribution_date
          ELSE COALESCE(
            primary_payment.performance_attribution_date,
            (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
            (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END AS performance_date
      FROM sale_order_payments primary_payment
      WHERE sop.change_type = '储值卡抵扣'
        AND primary_payment.sale_order_id = sop.sale_order_id
        AND primary_payment.change_type IN ('首次支付', '回款')
        AND primary_payment.status = sop.status
        AND primary_payment.paid_at IS NOT DISTINCT FROM sop.paid_at
      ORDER BY
        CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
        primary_payment.id
      LIMIT 1
    ) paired_payment ON true
  ),
  drifted AS (
    SELECT * FROM legacy WHERE column_value IS DISTINCT FROM legacy_value
  )
  SELECT
    (SELECT COUNT(*) FROM drifted),
    (
      SELECT string_agg(
        format('#%s/%s(%s) 列=%s 旧=%s', id, sale_order_id, change_type, column_value, legacy_value),
        '; ' ORDER BY id
      )
      FROM (SELECT * FROM drifted ORDER BY id LIMIT 20) s
    )
  INTO drift_count, drift_sample;

  IF drift_count > 0 THEN
    RAISE EXCEPTION
      '收敛自检失败：% 行款项的归属日期列值与旧 CASE 口径不一致，迁移已回滚。样例：%',
      drift_count, drift_sample;
  END IF;
END $$;--> statement-breakpoint

-- ── ③ 订单级归属日期变更 → 款项行同步（应用层下沉为 trigger）────────────────
-- 变更前：admin `orders.ts updatePerformanceAttributionDate` 与 staffApi
-- `order.js updatePerformanceAttribution` 各写一份同语义 UPDATE。查询侧还留着 CASE 时，
-- 漏同步只是"镜像列脏"而报表仍对；直读列之后，任何漏同步的写入路径都会直接出错数。
--
-- **两条 UPDATE 不能合并成一条**：首次支付行的 BEFORE trigger（0039）会反向同步同次储值卡从行，
-- 若与卡行在同一条语句里更新，PG 报
-- `tuple to be updated was already modified by an operation triggered by the current command`。
-- 顺序保持「卡行在前」：反过来在当前逻辑下也能得到同样的结果（先跑首次支付，其反向同步会从
-- 已更新的 sale_orders 取出同样的值写进卡行，第二条 UPDATE 只是幂等重写），但那依赖
-- 反向同步块的具体实现，而"拆成两条"依赖的是 PG 的硬性限制。两者都不要动：
-- `db/scripts/__tests__/payment-migrations-regression.test.js` 对拆句与顺序都有字面量断言。
CREATE OR REPLACE FUNCTION sync_order_performance_attribution_to_payments()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 同次首次支付中被合并的储值卡流水与订单共用归属日期和那一次调整机会。
  -- 带 IS DISTINCT FROM 三连：本 trigger 的 WHEN 包含 adjusted_at/by，将来若出现"只改调整人"
  -- 这类更新（DBA 手工、新代码路径），不加防护会把已经一致的卡行整批重写一遍。
  UPDATE sale_order_payments card
  SET performance_attribution_date = NEW.performance_attribution_date,
      performance_attribution_adjusted_at = NEW.performance_attribution_adjusted_at,
      performance_attribution_adjusted_by = NEW.performance_attribution_adjusted_by
  WHERE card.sale_order_id = NEW.sale_order_id
    AND card.change_type = '储值卡抵扣'
    AND card.status = '已支付'
    AND (
      card.performance_attribution_date IS DISTINCT FROM NEW.performance_attribution_date
      OR card.performance_attribution_adjusted_at IS DISTINCT FROM NEW.performance_attribution_adjusted_at
      OR card.performance_attribution_adjusted_by IS DISTINCT FROM NEW.performance_attribution_adjusted_by
    )
    AND EXISTS (
      SELECT 1
      FROM sale_order_payments first_payment
      WHERE first_payment.sale_order_id = card.sale_order_id
        AND first_payment.change_type = '首次支付'
        AND first_payment.status = card.status
        AND first_payment.paid_at IS NOT DISTINCT FROM card.paid_at
    );

  -- 首次支付行的归属日期恒等于订单级。调整机会标记（adjusted_at/by）**不**镜像：
  -- 首次支付不可被单独修改，那一次机会始终记在 sale_orders 上。
  UPDATE sale_order_payments first_payment
  SET performance_attribution_date = NEW.performance_attribution_date
  WHERE first_payment.sale_order_id = NEW.sale_order_id
    AND first_payment.change_type = '首次支付'
    AND first_payment.performance_attribution_date
        IS DISTINCT FROM NEW.performance_attribution_date;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER trg_sale_orders_sync_payment_attribution
AFTER UPDATE OF
  performance_attribution_date,
  performance_attribution_adjusted_at,
  performance_attribution_adjusted_by
ON sale_orders
FOR EACH ROW
WHEN (
  OLD.performance_attribution_date IS DISTINCT FROM NEW.performance_attribution_date
  OR OLD.performance_attribution_adjusted_at IS DISTINCT FROM NEW.performance_attribution_adjusted_at
  OR OLD.performance_attribution_adjusted_by IS DISTINCT FROM NEW.performance_attribution_adjusted_by
)
EXECUTE FUNCTION sync_order_performance_attribution_to_payments();
--> statement-breakpoint

-- ── ④ 给 0039 的 BEFORE trigger 补行锁：堵住改期与入账并发的脏读 ──────────────
-- 竞态（READ COMMITTED，两个事务）：
--   T1 `updatePerformanceAttributionDate`：FOR UPDATE 锁住订单 → 改订单级为 D2（未提交）
--   T2 任一首次支付 INSERT：0039 的 BEFORE trigger 执行
--      `SELECT so.performance_attribution_date INTO NEW...`，**不带任何行锁** → 读到旧值 D1
--
--   PG 的 INSERT 次序是「BEFORE ROW trigger → 写元组 → 语句末 AFTER trigger（含外键 RI 检查）」，
--   而取 FOR KEY SHARE 的是**外键检查**那一步。也就是说 T2 先用旧快照把 D1 算完写进元组，
--   之后才去排队等 T1 的锁；T1 提交后 T2 解除阻塞、原样提交 D1。两边都不报错。
--   结果：订单级 = D2，首次支付行 = D1，镜像永久脱拍。
--
-- 这个竞态在本次迁移之前就存在，但那时视图对首次支付恒取订单级（CASE 那一支），
-- 脏镜像只是"列脏"而报表仍对。改成直读列之后，同一个竞态会直接产出错误的业绩归属日。
--
-- 修法：把那两次读改成 FOR SHARE。READ COMMITTED 下会阻塞到 T1 提交，再走 EPQ
-- 重取最新版本拿到 D2。顺带把锁序统一成 `sale_orders → sale_order_payments`，
-- 与改期路径一致，消除了原先的锁序倒置。
--
-- ⚠ 必须是 FOR SHARE，**不能是 FOR KEY SHARE**（实测踩过）：归属日期不是键列，普通的
-- `UPDATE sale_orders SET performance_attribution_date = ...` 取的是 FOR NO KEY UPDATE，
-- 而 PG 的行锁矩阵里 FOR KEY SHARE 与 FOR NO KEY UPDATE **不冲突** —— 挡不住。
-- 只有 admin/staff 入口那种先 `SELECT ... FOR UPDATE` 的写法才会被 FOR KEY SHARE 挡住，
-- 任何直接 UPDATE 的路径（运维脚本、将来的新代码）都会重新漏出去。
--
-- 0039 是已发布的迁移，不能原地改 —— 这里用 CREATE OR REPLACE 重新定义同一个函数，
-- **除这两处加锁外，函数体与 0039 逐字相同**。
CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.change_type = '首次支付' THEN
    -- 首次支付行是订单级归属日期的镜像。调整机会标记（adjusted_at/by）**不**镜像：
    -- 首次支付不可被单独修改，那一次机会始终记在 sale_orders 上。
    -- FOR SHARE：不加锁会读到并发改期事务提交前的旧值，见本段开头的竞态说明。
    SELECT so.performance_attribution_date
      INTO NEW.performance_attribution_date
      FROM sale_orders so
     WHERE so.sale_order_id = NEW.sale_order_id
       FOR SHARE;
  ELSE
    -- 未入账时写下的归属日期只是按 created_at 折的占位值；真正入账那一刻必须按
    -- paid_at 重算，否则待审批回款会永远停在创建日。已人工调整过的不动，
    -- 同一条 UPDATE 里显式改过这一列的也不动。
    IF TG_OP = 'UPDATE'
       AND OLD.paid_at IS NULL
       AND NEW.paid_at IS NOT NULL
       AND NEW.performance_attribution_adjusted_at IS NULL
       AND NEW.performance_attribution_date IS NOT DISTINCT FROM OLD.performance_attribution_date THEN
      NEW.performance_attribution_date := NULL;
    END IF;

    IF NEW.performance_attribution_date IS NULL THEN
      IF NEW.change_type = '储值卡抵扣' THEN
        SELECT
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_date
            ELSE COALESCE(
              primary_payment.performance_attribution_date,
              (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
              (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
            )
          END,
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_at
            ELSE primary_payment.performance_attribution_adjusted_at
          END,
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_by
            ELSE primary_payment.performance_attribution_adjusted_by
          END
        INTO
          NEW.performance_attribution_date,
          NEW.performance_attribution_adjusted_at,
          NEW.performance_attribution_adjusted_by
        FROM sale_order_payments primary_payment
        JOIN sale_orders so ON so.sale_order_id = primary_payment.sale_order_id
        WHERE primary_payment.sale_order_id = NEW.sale_order_id
          AND primary_payment.change_type IN ('首次支付', '回款')
          AND primary_payment.status = NEW.status
          AND primary_payment.paid_at IS NOT DISTINCT FROM NEW.paid_at
        ORDER BY
          CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
          primary_payment.id
        LIMIT 1
        -- 同上：这一支在 primary 是首次支付时也读 so 的归属日期与调整标记，
        -- 并发改期下不锁就会拿到旧值。只锁 so，不锁 primary_payment（它不是竞争对象）。
        FOR SHARE OF so;
      END IF;

      IF NEW.performance_attribution_date IS NULL THEN
        NEW.performance_attribution_date :=
          (COALESCE(NEW.paid_at, NEW.created_at, NOW()) AT TIME ZONE 'Asia/Shanghai')::date;
      END IF;
    END IF;
  END IF;

  -- staff 线下确认会先写卡流水、后写现付主流水；主流水后写时反向同步，保证写入顺序无关。
  -- 首次支付分支不再从 sale_orders 二次取值：上面的镜像已经把它写进 NEW。
  --
  -- NOT EXISTS 那一段是「胜出者」判定：同单、同 status、同精确 paid_at 下可能存在多行主流水
  -- （DB 不禁止多笔同时刻回款；首次支付与回款也可能撞同一个 paid_at）。卡行该跟谁，
  -- 迁移自检 ② 与 cron 的 I6b 都按「首次支付优先、其次 id 最小」选唯一胜出者；
  -- 这里若不做同样的判定，后写的非胜出行会把卡行覆盖成另一个日期，
  -- 于是次日 I6b 报一条并不存在的"漂移"。三处口径必须一致。
  IF NEW.change_type IN ('首次支付', '回款')
     AND NEW.status = '已支付'
     AND NEW.paid_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM sale_order_payments better
       WHERE better.sale_order_id = NEW.sale_order_id
         AND better.id <> NEW.id
         AND better.change_type IN ('首次支付', '回款')
         AND better.status = NEW.status
         AND better.paid_at IS NOT DISTINCT FROM NEW.paid_at
         AND (
           (better.change_type = '首次支付' AND NEW.change_type = '回款')
           OR (better.change_type = NEW.change_type AND better.id < NEW.id)
         )
     ) THEN
    UPDATE sale_order_payments card
    SET performance_attribution_date = NEW.performance_attribution_date,
        performance_attribution_adjusted_at = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_at
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_at
        END,
        performance_attribution_adjusted_by = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_by
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_by
        END
    WHERE card.sale_order_id = NEW.sale_order_id
      AND card.change_type = '储值卡抵扣'
      AND card.status = NEW.status
      AND card.paid_at IS NOT DISTINCT FROM NEW.paid_at;
  END IF;
  RETURN NEW;
END;
$$;
