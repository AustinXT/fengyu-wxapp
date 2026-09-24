ALTER TABLE "sale_items" ADD COLUMN "refunded_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "converted_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_sale_item_settled_le_quantity" CHECK ((COALESCE("sale_items"."picked_up_quantity", 0) + "sale_items"."refunded_quantity" + "sale_items"."converted_quantity") <= "sale_items"."quantity");--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_sale_item_quantities_non_negative" CHECK (COALESCE("sale_items"."picked_up_quantity", 0) >= 0 AND "sale_items"."refunded_quantity" >= 0 AND "sale_items"."converted_quantity" >= 0);--> statement-breakpoint
-- ↑ 以上为 drizzle-kit 生成；以下为手写回填（db/CLAUDE.md 允许的「末尾追加数据回填」例外）。
--
-- ⚠ 执行方式：**必须** `npm --prefix db run db:migrate`（drizzle migrator 把整个文件包进单事务，
--   RAISE EXCEPTION 才能真正回滚已执行的 UPDATE；ALTER 取的 ACCESS EXCLUSIVE 也让回填期间
--   不可能有并发写入 sale_items）。
--   **禁止**用 `db/scripts/apply-pending-migrations.js` 跑本条：它按 statement-breakpoint 标记逐条
--   autocommit，会丢掉原子性，并在回填与并发写之间开出 lost update 窗口。
--   （注意本行刻意不写出那个标记的完整字面量——drizzle 就是按它切分语句，写全会把注释从中间切开。）
--
-- ⚠ 部署顺序：本迁移**不向前也不向后兼容**，runbook 见 docs/changes/arch/012。
--
-- #154：picked_up_quantity 三语义拆列的历史数据回填。
--
-- ⚠ 编号沿革（2026-09-21，PR #204 test→main 合并）：本条在 test 线上曾是 0043
--   （when=1789786018613）。合并时 dev 线已占用 0043/0044/0045，且 dev 库的
--   `max(created_at)` 已经是 0044_wooden_human_torch 的 1789790016262 —— 比旧 when 更大。
--   drizzle migrator 判「已应用」只比 when（`lastDbMigration.created_at < migration.folderMillis`，
--   见 drizzle-orm/pg-core/dialect.cjs），**不比 hash**，沿用旧 when 会让 dev 库**永久静默跳过**
--   本条、缺两列。故改号到 0046 并把 when 抬到 0045 之后（1789965866652）。
--
-- ⚠ 本条**刻意保持非幂等**（与相邻的 0047 相反）：下方回填是破坏性的——重跑会把已拆出的
--   refunded_quantity 按新的 old_settled 重算成 0。因此「误重跑」必须是**显式失败**而不是
--   静默数据损坏：首条 `ADD COLUMN`（不带 IF NOT EXISTS）会抛 42701 让整个事务回滚停住。
--   若某个库已按旧 when 应用过本条（dev / prod 两库 2026-09-21 实测均未应用），
--   正确处置是重建该库或手工补 `drizzle.__drizzle_migrations` 记录，**不要**把本文件改成幂等。
--
-- 回填口径：
--   picked_phys := SUM(pickup_records.pickup_quantity)                    — 物理提货，独立源
--   conv        := SUM(转出行 quantity WHERE 转换单 status <> '已关闭')     — 已转换，独立源
--   residual    := 旧 picked_up_quantity − picked_phys − conv
--
--   residual < 0                → RAISE（物理提货 + 已转换 超过旧的已结算合计）
--   residual > 0 且**有退款实据** → refunded_quantity
--   residual > 0 且无退款实据    → RAISE（无从解释的结算量）
--
-- 「退款实据」必须能落到**本行**，不能只看订单上有没有退款（双谱系评审命中）：
--   ① sale_order_payments.ref_sale_item_id 直接指向本行的已支付退款；或
--   ② 该退款的 note.items 里出现本行；或
--   ③ 整单已退款（status='已退款'）—— 整单退时每个购买行都被退，归因必然正确。
-- 只用订单级 EXISTS 会把「同单**他行**退款 + 本行是无记录的历史提货」错记成退款：
-- 「已消耗」口径刻意不含 refunded，错记会让 overpay 余数虚高 → 多退。
--
-- 回填后 picked_up_quantity 恒等于 SUM(pickup_records)，**没有任何豁免行** ——
-- 初版留过一条「无退款残差视为历史提货未留记录、留在 picked_up」的口子，它会让 AC4 不成立、
-- 并迫使 cron C5 永久豁免这类行（评审指出那等于给巡检开了个正对着删提货记录逻辑的盲区）。
-- 2026-09-18 实测：按本规则 dev / prod 被阻断行数均为 0。
--
-- 2026-09-18 实测：dev 14 行 / 17 件、prod 18 行 / 24 件，全部 picked_phys=0、conv=0
-- 且订单 status 均为「已退款」，即全量归入 refunded_quantity，0 行守恒破坏。
-- 前置审计：note 守门用的是四端约定的 `LIKE '{%'`（不带 btrim，理由见下方注释）。
-- 带前导空格的 JSON note 会被守门漏判 → 该笔退款不计入实据 → 残差无处安放。
-- 实测 prod 235 条退款 note 0 条带前导空格，但「实测」与「迁移执行」之间仍可能写入新数据。
-- 这里不改守门写法（那会造成副本漂移），只把「静默漏判」变成显式失败。
DO $$
DECLARE
  leading_space integer;
