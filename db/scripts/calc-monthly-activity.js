#!/usr/bin/env node
/**
 * 月度客活 + 到店状态 计算脚本
 *
 * 使用方法：
 *   node scripts/calc-monthly-activity.js            # 正常计算
 *   node scripts/calc-monthly-activity.js --dry-run   # 预览模式
 *
 * ── 客活（monthly_activity）──
 * 基于当月已完成服务单，按 service_date 去重天数：
 *   - 二次客活：当月到店 >= 2 天
 *   - 一次客活：当月到店 = 1 天
 *   - 0次客活：会员客当月未到店
 *
 * ── 到店状态（customer_status）──
 * 仅针对会员客，基于全部历史已完成服务单（与 cronTask STEP 1 对齐）：
 *   - 保有会员-稳定：90 天内到店过，且累计到店 >= 6 天
 *   - 保有会员-有效：90 天内到店过，但累计到店 <= 5 天
 *   - 沉睡：最近一次到店在 90 天 ~ 6 个月前
 *   - 冰冻：最近一次到店在 6 ~ 12 个月前
 *   - 休眠：超过 12 个月未到店（或从未到店）
 *
 * 非会员客（流量客 / 体验客 / 小美客）的 customer_status 一律置 NULL。
 *
 * 建议通过 cron 每日凌晨 3:00 执行：
 *   0 3 * * * cd /path/to/db && node scripts/calc-monthly-activity.js
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp',
  max: 5,
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  if (dryRun) console.log('⚠ 预览模式，不会写入数据库\n')

  const pool = new Pool(PG_CONFIG)

  try {
    await pool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功\n')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      await calcMonthlyActivity(client, dryRun)
      await calcCustomerStatus(client, dryRun)

      if (!dryRun) {
        await client.query('COMMIT')
      } else {
        await client.query('ROLLBACK')
      }
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('\n✗ 计算失败:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// ── 客活计算 ──────────────────────────────────────────────

async function calcMonthlyActivity(client, dryRun) {
  console.log('═══ 客活计算 ═══\n')

  // Step 1: 统计当月每位顾客的到店天数
  const visitCountResult = await client.query(`
    SELECT
      client_user_id,
      COUNT(DISTINCT service_date) AS visit_days
    FROM service_orders
    WHERE status = '已完成'
      AND client_user_id IS NOT NULL
      AND service_date >= date_trunc('month', CURRENT_DATE)::date
      AND service_date < (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
    GROUP BY client_user_id
  `)

  const visitMap = new Map()
  for (const row of visitCountResult.rows) {
    visitMap.set(row.client_user_id, parseInt(row.visit_days))
  }
  console.log(`当月有到店记录：${visitMap.size} 人`)

  // Step 2: 查询所有会员客
  const membersResult = await client.query(`
    SELECT user_id FROM client_wechat_users WHERE customer_type = '会员客'
  `)
  const memberIds = new Set(membersResult.rows.map(r => r.user_id))
  console.log(`会员客共 ${memberIds.size} 人`)

  // Step 3: 计算客活
  let countTwo = 0, countOne = 0, countZero = 0

  const allUserIds = new Set([...visitMap.keys(), ...memberIds])
  const byActivity = { '二次客活': [], '一次客活': [], '0次客活': [] }

  for (const userId of allUserIds) {
    const visits = visitMap.get(userId) || 0

    if (visits >= 2) {
      byActivity['二次客活'].push(userId)
      countTwo++
    } else if (visits === 1) {
      byActivity['一次客活'].push(userId)
      countOne++
    } else if (memberIds.has(userId)) {
      byActivity['0次客活'].push(userId)
      countZero++
    }
  }

  console.log(`\n  二次客活：${countTwo} 人`)
  console.log(`  一次客活：${countOne} 人`)
  console.log(`  0次客活：${countZero} 人`)

  if (!dryRun) {
    await client.query(`UPDATE client_wechat_users SET monthly_activity = NULL`)

    for (const [activity, userIds] of Object.entries(byActivity)) {
      if (userIds.length === 0) continue
      await client.query(
        `UPDATE client_wechat_users SET monthly_activity = $1, updated_at = NOW() WHERE user_id = ANY($2)`,
        [activity, userIds]
      )
    }
    console.log('✓ 客活已更新\n')
  } else {
    console.log('⚠ 预览模式，未写入\n')
  }
}

// ── 到店状态计算 ──────────────────────────────────────────
//
// 三段式 SQL 与 fengyu-client/cloudfunctions/cronTask/index.js STEP 1 完全对齐：
//   段 1：非会员客一律置 NULL
//   段 2：会员客有到店记录的，按 visits_90d / total_visits 打状态
//   段 3：会员客但完全无到店记录的，置 '休眠'
//
// 阈值口径（与 cronTask 一致）：
//   - 保有会员-稳定 / 有效  使用 90 天窗口（不是 3 个月）
//   - 沉睡 / 冰冻           使用 6 个月 / 12 个月

const RESET_NON_MEMBER_SQL = `
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客'
`

const UPDATE_MEMBER_WITH_VISITS_SQL = `
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

const RESET_MEMBER_NO_VISITS_SQL = `
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   )
`

async function calcCustomerStatus(client, dryRun) {
  console.log('═══ 到店状态计算 ═══\n')

  if (dryRun) {
    // dry-run：仅预览分布，不写入。读取「假设跑完后」的状态分布。
    const { rows } = await client.query(`
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
      ),
      preview AS (
        SELECT u.user_id,
               CASE
                 WHEN u.customer_type != '会员客' THEN NULL
                 WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'
                 WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'
                 WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'
                 WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'
                 ELSE '休眠'
               END AS new_status
        FROM client_wechat_users u
        LEFT JOIN visit_stats vs ON vs.client_user_id = u.user_id
      )
      SELECT new_status, COUNT(*) AS cnt FROM preview GROUP BY new_status ORDER BY new_status
    `)
    for (const r of rows) {
      console.log(`  ${r.new_status === null ? '(NULL)' : r.new_status}：${r.cnt} 人`)
    }
    console.log('\n⚠ 预览模式，未写入')
    return
  }

  // 段 1：非会员客一律置 NULL
  const r1 = await client.query(RESET_NON_MEMBER_SQL)
  console.log(`  段1 非会员客置 NULL：${r1.rowCount} 行`)

  // 段 2：会员客有到店记录的
  const r2 = await client.query(UPDATE_MEMBER_WITH_VISITS_SQL)
  console.log(`  段2 会员客有服务记录已更新：${r2.rowCount} 行`)

  // 段 3：会员客无到店记录的置 '休眠'
  const r3 = await client.query(RESET_MEMBER_NO_VISITS_SQL)
  console.log(`  段3 会员客无服务记录置休眠：${r3.rowCount} 行`)

  // 状态分布
  const { rows: stats } = await client.query(`
    SELECT customer_status, COUNT(*) AS cnt
    FROM client_wechat_users
    GROUP BY customer_status
    ORDER BY customer_status
  `)
  console.log('\n  ── 状态分布 ──')
  for (const r of stats) {
    console.log(`  ${r.customer_status === null ? '(NULL)' : r.customer_status}：${r.cnt} 人`)
  }

  console.log('\n✓ 到店状态已更新')
}

main()
