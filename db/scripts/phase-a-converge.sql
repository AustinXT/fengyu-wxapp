-- Phase A convergence — 2026-04-10
-- 最后一次 psql 手动 apply，之后禁止。修复 prod drift 使其与 db/schema/*.ts 语义一致。
--
-- 注：0018_green_rogue.sql 的 service_fee/fixed_fee/consume_amount 列
-- 已由用户在另一个窗口手动 apply 完成，不在此脚本中处理。
-- 本脚本只剩 4 项 drift 修复：
--   (1) DROP sale_items_backup_20260410 (用户 apply 0018 前的备份表，已完成使命)
--   (2) DROP service_commissions_backup_20260410 (同上)
--   (3) DROP client_wechat_users.category (22875 行数据接受丢失)
--   (4) product_kind: 福利活动 → 护理项目 + CREATE TYPE + ALTER 列类型
--
-- 已决定作为 cosmetic drift 忽略（不在本脚本处理）：
--   - staff_wechat_users_employee_id_unique 冗余 UQ (15 FK 依赖，CASCADE 风险过高)
--   - FK 命名差异（prod 用 postgres 默认 _fkey，schema.ts 用 drizzle 长名，语义相同）
--   - uq_org_nodes_parent_name 列顺序（语义相同）
--   - 所有 index 的 opclass 标注（postgres 自动加的默认 text_ops/timestamp_ops/enum_ops）

BEGIN;

-- ==========================================================
-- Part 1 — 结构性变更
-- ==========================================================

-- 1.1 DROP 用户做 0018 apply 前的备份表
DROP TABLE IF EXISTS public.sale_items_backup_20260410;
DROP TABLE IF EXISTS public.service_commissions_backup_20260410;

-- 1.2 DROP client_wechat_users.category (老的 A/B/C/D/E 分级，已被 customer_type 等替代)
ALTER TABLE client_wechat_users DROP COLUMN category;

-- 1.3 把 '福利活动' 合并到 '护理项目'（4 行）
UPDATE product_categories SET product_kind = '护理项目' WHERE product_kind = '福利活动';

-- 1.4 创建 product_kind 枚举类型
CREATE TYPE public.product_kind AS ENUM ('护理项目', '家居产品', '充值卡', '体验卡');

-- 1.5 ALTER product_categories.product_kind 从 text 改为 enum
ALTER TABLE product_categories
  ALTER COLUMN product_kind SET DATA TYPE public.product_kind
  USING product_kind::public.product_kind;

-- ==========================================================
-- Part 2 — 事务内校验（肉眼检查输出）
-- ==========================================================

-- 2.1 备份表已不存在
SELECT 'sale_items_backup_20260410' AS table_name,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_name='sale_items_backup_20260410')
            THEN 'STILL EXISTS (BUG)' ELSE 'DROPPED (OK)' END AS status
UNION ALL
SELECT 'service_commissions_backup_20260410',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_name='service_commissions_backup_20260410')
            THEN 'STILL EXISTS (BUG)' ELSE 'DROPPED (OK)' END;

-- 2.2 category 列已不存在
SELECT 'client_wechat_users.category' AS col_name,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name='client_wechat_users' AND column_name='category')
            THEN 'STILL EXISTS (BUG)' ELSE 'DROPPED (OK)' END AS status;

-- 2.3 product_kind 列已是 enum 类型
SELECT 'product_categories.product_kind' AS col_name,
       (SELECT data_type FROM information_schema.columns
        WHERE table_name='product_categories' AND column_name='product_kind') AS data_type,
       (SELECT udt_name FROM information_schema.columns
        WHERE table_name='product_categories' AND column_name='product_kind') AS udt_name;

-- 2.4 product_categories.product_kind 分布（应该只有 4 个合法值 + NULL）
SELECT 'product_kind' AS col,
       COALESCE(product_kind::text, 'NULL') AS value, COUNT(*) AS cnt
FROM product_categories GROUP BY product_kind ORDER BY 2;

-- 2.5 product_kind 枚举类型已创建
SELECT 'pg_type product_kind' AS item,
       (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid
        WHERE t.typname='product_kind' ORDER BY enumsortorder LIMIT 1) AS first_value,
       (SELECT COUNT(*) FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid
        WHERE t.typname='product_kind') AS total_values;

-- ==========================================================
-- DRY-RUN / COMMIT 开关
-- ==========================================================
-- 2026-04-10: dry-run 全部 OK，用户授权 COMMIT
-- ROLLBACK;
COMMIT;
