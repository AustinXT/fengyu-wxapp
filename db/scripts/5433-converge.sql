-- 5433-converge.sql — 2026-04-10 follow-up 的 5433 drift 修复【delta DDL】
--
-- 目标：把 47.113.202.7:5433/fengyu_wxapp（开发库，云函数用）对齐到
-- db/schema/*.ts 权威状态，使之与 5434/fengyu（测试库）同步。
--
-- 这是 db/CLAUDE.md "禁止 psql 手动 apply" 规则的明示例外，
-- 与 phase-a-converge.sql 同等级别。执行一次后永不再用。
--
-- 执行方式：
--   1. 先跑 db/scripts/5433-drift-survey.sql 并 review 输出
--   2. 在 docker 临时库（54399）预演通过
--   3. 对 5433 做 pg_dump 全量备份
--   4. psql 5433 -f 本文件（默认 ROLLBACK，拿 Part 9 校验输出）
--   5. Review Part 9 → 注释 ROLLBACK / 解开 COMMIT → 再跑一次真实 COMMIT
--
-- 迁移逻辑参考（均来自归档）：
--   - Part 2: _archive_pre_baseline_2026_04/manual-applied/0011_merge_customer_points_into_client_users.sql
--   - Part 4: _archive_pre_baseline_2026_04/sql/0032_drop_member_levels_and_relax_oplog.sql
--   - Part 5: db/scripts/phase-a-converge.sql 1.3-1.5（但 5433 特殊：enum 已存在，见 Part 5 注释）
--   - Part 6: _archive_pre_baseline_2026_04/sql/0030_split_sale_order_type.sql
--
-- 2026-04-10 阶段 1 侦查结论（来自 5433-drift-survey.sql 执行结果）：
--   - 备份表 sale_items_backup_20260410 / service_commissions_backup_20260410
--     行数 + 时间范围 = 现役表，列数少 1-2（旧 schema 的 ADD COLUMN 前快照）→ 纯冗余，DROP
--   - customer_points / member_levels：都 0 行，DROP 零损失，Part 2.2 UPDATE 是 no-op
--   - client_wechat_users.category：22875 行 A/B/C/D/E 有分级数据（与 5434 数值一致，用户已授权丢失）
--   - sale_orders.sale_order_type：仅 {普通,体验,内部} 3 个值，Part 6 CASE WHEN 全覆盖
--   - product_categories.product_kind：text 列，4 行「福利活动」、1 行「体验卡」、5 行 NULL
--   - product_kind enum：已存在但零依赖零引用，需先 DROP 再 CREATE（Part 5 逻辑）
--   - service_items.is_presale：851621 行全为 false，DROP 零损失
--   - point_transaction_type：零列引用零 pg_depend 依赖，DROP 安全
--   - operation_logs：165 行零 NULL，放宽约束零影响
--   - 活跃连接数：0（执行前不必等低峰期）

BEGIN;

-- ================================================================
-- Part 1 — Table-level cleanup
-- ================================================================
-- 先 DROP 备份表，避免后面的 enum 重建扫到它们的列

-- 1.1 DROP 可疑备份表（前提：阶段 1 侦查确认无保留价值）
DROP TABLE IF EXISTS public.sale_items_backup_20260410;
DROP TABLE IF EXISTS public.service_commissions_backup_20260410;

-- ================================================================
-- Part 2 — Points 域合并（移植自 manual-applied/0011）
-- ================================================================

-- 2.1 client_wechat_users 新增积分余额列 + 会员跳档时间
ALTER TABLE client_wechat_users
  ADD COLUMN IF NOT EXISTS points_balance    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_updated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS became_member_at  TIMESTAMPTZ;

-- 2.2 把 customer_points 的余额迁移进 client_wechat_users
--    假设 customer_points 列：user_id / balance / updated_at
--    （阶段 1 侦查第 5 项已确认 schema）
UPDATE client_wechat_users cwu
SET points_balance    = cp.balance,
    points_updated_at = cp.updated_at
FROM customer_points cp
WHERE cwu.user_id = cp.user_id;

-- 2.3 DROP customer_points 表
--    归档的 0032 里先 DROP 掉 level_id FK，但 5433 没跑过 0032，
--    所以 customer_points.level_id FK（如存在）会随表一起消失，无需单独处理
DROP TABLE IF EXISTS customer_points;

-- 2.4 DROP member_levels 表（死表 B 体系，会员等级已由
--     client_wechat_users.member_level 枚举列单独维护）
DROP TABLE IF EXISTS member_levels;

-- ================================================================
-- Part 3 — client_wechat_users.category 删除（接受数据丢失）
-- ================================================================
-- 老的 A/B/C/D/E 分级，已被 member_level / customer_type 等替代
-- 5434 那次 DROP 损失了 22875 行；5433 的规模由阶段 1 侦查第 4 项确认

ALTER TABLE client_wechat_users DROP COLUMN IF EXISTS category;

-- ================================================================
-- Part 4 — operation_logs 放宽（移植自 0032）
-- ================================================================
-- 支持 cronTask / payNotify webhook 等无操作人场景写入系统级日志

ALTER TABLE operation_logs ALTER COLUMN operator_employee_id DROP NOT NULL;
ALTER TABLE operation_logs ALTER COLUMN operator_name        DROP NOT NULL;

-- ================================================================
-- Part 5 — product_kind enum（5433 特殊情况：enum 存在但列是 text）
-- ================================================================
-- 侦查发现（2026-04-10）：
--   - product_kind enum 类型在 5433 **已存在**，当前值集 {福利活动,护理项目,家居产品,充值卡}
--     （错误：应该含「体验卡」不含「福利活动」）
--   - product_categories.product_kind 列是 **text**，没有使用这个 enum
--   - 该 enum 零列引用 + 零 pg_depend 依赖（pg_depend 和 information_schema 双重确认）
--   - 所以可以安全 DROP TYPE 后重建
--
-- 与 phase-a-converge.sql 1.3-1.5 的差异：phase-a 当时 5434 没有 product_kind type，
-- 直接 CREATE 即可；5433 这里必须先 DROP TYPE 再 CREATE。

-- 5.1 合并列里的 '福利活动' → '护理项目'（侦查确认 4 行；列是 text 无 enum 约束）
UPDATE product_categories SET product_kind = '护理项目' WHERE product_kind = '福利活动';

-- 5.2 DROP 旧 enum 类型（零依赖，5433 特有的 clean-up）
DROP TYPE public.product_kind;

-- 5.3 重建 enum 为权威 4 值（含「体验卡」不含「福利活动」）
CREATE TYPE public.product_kind AS ENUM ('护理项目', '家居产品', '充值卡', '体验卡');

-- 5.4 列类型转换（NULL 值自动保持 NULL，侦查确认 5 行 NULL 非空串）
ALTER TABLE product_categories
  ALTER COLUMN product_kind TYPE public.product_kind
  USING product_kind::public.product_kind;

-- ================================================================
-- Part 6 — sale_order_type 7 值 → 5 值（移植自 0030）
-- ================================================================
-- 旧值：普通/体验/内部/组合套餐/回款/转换/退款
-- 新值：销售单/内部单/回款单/转换单/退款单
-- CASE WHEN 映射兼容 DB 中可能存在的 '福利活动'

CREATE TYPE public.sale_order_type_new AS ENUM('销售单', '内部单', '回款单', '转换单', '退款单');

ALTER TABLE sale_orders
  ALTER COLUMN sale_order_type DROP DEFAULT;

ALTER TABLE sale_orders
  ALTER COLUMN sale_order_type TYPE public.sale_order_type_new
  USING (
    CASE sale_order_type::text
      WHEN '普通'      THEN '销售单'
      WHEN '体验'      THEN '销售单'
      WHEN '组合套餐'  THEN '销售单'
      WHEN '福利活动'  THEN '销售单'
      WHEN '内部'      THEN '内部单'
      WHEN '回款'      THEN '回款单'
      WHEN '转换'      THEN '转换单'
      WHEN '退款'      THEN '退款单'
    END
  )::public.sale_order_type_new;

DROP TYPE public.sale_order_type;
ALTER TYPE public.sale_order_type_new RENAME TO sale_order_type;

ALTER TABLE sale_orders
  ALTER COLUMN sale_order_type SET DEFAULT '销售单'::public.sale_order_type;
ALTER TABLE sale_orders
  ALTER COLUMN sale_order_type SET NOT NULL;

-- ================================================================
-- Part 7 — service_items.is_presale DROP
-- ================================================================
-- 运行时代码零引用（已在 cloudfunctions/**, fengyu-admin/src/**,
-- fengyu-client/miniprogram/**, fengyu-staff/miniprogram/** 全量 grep 确认）
-- 该列由 0014 引入，后续随体验单概念的收敛已在 schema.ts 移除

ALTER TABLE service_items DROP COLUMN IF EXISTS is_presale;

-- ================================================================
-- Part 8 — point_transaction_type enum DROP（条件性）
-- ================================================================
-- 前提：阶段 1 侦查第 8 项返回 0 行（无列引用）
-- 若有列引用，需先改列类型再 DROP，或注释掉本 Part 后续处理

DROP TYPE IF EXISTS public.point_transaction_type;

-- ================================================================
-- Part 9 — 事务内校验（肉眼 review Part 9 输出后决定 COMMIT/ROLLBACK）
-- ================================================================

-- 9.1 备份表已不存在
SELECT 'backup tables' AS item,
       CASE WHEN to_regclass('public.sale_items_backup_20260410') IS NULL
             AND to_regclass('public.service_commissions_backup_20260410') IS NULL
            THEN 'DROPPED (OK)' ELSE 'STILL EXISTS (BUG)' END AS status;

-- 9.2 customer_points / member_levels 表已不存在
SELECT 'customer_points' AS tbl, to_regclass('public.customer_points') IS NULL AS dropped_ok
UNION ALL
SELECT 'member_levels', to_regclass('public.member_levels') IS NULL;

-- 9.3 client_wechat_users: 新列存在，category 不存在
SELECT column_name,
       data_type,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_name='client_wechat_users'
  AND column_name IN ('points_balance','points_updated_at','became_member_at','category')
ORDER BY column_name;
-- 期望：3 行（points_balance / points_updated_at / became_member_at），没有 category

-- 9.4 operation_logs 两列已放宽
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name='operation_logs'
  AND column_name IN ('operator_employee_id','operator_name')
ORDER BY column_name;
-- 期望：两行 is_nullable='YES'

-- 9.5 product_categories.product_kind 类型 = enum
SELECT data_type, udt_name
FROM information_schema.columns
WHERE table_name='product_categories' AND column_name='product_kind';
-- 期望：data_type='USER-DEFINED', udt_name='product_kind'

-- 9.6 product_kind 枚举值集
SELECT array_agg(enumlabel ORDER BY enumsortorder) AS product_kind_values
FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid
WHERE t.typname='product_kind';
-- 期望：{护理项目,家居产品,充值卡,体验卡}

-- 9.7 sale_order_type 枚举值集 = 5 值
SELECT array_agg(enumlabel ORDER BY enumsortorder) AS sale_order_type_values
FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid
WHERE t.typname='sale_order_type';
-- 期望：{销售单,内部单,回款单,转换单,退款单}

-- 9.8 sale_orders 现存值（全部落在新 5 值内）
SELECT sale_order_type::text AS val, count(*) AS rows
FROM sale_orders
GROUP BY 1
ORDER BY 2 DESC;

-- 9.9 sale_orders default + NOT NULL
SELECT column_default, is_nullable
FROM information_schema.columns
WHERE table_name='sale_orders' AND column_name='sale_order_type';
-- 期望：column_default 含 '销售单', is_nullable='NO'

-- 9.10 service_items.is_presale 不存在
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name='service_items' AND column_name='is_presale'
) AS is_presale_dropped_ok;

-- 9.11 point_transaction_type enum 不存在
SELECT NOT EXISTS (
  SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
  WHERE n.nspname='public' AND t.typname='point_transaction_type'
) AS point_txn_type_dropped_ok;

-- ================================================================
-- DRY-RUN / COMMIT 开关
-- ================================================================
-- 默认保持 ROLLBACK：第一次 apply 时拿 Part 9 输出给用户 review
-- Review 通过后：注释掉下面的 ROLLBACK，解开 COMMIT，再跑一次
-- 2026-04-10 DRY-RUN Part 9 全绿，用户授权 COMMIT
-- ROLLBACK;
COMMIT;
