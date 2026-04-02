/**
 * cronTask 定时触发器云函数
 * 每日凌晨3点执行，更新顾客到店状态
 *
 * 触发器配置: 0 0 3 * * * *
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { Pool } = require('pg')

let pool = null
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
    pool.on('error', (err) => {
      console.error('PG pool error:', err)
    })
  }
  return pool
}

const UPDATE_CUSTOMER_STATUS_SQL = `
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

exports.main = async (event) => {
  console.log('[cronTask] triggered:', JSON.stringify(event))

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const { rowCount: updatedCount } = await client.query(UPDATE_CUSTOMER_STATUS_SQL)
    console.log(`[cronTask] 有服务记录的顾客已更新: ${updatedCount}`)

    const { rowCount: resetCount } = await client.query(RESET_NO_VISITS_SQL)
    console.log(`[cronTask] 无服务记录的顾客已重置: ${resetCount}`)

    // 输出统计
    const { rows: stats } = await client.query(`
      SELECT customer_status, COUNT(*) AS cnt
      FROM client_wechat_users
      GROUP BY customer_status ORDER BY customer_status
    `)
    console.log('[cronTask] 状态分布:', JSON.stringify(stats))

    await client.query('COMMIT')

    return {
      code: 0,
      message: 'success',
      data: { updatedCount, resetCount, stats },
    }
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[cronTask] ERROR:', err)
    return { code: -1, message: err.message }
  } finally {
    client.release()
  }
}
