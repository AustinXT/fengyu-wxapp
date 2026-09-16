-- ⚠ 历史脚本（已执行完毕）：下文的 47.113.202.7 / 5434 是当时的旧拓扑，保留原文以还原语境。
--   该机已于 2026-09-01 全面弃用，当前拓扑见 db/CLAUDE.md，**不要照抄下面的连接串**。
-- ============================================================================
-- 应急同步脚本：把 5434/5433 推到 migration 0025_drop_sale_orders_refund_columns 后的状态
-- ============================================================================
-- 背景：
--   - db/schema/order.ts 已删除 sale_orders 表 7 个退款专用列：
--     refund_reason / handling_fee / approved_by / approved_at / rejected_reason /
--     overdraft_deduction / overdraft_deduction_detail
--   - 5434 实际 FK 名为 PG 默认 `sale_orders_approved_by_fkey`（历史 drift）；
--     drizzle-kit 生成的 0025 SQL 用 drizzle 命名约定 `sale_orders_approved_by_staff_wechat_users_employee_id_fk`，
--     直接 apply 会 42704 报错。
--   - 5433 落后一版（缺 0024_cleanup_commission_rate），但 0024 与 0025 在 db:migrate
--     的单事务里会绑定回滚，故必须用本脚本一次性处理。
--   - 此脚本将 0024 + 0025 重写为 idempotent 形式，FK drop 使用 information_schema 查询
--     兼容两种 FK 命名；列 drop 用 IF EXISTS；并补登 journal（folderMillis 直接取 _journal.json）。
-- 跑法（两库都跑同一脚本）：
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu        -f db/scripts/manual-apply-0025.sql
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp  -f db/scripts/manual-apply-0025.sql
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0024_cleanup_commission_rate（idempotent；5434 已 apply，5433 缺）
-- ────────────────────────────────────────────────────────────────────────────

-- 0024.1 清洗（5434 是 no-op；5433 一并归零）
UPDATE service_commissions
SET commission_rate   = 0,
    consume_amount    = 0,
    commission_amount = fixed_fee
WHERE commission_rate < 0 OR commission_rate > 1;

-- 0024.2 ADD CONSTRAINT（IF NOT EXISTS）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_svc_comm_commission_rate'
       AND conrelid = 'service_commissions'::regclass
  ) THEN
    ALTER TABLE service_commissions
      ADD CONSTRAINT chk_svc_comm_commission_rate
      CHECK (commission_rate >= 0 AND commission_rate <= 1);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 0025_drop_sale_orders_refund_columns
-- ────────────────────────────────────────────────────────────────────────────

-- 0025.1 DROP approved_by 上的任意 FK（覆盖 drizzle 命名约定 + PG 默认名 + 任何其他变体）
DO $$
DECLARE
  fk_name text;
BEGIN
  FOR fk_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'sale_orders'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%(approved_by)%'
  LOOP
    EXECUTE format('ALTER TABLE sale_orders DROP CONSTRAINT %I', fk_name);
  END LOOP;
END $$;

-- 0025.2 DROP 7 个死列
ALTER TABLE sale_orders DROP COLUMN IF EXISTS refund_reason;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS handling_fee;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS approved_by;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS approved_at;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS rejected_reason;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS overdraft_deduction;
ALTER TABLE sale_orders DROP COLUMN IF EXISTS overdraft_deduction_detail;

-- ────────────────────────────────────────────────────────────────────────────
-- journal 补登（folderMillis 直接取自 db/migrations/meta/_journal.json）
--   - 0024 folderMillis = 1778984420841
--   - 0025 folderMillis = 1778987524333
-- 使用 NOT EXISTS 兼容 5434（0024 已注册）+ 5433（两个都缺）
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT v.hash, v.ts
FROM (VALUES
  ('0024_cleanup_commission_rate',           1778984420841::bigint),
  ('0025_drop_sale_orders_refund_columns',   1778987524333::bigint)
) AS v(hash, ts)
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations m
   WHERE m.created_at = v.ts
);

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 验证
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== sale_orders 残留退款列（应为 0 行）==='
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'sale_orders'
  AND column_name IN ('refund_reason','handling_fee','approved_by','approved_at',
                      'rejected_reason','overdraft_deduction','overdraft_deduction_detail');

\echo '=== approved_by 残留 FK（应为 0 行）==='
SELECT conname
FROM pg_constraint
WHERE conrelid = 'sale_orders'::regclass
  AND pg_get_constraintdef(oid) LIKE '%(approved_by)%';

\echo '=== chk_svc_comm_commission_rate（应 1 行）==='
SELECT conname FROM pg_constraint
WHERE conname = 'chk_svc_comm_commission_rate';

\echo '=== 最新 5 条 journal（应包含 0024/0025 时间戳）==='
SELECT hash, created_at FROM drizzle.__drizzle_migrations
ORDER BY created_at DESC LIMIT 5;