BEGIN
  SELECT COUNT(*) INTO leading_space
    FROM sale_order_payments
   WHERE change_type = '退款'
     AND status = '已支付'
     AND note ~ '^\s+\{';

  IF leading_space > 0 THEN
    RAISE EXCEPTION '#154 有 % 条已支付退款的 note 是带前导空格的 JSON —— 四端守门写法（note LIKE ''{%%''）认不出它们，退款实据会漏判。请先清理这些 note 的前导空格再迁移', leading_space;
  END IF;
END $$;--> statement-breakpoint
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
           (
             o.status = '已退款'
             OR EXISTS (
               SELECT 1 FROM sale_order_payments sop
                WHERE sop.sale_order_id = si.sale_order_id
                  AND sop.change_type = '退款'
                  AND sop.status = '已支付'
                  AND sop.ref_sale_item_id = si.sale_item_id
             )
             OR EXISTS (
               SELECT 1
                 FROM sale_order_payments sop
                 CROSS JOIN LATERAL jsonb_array_elements(
                   -- ⚠ 刻意与全仓 note→jsonb 守门写法字面一致（四端 14 处同款，由
                   -- cross-end-sql-snapshot.test.js 的「四端 note→jsonb 守门」一项守护）：
                   -- 外层 LIKE '{%' 纯文本守门 + 嵌套 CASE 让 ::jsonb cast 只在守门通过时求值。
                   -- 评审建议过改 btrim(note) 以兜住前导空格，**不采纳**：那会让这两处单独偏离
                   -- 四端约定（本仓最高频的 P1 源就是副本漂移），而实测 prod 235 条退款 note
                   -- 全部合法且 0 条带前导空格。要改就四端一起改，属独立课题。
                   CASE WHEN sop.note LIKE '{%'
                        THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                                  THEN (sop.note)::jsonb -> 'items'
                                  ELSE '[]'::jsonb END
                        ELSE '[]'::jsonb END
                 ) AS elem
                WHERE sop.sale_order_id = si.sale_order_id
                  AND sop.change_type = '退款'
                  AND sop.status = '已支付'
                  AND elem ->> 'refSaleItemId' = si.sale_item_id
             )
           ) AS has_item_refund_evidence
      FROM sale_items si
      JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
     WHERE COALESCE(si.picked_up_quantity, 0) <> 0
        OR EXISTS (SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id)
        OR EXISTS (
             SELECT 1
               FROM sale_items out_item
               JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
              WHERE out_item.ref_sale_item_id = si.sale_item_id
                AND out_item.item_direction = '转出'
                AND out_item.product_type = '家居产品'
                AND conv_order.status <> '已关闭'
           )
  ), broken AS (
    SELECT sale_item_id FROM src
     WHERE old_settled - picked_phys - conv < 0
        OR (old_settled - picked_phys - conv > 0 AND NOT has_item_refund_evidence)
  )
  SELECT (SELECT COUNT(*) FROM broken),
         COALESCE((
           SELECT string_agg(sale_item_id, ', ' ORDER BY sale_item_id)
             FROM (SELECT sale_item_id FROM broken ORDER BY sale_item_id LIMIT 20) t
         ), '')
    INTO bad, sample;

  IF bad > 0 THEN
    RAISE EXCEPTION '#154 回填口径无法拆分 % 行的已结算量（picked_up < 物理提货+已转换，或残差查无本行退款实据），样例 [%]', bad, sample;
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
         ), 0) AS conv
    FROM sale_items si
   -- 与上方前置断言的取行范围字面同口径
   WHERE COALESCE(si.picked_up_quantity, 0) <> 0
      OR EXISTS (SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = si.sale_item_id)
      OR EXISTS (
           SELECT 1
             FROM sale_items out_item
             JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
            WHERE out_item.ref_sale_item_id = si.sale_item_id
              AND out_item.item_direction = '转出'
              AND out_item.product_type = '家居产品'
              AND conv_order.status <> '已关闭'
         )
)
UPDATE sale_items si
   -- 前置断言已保证：残差要么为 0，要么有本行退款实据。故这里无条件归入 refunded_quantity，
   -- picked_up_quantity 无条件回归物理提货量 —— 没有任何豁免分支。
   SET picked_up_quantity = s.picked_phys,
       refunded_quantity  = GREATEST(0, s.old_settled - s.picked_phys - s.conv),
       converted_quantity = s.conv
  FROM src s
 WHERE si.sale_item_id = s.sale_item_id;--> statement-breakpoint
-- 事后断言（AC4，**全量无豁免**）：picked_up_quantity 必须等于 pickup_records 合计。
-- 三列非负与「已结算 <= quantity」已由上方两条 CHECK 约束保证，不再重复断言。
DO $$
DECLARE
  mismatch integer;
BEGIN
  SELECT COUNT(*) INTO mismatch
    FROM sale_items si
    LEFT JOIN (
           SELECT sale_item_id, SUM(pickup_quantity)::int AS total_picked
             FROM pickup_records
            GROUP BY sale_item_id
         ) p ON p.sale_item_id = si.sale_item_id
   WHERE COALESCE(si.picked_up_quantity, 0) <> COALESCE(p.total_picked, 0);

  IF mismatch > 0 THEN
    RAISE EXCEPTION '#154 回填后 picked_up_quantity 与 pickup_records 不一致：% 行', mismatch;
  END IF;
END $$;
