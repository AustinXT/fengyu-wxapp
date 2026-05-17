-- ============================================================================
-- 应急同步脚本：把 5434/5433 推到 migration 0026_harsh_fantastic_four 后的状态
-- ============================================================================
-- 背景：
--   - db/schema/coupon.ts 在 userCoupons 表新增 updatedAt 字段（与 refund-cascade.ts:127
--     等代码路径里已有的 `UPDATE user_coupons SET updated_at = NOW()` SQL 对齐）。
--   - 两库（5434/fengyu + 5433/fengyu_wxapp）此前已通过手工热补丁直接 ALTER TABLE
--     加上 `user_coupons.updated_at`，drizzle-kit 生成的 0026 直接 apply 会 42701
--     "column already exists" 报错。
--   - 此脚本将 0026 重写为 idempotent 形式（ADD COLUMN IF NOT EXISTS），并补登 journal
--     （folderMillis 直接取自 db/migrations/meta/_journal.json idx=26）。
-- 跑法（两库都跑同一脚本）：
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu        -f db/scripts/manual-apply-0026.sql
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp  -f db/scripts/manual-apply-0026.sql
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0026.1 ADD COLUMN user_coupons.updated_at（IF NOT EXISTS 兼容已热补丁的两库）
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_coupons ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now() NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- journal 补登（folderMillis = 1778990957890，取自 _journal.json idx=26）
-- 使用 NOT EXISTS 兼容热补丁后已 apply / 未 apply 两种状态
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT v.hash, v.ts
FROM (VALUES
  ('0026_harsh_fantastic_four', 1778990957890::bigint)
) AS v(hash, ts)
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations m
   WHERE m.created_at = v.ts
);

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 验证
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== user_coupons.updated_at 应存在 ==='
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'user_coupons' AND column_name = 'updated_at';

\echo '=== 最新 3 条 journal（应顶部为 0026_harsh_fantastic_four）==='
SELECT hash, created_at FROM drizzle.__drizzle_migrations
ORDER BY created_at DESC LIMIT 3;
