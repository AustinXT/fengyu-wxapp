ALTER TABLE "sale_items" ADD COLUMN "refunded_quantity" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "converted_quantity" integer DEFAULT 0;--> statement-breakpoint
-- ↑ 以上为 drizzle-kit 生成；以下为手写回填（db/CLAUDE.md 允许的「末尾追加数据回填」例外）。
--
-- ⚠ 执行方式：**必须** `npm --prefix db run db:migrate`（drizzle migrator 把整个文件包进单事务，
--   RAISE EXCEPTION 才能真正回滚已执行的 UPDATE，并发写入也被 ALTER 的 ACCESS EXCLUSIVE 天然排除）。
--   **禁止**用 `db/scripts/apply-pending-migrations.js` 跑本条：它按 statement-breakpoint 标记逐条
--   autocommit，会丢掉原子性，并在回填与并发写之间开出 lost update 窗口（旧代码把退款/折抵写进
--   picked_up，回填按旧快照覆盖 → 份额丢失 → 可重复退）。
--   （注意本行刻意不写出那个标记的完整字面量——drizzle 就是按它切分语句，写全会把注释从中间切开。）
--
-- ⚠ 部署顺序：本迁移**不向前也不向后兼容**，详见 docs/changes/ 对应变更文档。
--   正向：先迁 → 立即部署 staffApi / clientApi / admin 三端 → 跑 verify-quantity-split.js。
--   反向：**禁止代码回滚**（新列写过之后回滚代码，旧代码会把已退款/已折抵份额读回可提可退 → 资损），
--   只能 forward-fix。
--
-- #154：picked_up_quantity 三语义拆列的历史数据回填。
--
-- 编号说明：本条刻意跳号到 0043。test 与 dev 两线的 migration 编号自 0039 起已分叉
-- （两线的 0039/0040 同名不同内容，dev 另有 0041_bizarre_wolfpack / 0042_inventory_sku_supplier_fk），
-- 在 test 线取自然号 0041 会与 dev 的 0041 撞名。0043 是两线均未占用的号，
-- 将来双线合并时 dev 的 0041/0042 可干净插入。drizzle 的下一个号取「上一条 idx + 1」，
-- 跳号不会在后续产生空洞或二次冲突。
--
-- 回填口径：
--   picked_phys := SUM(pickup_records.pickup_quantity)                    — 物理提货，独立源
--   conv        := SUM(转出行 quantity WHERE 转换单 status <> '已关闭')     — 已转换，独立源
--   residual    := 旧 picked_up_quantity − picked_phys − conv
--     residual < 0                                  → 守恒破坏，RAISE EXCEPTION 回滚整个迁移（不静默 clamp）
--     residual > 0 且该行订单有已支付退款            → 计入 refunded_quantity
--     residual > 0、无退款、且该行**没有** pickup_records → 视为「历史提货未留记录」，留在 picked_up_quantity
--     residual > 0、无退款、但该行**有** pickup_records   → 无从解释的结算量，RAISE EXCEPTION
--
--   最后一类必须拦而不能并回 picked_up_quantity：并回去会让该行 picked_up > SUM(pickup_records)，
--   与本迁移事后断言 2 以及 cron STEP 12 的 C5 守恒判据直接冲突（断言当场 RAISE 把整条迁移打回，
--   或迁移侥幸通过后 C5 每日恒告警）。典型来源是「已删除转换单的转出行」——conv 聚合归 0 而
--   picked_up 仍被抬高。部署前跑 verify-quantity-split.js 可提前发现这类行。
--
-- 2026-09-18 实测：dev 14 行 / 17 件、prod 18 行 / 24 件，全部 picked_phys=0、conv=0 且订单均有已支付退款
-- （pickup_records 两库皆空、家居转出行尚无数据），即全量归入 refunded_quantity，0 行守恒破坏。
-- 规则仍按通用式写，以覆盖 PR 合入到实际部署之间可能新增的数据。
--
-- 未加 CHECK (picked_up + refunded + converted <= quantity)：ADD CONSTRAINT 会对 sale_items
-- （prod 12.6 万行）取 ACCESS EXCLUSIVE 并持有到事务提交，而本文件不允许在 drizzle 生成段之前
-- 插入 SET LOCAL lock_timeout。该不变量改由两道机制守护：各写入点 UPDATE 的 WHERE 守卫
-- （不满足则 rowCount=0 抛 CONFLICT），以及 cron STEP 12 的 C5b settled_quantity_overflow 巡检。
--
-- 前置守恒断言：residual < 0 说明「物理提货 + 已转换」已超过旧的已结算合计，属于回填口径无法
-- 安全消化的数据异常。必须在 UPDATE 之前拦截——放到事后查会被 CASE 的 ELSE 0 分支吞掉。
DO $$
DECLARE
  bad integer;
  sample text;
