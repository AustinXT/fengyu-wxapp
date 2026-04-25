#!/usr/bin/env node

/**
 * update-customer-status.js — 更新顾客到店状态
 *
 * 用法：
 *   node scripts/update-customer-status.js              # 执行更新
 *   node scripts/update-customer-status.js --dry-run     # 预览（不写入）
 *
 * 业务口径：
 *   customer_status 仅对 customer_type='会员客' 的顾客有值，
 *   非会员客（流量客 / 体验客 / 小美客）一律 NULL。
 *
 * 三段式 SQL（与 fengyu-client/cloudfunctions/cronTask/index.js STEP 1 完全对齐）：
 *   段 1：非会员客一律置 NULL（清理脏数据 + 防止 customer_type 反向变更后残留）
 *   段 2：会员客有到店记录的：按 visits_90d / total_visits 打状态
 *           保有会员-稳定  90天内至少到店1次 且 累计到店 >= 6 次
 *           保有会员-有效  90天内至少到店1次 且 累计到店 <= 5 次
 *           沉睡           最后到店 >= 6 个月前
 *           冰冻           最后到店 >= 12 个月前
 *           休眠           其他（超过 12 个月未到店）
 *   段 3：会员客但完全无到店记录的：置 '休眠'
 *
 * 幂等、可重入。每次全量重新计算。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[CUSTOMER-STATUS] ${new Date().toISOString()} ${msg}`)
}

// 段 1：非会员客一律置 NULL
const RESET_NON_MEMBER_SQL = `
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客'
`

// 段 2：会员客有到店记录的，按规则分类
const UPDATE_SQL = `
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
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
         ELSE '休眠'::customer_status
       END,
       updated_at = NOW()
  FROM visit_stats vs
 WHERE u.user_id = vs.client_user_id
   AND u.customer_type = '会员客'
`

// 段 3：会员客但无到店记录的，置 '休眠'
const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   )
`

const STATS_SQL = `
SELECT customer_status, COUNT(*) AS cnt
FROM client_wechat_users
GROUP BY customer_status
ORDER BY customer_status
`

const NON_MEMBER_LEFTOVER_SQL = `
SELECT COUNT(*)::int AS cnt
FROM client_wechat_users
WHERE customer_type != '会员客' AND customer_status IS NOT NULL
`

async function main() {
  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // 段 1：非会员客一律置 NULL
    const { rowCount: clearedNonMember } = await client.query(RESET_NON_MEMBER_SQL)
    log(`非会员客 customer_status 已置 NULL: ${clearedNonMember}`)

    // 段 2：会员客有服务记录的，按规则分类
    const { rowCount: updatedCount } = await client.query(UPDATE_SQL)
    log(`会员客有服务记录的已更新: ${updatedCount}`)

    // 段 3：会员客无服务记录的，置 '休眠'
    const { rowCount: resetCount } = await client.query(RESET_NO_VISITS_SQL)
    log(`会员客无服务记录的已置休眠: ${resetCount}`)

    // 输出统计
    const { rows: stats } = await client.query(STATS_SQL)
    log('--- 状态分布 ---')
    for (const r of stats) {
      log(`  ${r.customer_status === null ? '(NULL)' : r.customer_status}: ${r.cnt}`)
    }

    // 自检：非会员客应全部为 NULL
    const { rows: leftoverRows } = await client.query(NON_MEMBER_LEFTOVER_SQL)
    const leftover = leftoverRows[0]?.cnt ?? 0
    if (leftover > 0) {
      log(`WARN: 仍有 ${leftover} 个非会员客 customer_status 非 NULL（不应发生）`)
    } else {
      log('✓ 自检通过：非会员客 customer_status 均为 NULL')
    }

    if (dryRun) {
      await client.query('ROLLBACK')
      log('DRY RUN: 已回滚')
    } else {
      await client.query('COMMIT')
      log('已提交')
    }
  } catch (err) {
    await client.query('ROLLBACK')
    log(`ERROR: ${err.message}`)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
