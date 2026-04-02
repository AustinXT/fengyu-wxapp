#!/usr/bin/env node

/**
 * update-customer-status.js — 更新顾客到店状态
 *
 * 用法：
 *   node scripts/update-customer-status.js              # 执行更新
 *   node scripts/update-customer-status.js --dry-run     # 预览（不写入）
 *
 * 规则（基于已完成服务单，按 service_date 去重计次）：
 *   保有会员-稳定  90天内至少到店1次 且 累计到店≥6次
 *   保有会员-有效  90天内至少到店1次 且 累计到店≤5次
 *   预警沉睡      最后到店在3~6个月前
 *   冰冻          最后到店在6~12个月前
 *   休眠          超过12个月未到店 / 从未到店
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

const UPDATE_SQL = `
WITH visit_stats AS (
  SELECT
    so.client_user_id,
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
SET
  customer_status = CASE
    WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
    WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
    WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '预警沉睡'::customer_status
    WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
    ELSE '休眠'::customer_status
  END,
  updated_at = NOW()
FROM visit_stats vs
WHERE u.user_id = vs.client_user_id
`

const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
SET customer_status = '休眠'::customer_status, updated_at = NOW()
WHERE customer_status != '休眠'
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

async function main() {
  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // 1. 有服务记录的顾客：按规则分类
    const { rowCount: updatedCount } = await client.query(UPDATE_SQL)
    log(`有服务记录的顾客已更新: ${updatedCount}`)

    // 2. 无服务记录但状态不是休眠的：重置为休眠
    const { rowCount: resetCount } = await client.query(RESET_NO_VISITS_SQL)
    log(`无服务记录的顾客已重置: ${resetCount}`)

    // 3. 输出统计
    const { rows: stats } = await client.query(STATS_SQL)
    log('--- 状态分布 ---')
    for (const r of stats) {
      log(`  ${r.customer_status}: ${r.cnt}`)
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
