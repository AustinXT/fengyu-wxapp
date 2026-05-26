-- verify-new-member-cutover.sql
-- 「新会员」判定字段切换验证（2026-04-25）
--
-- 用途：在两库（5433/fengyu_wxapp、5434/fengyu）部署 mgmt-dashboard 新口径前后各跑一次，
--      对比新旧公式出数差异、检查归属覆盖率、按需补部分索引。
--
-- 字段口径变更：
--   旧：old_member_level IS NULL ∧ member_level IS NOT NULL ∩ [member_level_upgraded_at]
--   新：became_member_at IS NOT NULL ∩ [became_member_at]
--
-- 依赖：backfill-became-member-at.js 已在两库执行完毕（自检 NULL = 0）。
--
-- 执行方式：
--   psql "postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu" -f db/scripts/verify-new-member-cutover.sql
--   psql "postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" -f db/scripts/verify-new-member-cutover.sql

\echo '========================================'
\echo '1. 全局新会员数（本月）：旧 vs 新口径出数对比'
\echo '========================================'

SELECT
  '旧口径 (member_level_upgraded_at)' AS formula,
  COUNT(*) AS new_member_count
FROM client_wechat_users
WHERE old_member_level IS NULL
  AND member_level IS NOT NULL
  AND date_trunc('month', member_level_upgraded_at) = date_trunc('month', NOW()::date)

UNION ALL

SELECT
  '新口径 (became_member_at)' AS formula,
  COUNT(*) AS new_member_count
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date);

\echo '— 期望：新口径 ≥ 旧口径（新口径含"曾被等级覆盖但 became_member_at 仍命中本月"的边界），'
\echo '       但通常两者数值非常接近。差异 > 20% 时建议人工抽查。'

\echo ''
\echo '========================================'
\echo '2. 全局新会员数（上月 / 本年）：新口径'
\echo '========================================'

SELECT
  '上月' AS period,
  COUNT(*) AS cnt
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date - INTERVAL '1 month')

UNION ALL

SELECT
  '本年' AS period,
  COUNT(*) AS cnt
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('year', became_member_at) = date_trunc('year', NOW()::date);

\echo ''
\echo '========================================'
\echo '3. 员工排行榜（staffRanking.newMember）归属覆盖率'
\echo '   bound_employee_id IS NULL → 该新会员不进任何员工榜单'
\echo '========================================'

SELECT
  COUNT(*) FILTER (WHERE bound_employee_id IS NULL) AS unattributed,
  COUNT(*) AS total_new_members_this_month,
  ROUND(100.0 * COUNT(*) FILTER (WHERE bound_employee_id IS NULL) / NULLIF(COUNT(*), 0), 2) AS unattributed_pct
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date);

\echo '— 期望：unattributed_pct < 30%。'
\echo '       > 30% 时暂停 staffRanking.newMember 上线，与业务确认是否切换归属字段（promoter_employee_id 或 service_items.employee_id）'

\echo ''
\echo '========================================'
\echo '4. 门店排行榜（storeRanking.newMember）归属覆盖率'
\echo '   bound_store_id IS NULL → 该新会员不进任何门店榜单'
\echo '========================================'

SELECT
  COUNT(*) FILTER (WHERE bound_store_id IS NULL) AS unattributed,
  COUNT(*) AS total_new_members_this_month,
  ROUND(100.0 * COUNT(*) FILTER (WHERE bound_store_id IS NULL) / NULLIF(COUNT(*), 0), 2) AS unattributed_pct
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date);

\echo '— 期望：通常远低于员工归属未覆盖率，因 bound_store_id 由 bindStore 路径维护。'

\echo ''
\echo '========================================'
\echo '5. 数据质量自检：became_member_at 与 customer_type 应一致'
\echo '   customer_type=会员客 必须有 became_member_at（backfill 已保证）'
\echo '========================================'

SELECT
  '会员客但 became_member_at IS NULL（应为 0）' AS check_label,
  COUNT(*) AS cnt
FROM client_wechat_users
WHERE customer_type = '会员客'
  AND became_member_at IS NULL

UNION ALL

SELECT
  'became_member_at NOT NULL 但非会员客（业务上少见，应该为 0 或极少）',
  COUNT(*)
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND customer_type <> '会员客';

\echo '— 第 1 行 > 0 → 重跑 db/scripts/backfill-became-member-at.js'
\echo '— 第 2 行 > 0 → 业务异常，可能是 customer_type 被回退（不应发生），需排查 recalcCustomerType 逻辑'

\echo ''
\echo '========================================'
\echo '6. 索引检查：staffRanking 推荐部分索引'
\echo '========================================'

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'client_wechat_users'
  AND (indexname LIKE '%bound_emp%' OR indexname LIKE '%became_member%' OR indexname LIKE '%bound_store%')
ORDER BY indexname;

\echo '— 推荐建索引（按需）：'
\echo '    CREATE INDEX IF NOT EXISTS idx_cwu_bound_emp_became_member'
\echo '      ON client_wechat_users (bound_employee_id, became_member_at)'
\echo '      WHERE bound_employee_id IS NOT NULL AND became_member_at IS NOT NULL;'
\echo ''
\echo '    CREATE INDEX IF NOT EXISTS idx_cwu_bound_store_became_member'
\echo '      ON client_wechat_users (bound_store_id, became_member_at)'
\echo '      WHERE bound_store_id IS NOT NULL AND became_member_at IS NOT NULL;'

\echo ''
\echo '========================================'
\echo '7. EXPLAIN ANALYZE：新口径 storeRanking SQL 性能'
\echo '========================================'

EXPLAIN (ANALYZE, BUFFERS)
SELECT
  s.store_id,
  s.store_name,
  COUNT(c.user_id) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN client_wechat_users c
  ON c.bound_store_id = s.store_id
  AND c.became_member_at IS NOT NULL
  AND date_trunc('month', c.became_member_at) = date_trunc('month', NOW()::date)
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC;

\echo '— 期望 P95 < 500ms。如 Seq Scan 大表 → 加 §6 推荐索引。'
