-- ============================================================================
-- 应急同步脚本：把 5433/5434 推到 migration 0023_keen_freak 后的状态
-- ============================================================================
-- 背景：
--   - db/schema/order.ts 把 sale_order_payments 定义为 18 列（合并 sopd 回主表）
--   - 5434 实际 10 列（journal tip = 0022_petite_beast，缺 0023）
--   - 5433 实际 10 列（journal tip = baseline 老 hex，缺 0021/0022/0023）
--   - migration 0023_keen_freak.sql 直接 apply 会因 5434 已有约束重名 / 数据违例 / sopd 列已 dropped 等原因失败
--   - 此脚本将 0023 重写为 idempotent 形式，并补登 journal
--   - 配套数据清洗（已外部执行）：DELETE service_commissions WHERE commission_rate > 1;
--                                  DELETE sale_allocations WHERE allocation_ratio NOT IN (0.10..1.00) on 5433
-- 跑法（两库都跑同一脚本）：
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu        -f db/scripts/manual-apply-0023.sql
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp  -f db/scripts/manual-apply-0023.sql
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. sale_order_payments ADD 8 COLUMN（IF NOT EXISTS 保证幂等）
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS operator_employee_id varchar(30);
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS note                 text;
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS refund_reason        text;
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS ref_sale_item_id     varchar(30);
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS session_count        integer;
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS audit_employee_id    varchar(30);
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS audit_at             timestamp;
ALTER TABLE sale_order_payments ADD COLUMN IF NOT EXISTS audit_remark         text;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. sopd 子表数据回填（仅当子表存在）
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_order_payment_details') THEN
    UPDATE sale_order_payments sop
    SET operator_employee_id = sopd.operator_employee_id,
        note                 = sopd.note,
        refund_reason        = sopd.refund_reason,
        ref_sale_item_id     = sopd.ref_sale_item_id,
        session_count        = sopd.session_count,
        audit_employee_id    = sopd.audit_employee_id,
        audit_at             = sopd.audit_at,
        audit_remark         = sopd.audit_remark
    FROM sale_order_payment_details sopd
    WHERE sopd.payment_id = sop.id;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. 3 个 FK（条件添加避免重名）
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk') THEN
    ALTER TABLE sale_order_payments
      ADD CONSTRAINT sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk
      FOREIGN KEY (operator_employee_id) REFERENCES staff_wechat_users(employee_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='sale_order_payments_ref_sale_item_id_sale_items_sale_item_id_fk') THEN
    ALTER TABLE sale_order_payments
      ADD CONSTRAINT sale_order_payments_ref_sale_item_id_sale_items_sale_item_id_fk
      FOREIGN KEY (ref_sale_item_id) REFERENCES sale_items(sale_item_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='sale_order_payments_audit_employee_id_staff_wechat_users_employee_id_fk') THEN
    ALTER TABLE sale_order_payments
      ADD CONSTRAINT sale_order_payments_audit_employee_id_staff_wechat_users_employee_id_fk
      FOREIGN KEY (audit_employee_id) REFERENCES staff_wechat_users(employee_id);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. DROP sopd 子表（CASCADE 一并清掉其 PK/FK/索引）
-- ────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS sale_order_payment_details CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. 当前 schema 想要的 3 个 CHECK 约束（跳过 commission_rate，schema TODO 故意不要）
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_sale_alloc_ratio') THEN
    ALTER TABLE sale_allocations
      ADD CONSTRAINT chk_sale_alloc_ratio
      CHECK (allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_svc_comm_commission_amount') THEN
    ALTER TABLE service_commissions
      ADD CONSTRAINT chk_svc_comm_commission_amount
      CHECK (commission_amount >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_svc_comm_alloc_ratio') THEN
    ALTER TABLE service_commissions
      ADD CONSTRAINT chk_svc_comm_alloc_ratio
      CHECK (allocation_ratio IS NULL OR allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. journal 补登 0021/0022/0023（hash 无 unique 索引，用 WHERE NOT EXISTS）
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT v.hash, v.ts
FROM (VALUES
  ('0021_brief_santa_claus',  (EXTRACT(EPOCH FROM NOW())::bigint) * 1000),
  ('0022_petite_beast',       (EXTRACT(EPOCH FROM NOW())::bigint) * 1000 + 1),
  ('0023_keen_freak',         (EXTRACT(EPOCH FROM NOW())::bigint) * 1000 + 2)
) AS v(hash, ts)
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations m WHERE m.hash = v.hash
);

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 验证（脚本内打印）
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== sale_order_payments 列数 ==='
SELECT count(*) AS col_count
FROM information_schema.columns
WHERE table_name='sale_order_payments';

\echo '=== sopd 是否已 DROP ==='
SELECT count(*) AS sopd_table_exists
FROM information_schema.tables
WHERE table_name='sale_order_payment_details';

\echo '=== 最新 5 条 journal ==='
SELECT hash, created_at FROM drizzle.__drizzle_migrations
ORDER BY created_at DESC LIMIT 5;