BEGIN
  WITH src AS (
    SELECT si.sale_item_id,
           COALESCE(si.picked_up_quantity, 0) AS old_settled,
           COALESCE((
             SELECT SUM(pr.pickup_quantity)::int
               FROM pickup_records pr
              WHERE pr.sale_item_id = si.sale_item_id
           ), 0) AS picked_phys,
           COALESCE((
             SELECT SUM(out_item.quantity)::int
               FROM sale_items out_item
               JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
              WHERE out_item.ref_sale_item_id = si.sale_item_id
                AND out_item.item_direction = '转出'
                AND out_item.product_type = '家居产品'
                AND conv_order.status <> '已关闭'
           ), 0) AS conv,
           EXISTS (
             SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id
           ) AS has_pickup_records,
           EXISTS (
             SELECT 1 FROM sale_order_payments sop
              WHERE sop.sale_order_id = si.sale_order_id
                AND sop.change_type = '退款'
                AND sop.status = '已支付'
           ) AS has_paid_refund
      FROM sale_items si
  )
  , broken AS (
    SELECT sale_item_id FROM src
     WHERE old_settled - picked_phys - conv < 0
        -- 有提货记录却仍有无法解释的结算量：并回 picked_up 会破坏「picked_up == SUM(pickup_records)」，
        -- 并回 refunded 又查无退款实据。两条路都不能走，只能拦下来让人查。
        OR (old_settled - picked_phys - conv > 0 AND NOT has_paid_refund AND has_pickup_records)
  )
  SELECT (SELECT COUNT(*) FROM broken),
         COALESCE((
           SELECT string_agg(sale_item_id, ', ' ORDER BY sale_item_id)
             FROM (SELECT sale_item_id FROM broken ORDER BY sale_item_id LIMIT 20) t
         ), '')
    INTO bad, sample;

  IF bad > 0 THEN
    RAISE EXCEPTION '#154 回填前守恒破坏：% 行的已结算量无法按口径拆分（picked_up < 物理提货+已转换，或有提货记录却存在无退款实据的残差），样例 [%]', bad, sample;
  END IF;
END $$;--> statement-breakpoint
WITH src AS (
  SELECT si.sale_item_id,
         COALESCE(si.picked_up_quantity, 0) AS old_settled,
         COALESCE((
           SELECT SUM(pr.pickup_quantity)::int
             FROM pickup_records pr
            WHERE pr.sale_item_id = si.sale_item_id
         ), 0) AS picked_phys,
         COALESCE((
           SELECT SUM(out_item.quantity)::int
             FROM sale_items out_item
             JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
            WHERE out_item.ref_sale_item_id = si.sale_item_id
              AND out_item.item_direction = '转出'
              AND out_item.product_type = '家居产品'
              AND conv_order.status <> '已关闭'
         ), 0) AS conv,
         EXISTS (
           SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id
         ) AS has_pickup_records,
         EXISTS (
           SELECT 1
             FROM sale_order_payments sop
            WHERE sop.sale_order_id = si.sale_order_id
              AND sop.change_type = '退款'
              AND sop.status = '已支付'
         ) AS has_paid_refund
    FROM sale_items si
   WHERE COALESCE(si.picked_up_quantity, 0) <> 0
      -- 兜住「picked_up 为 0 但另两类已有数据」的异常行：不纳入的话它们会带着默认 0 溜过回填。
      OR EXISTS (
        SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id
      )
      OR EXISTS (
        SELECT 1
          FROM sale_items out_item
          JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
         WHERE out_item.ref_sale_item_id = si.sale_item_id
           AND out_item.item_direction = '转出'
           AND out_item.product_type = '家居产品'
           AND conv_order.status <> '已关闭'
      )
), split AS (
  SELECT sale_item_id, picked_phys, conv, has_paid_refund, has_pickup_records,
         old_settled - picked_phys - conv AS residual
    FROM src
)
UPDATE sale_items si
   -- 「历史提货未留记录」的残差只在该行完全没有 pickup_records 时才并回本列；
   -- 有记录的行并回去就会破坏事后断言 2，那一类已在前置断言里被拦掉。
   SET picked_up_quantity = s.picked_phys
                            + CASE WHEN s.residual > 0 AND NOT s.has_paid_refund AND NOT s.has_pickup_records
                                   THEN s.residual ELSE 0 END,
       refunded_quantity  = CASE WHEN s.residual > 0 AND s.has_paid_refund THEN s.residual ELSE 0 END,
       converted_quantity = s.conv
  FROM split s
 WHERE si.sale_item_id = s.sale_item_id;--> statement-breakpoint
-- 事后断言 1：三列均非负，且合计不超过购买件数。
DO $$
DECLARE
  bad_negative integer;
  bad_overflow integer;
BEGIN
  SELECT COUNT(*) INTO bad_negative
    FROM sale_items
   WHERE COALESCE(picked_up_quantity, 0) < 0
      OR COALESCE(refunded_quantity, 0) < 0
      OR COALESCE(converted_quantity, 0) < 0;

  SELECT COUNT(*) INTO bad_overflow
    FROM sale_items
   WHERE COALESCE(picked_up_quantity, 0)
       + COALESCE(refunded_quantity, 0)
       + COALESCE(converted_quantity, 0) > quantity;

  IF bad_negative > 0 THEN
    RAISE EXCEPTION '#154 回填后守恒破坏：% 行数量列为负', bad_negative;
  END IF;

  IF bad_overflow > 0 THEN
    RAISE EXCEPTION '#154 回填后守恒破坏：% 行 picked_up + refunded + converted > quantity', bad_overflow;
  END IF;
END $$;--> statement-breakpoint
-- 事后断言 2（AC4 不变量）：有提货记录的行，picked_up_quantity 必须等于 pickup_records 合计。
-- 「无 pickup_records 的历史提货」行按口径留在 picked_up_quantity，不参与本断言。
DO $$
DECLARE
  mismatch integer;
BEGIN
  SELECT COUNT(*) INTO mismatch
    FROM sale_items si
   WHERE EXISTS (SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id)
     AND COALESCE(si.picked_up_quantity, 0) <> COALESCE((
           SELECT SUM(pr.pickup_quantity)::int
             FROM pickup_records pr
            WHERE pr.sale_item_id = si.sale_item_id
         ), 0);

  IF mismatch > 0 THEN
    RAISE EXCEPTION '#154 回填后 picked_up_quantity 与 pickup_records 不一致：% 行', mismatch;
  END IF;
END $$;
