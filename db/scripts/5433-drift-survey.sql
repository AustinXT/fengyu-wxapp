-- ⚠ 历史脚本（已执行完毕）：下文的 47.113.202.7 / 5434 是当时的旧拓扑，保留原文以还原语境。
--   该机已于 2026-09-01 全面弃用，当前拓扑见 db/CLAUDE.md，**不要照抄下面的连接串**。
-- 5433-drift-survey.sql — 2026-04-10 follow-up 的 5433 drift 修复【只读侦查】
--
-- 目标：把 plan 里对 5433 的事前假设全部数值化，避免 delta SQL 写到一半
-- 因为数据分布出乎意料而回滚。
--
-- 使用方式（必须在低峰期或预告停机前执行）：
--   psql "postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
--        -f db/scripts/5433-drift-survey.sql
--
-- 本脚本全部是 SELECT，无任何 DDL/DML，不会修改任何数据。

\echo '=== 1. "多出" 4 张表的 row count ==='
-- 理论上 5434 的 baseline 才会产生 20260410 备份表，5433 不该有
SELECT 'customer_points' AS tbl,
       CASE WHEN to_regclass('public.customer_points') IS NULL THEN -1
            ELSE (SELECT count(*) FROM public.customer_points) END AS rows
UNION ALL
SELECT 'member_levels',
       CASE WHEN to_regclass('public.member_levels') IS NULL THEN -1
            ELSE (SELECT count(*) FROM public.member_levels) END
UNION ALL
SELECT 'sale_items_backup_20260410',
       CASE WHEN to_regclass('public.sale_items_backup_20260410') IS NULL THEN -1
            ELSE (SELECT count(*) FROM public.sale_items_backup_20260410) END
UNION ALL
SELECT 'service_commissions_backup_20260410',
       CASE WHEN to_regclass('public.service_commissions_backup_20260410') IS NULL THEN -1
            ELSE (SELECT count(*) FROM public.service_commissions_backup_20260410) END;
-- rows = -1 表示该表不存在；>= 0 是实际行数

\echo ''
\echo '=== 2. sale_order_type 值分布（确认 CASE WHEN 覆盖所有现存值）==='
-- 期望值域：{普通, 体验, 内部, 组合套餐, 福利活动, 回款, 转换, 退款}
-- 如果出现 plan CASE WHEN 中没有的值，必须先补映射再 apply
SELECT sale_order_type::text AS val, count(*) AS rows
FROM sale_orders
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 3. product_categories.product_kind 分布（确认 福利活动 行数）==='
-- 列当前是 text 类型，会把所有历史值都打印出来
SELECT product_kind::text AS val, count(*) AS rows
FROM product_categories
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 4. client_wechat_users.category 分布 + 总行数（数据丢失规模）==='
-- 5434 当时 DROP 掉 22875 行 A/B/C/D/E 分级，5433 的规模需要独立确认
SELECT category AS val, count(*) AS rows
FROM client_wechat_users
GROUP BY 1
ORDER BY 2 DESC;
SELECT 'client_wechat_users TOTAL' AS item, count(*) AS rows FROM client_wechat_users;

\echo ''
\echo '=== 5. customer_points 余额情况（迁移前余额数据量）==='
-- 若 customer_points 不存在直接返回 -1
SELECT CASE WHEN to_regclass('public.customer_points') IS NULL THEN -1
            ELSE (SELECT count(*) FROM customer_points WHERE balance > 0) END AS positive_balance_rows;
-- 顺便看一眼 customer_points 的 schema（确认 balance / updated_at 列真实存在，不然 plan 里的 UPDATE 会失败）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name='customer_points'
ORDER BY ordinal_position;

\echo ''
\echo '=== 6. operation_logs NULL 行数（应为 0，因为当前 NOT NULL）==='
SELECT count(*) FILTER (WHERE operator_employee_id IS NULL) AS null_emp,
       count(*) FILTER (WHERE operator_name IS NULL)        AS null_name,
       count(*) AS total
FROM operation_logs;

\echo ''
\echo '=== 7. service_items.is_presale 分布（确认 DROP 无损失）==='
-- is_presale 在运行时代码（admin/client/staff/云函数）零引用，已 grep 确认
-- 这里只是把数据分布留底
SELECT is_presale, count(*) AS rows
FROM service_items
GROUP BY 1;

\echo ''
\echo '=== 8. point_transaction_type enum 是否被任何列引用 ==='
-- 期望 0 行。如果有行，必须先改列类型或保留 enum，不能直接 DROP TYPE
SELECT table_schema, table_name, column_name, udt_name
FROM information_schema.columns
WHERE udt_name = 'point_transaction_type'
ORDER BY table_name, column_name;

\echo ''
\echo '=== 9. 当前云函数活跃连接数（观察执行时机）==='
SELECT count(*) AS active_conn
FROM pg_stat_activity
WHERE datname='fengyu_wxapp'
  AND state='active'
  AND pid <> pg_backend_pid();

\echo ''
\echo '=== 10. 现有 enum 类型清单（确认 sale_order_type / product_kind 存在） ==='
SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN ('sale_order_type', 'product_kind', 'point_transaction_type')
GROUP BY t.typname
ORDER BY t.typname;
