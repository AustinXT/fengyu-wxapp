-- ============================================================================
-- fix-customer-status-non-member.sql
--
-- 用途：
--   一次性修复 client_wechat_users.customer_status 的脏数据。
--   旧版 cronTask STEP 1 / update-customer-status.js 不限 customer_type 就打标签，
--   导致流量客 / 体验客 / 小美客被误标为「保有会员-稳定/有效」等不合理状态。
--   业务决策：customer_status 仅对 customer_type='会员客' 的顾客有值，
--             非会员客一律 NULL。本脚本按此口径全量重算。
--
-- 依赖前置：
--   1. fengyu-client/cloudfunctions/cronTask 已部署新版（三段式 SQL）
--      —— 否则今晚 03:00 cronTask 重跑后还会把脏数据再写回来。
--   2. db/scripts/update-customer-status.js 已同步更新（保持手工跑入口一致）。
--
-- 执行方式（5433 + 5434 两个库各跑一次）：
--   psql 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp' \
--        -f db/scripts/fix-customer-status-non-member.sql
--   psql 'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu' \
--        -f db/scripts/fix-customer-status-non-member.sql
--
-- 特性：
--   - 幂等可重入：每段都是「无外部依赖」的全量 UPDATE，重复执行结果一致
--   - 无外部事务：每段是独立的单条 UPDATE，PG 单条 SQL 自身就是事务
--   - 全量 O(N)：N = client_wechat_users 行数；预计执行时间 < 5 秒
-- ============================================================================

-- 自检：执行前的状态分布（对照用）
\echo '=== 执行前 customer_status 分布（按 customer_type 分组） ==='
SELECT customer_type,
       customer_status,
       COUNT(*) AS cnt
  FROM client_wechat_users
 GROUP BY customer_type, customer_status
 ORDER BY customer_type, customer_status;

-- ────────────────────────────────────────────────────────────────────────────
-- 段 1：非会员客一律置 NULL
--   清理脏数据 + 防止 customer_type 反向变更后残留
-- ────────────────────────────────────────────────────────────────────────────
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客';

-- ────────────────────────────────────────────────────────────────────────────
-- 段 2：会员客有到店记录的：按 visits_90d / total_visits 打状态
--   保有会员-稳定  90天内至少到店1次 且 累计到店 >= 6 次
--   保有会员-有效  90天内至少到店1次 且 累计到店 <= 5 次
--   预警沉睡       最后到店 >= 6 个月前
--   冰冻           最后到店 >= 12 个月前
--   休眠           其他
-- ────────────────────────────────────────────────────────────────────────────
WITH visit_stats AS (
  SELECT so.client_user_id,
         MAX(so.service_date) AS last_service_date,
         COUNT(DISTINCT so.service_date) AS total_visits,
         COUNT(DISTINCT so.service_date) FILTER (
           WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
         ) AS visits_90d
  FROM service_orders so
  WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
  GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
   SET customer_status = CASE
         WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
         WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '预警沉睡'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
         ELSE '休眠'::customer_status
       END,
       updated_at = NOW()
  FROM visit_stats vs
 WHERE u.user_id = vs.client_user_id
   AND u.customer_type = '会员客';

-- ────────────────────────────────────────────────────────────────────────────
-- 段 3：会员客但完全无到店记录的：置 '休眠'
-- ────────────────────────────────────────────────────────────────────────────
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   );

-- 自检：执行后的状态分布
\echo '=== 执行后 customer_status 分布（按 customer_type 分组） ==='
SELECT customer_type,
       customer_status,
       COUNT(*) AS cnt
  FROM client_wechat_users
 GROUP BY customer_type, customer_status
 ORDER BY customer_type, customer_status;

-- 自检：非会员客的 customer_status 应全部为 NULL（应输出 0）
\echo '=== 自检：非会员客 customer_status 非 NULL 的残留行数（应为 0） ==='
SELECT COUNT(*)::int AS leftover_count
  FROM client_wechat_users
 WHERE customer_type != '会员客'
   AND customer_status IS NOT NULL;
