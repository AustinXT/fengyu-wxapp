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
 * 仅针对会员客，基于全部历史已完成服务单：
 *   - 保有会员-稳定：3个月内到店过，且累计到店 >= 6 天
 *   - 保有会员-有效：3个月内到店过，但累计到店 <= 5 天
 *   - 预警沉睡：最近一次到店在 3~6 个月前
 *   - 冰冻：最近一次到店在 6~12 个月前
 *   - 休眠：超过12个月未到店（或从未到店）
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

async function calcCustomerStatus(client, dryRun) {
  console.log('═══ 到店状态计算 ═══\n')

  // 查询每位会员客的：最近到店日期、累计到店天数
  const statsResult = await client.query(`
    SELECT
      c.user_id,
      MAX(s.service_date)::date AS last_visit_date,
      COUNT(DISTINCT s.service_date) AS total_visit_days
    FROM client_wechat_users c
    LEFT JOIN service_orders s
      ON s.client_user_id = c.user_id
      AND s.status = '已完成'
    WHERE c.customer_type = '会员客'
    GROUP BY c.user_id
  `)

  const today = new Date()
  const months3 = new Date(today); months3.setMonth(months3.getMonth() - 3)
  const months6 = new Date(today); months6.setMonth(months6.getMonth() - 6)
  const months12 = new Date(today); months12.setMonth(months12.getMonth() - 12)

  const byStatus = {
    '保有会员-稳定': [],
    '保有会员-有效': [],
    '预警沉睡': [],
    '冰冻': [],
    '休眠': [],
  }

  for (const row of statsResult.rows) {
    const totalVisits = parseInt(row.total_visit_days)
    const lastVisit = row.last_visit_date ? new Date(row.last_visit_date) : null

    let status
    if (!lastVisit) {
      // 从未到店
      status = '休眠'
    } else if (lastVisit >= months3) {
      // 3个月内到店过
      status = totalVisits >= 6 ? '保有会员-稳定' : '保有会员-有效'
    } else if (lastVisit >= months6) {
      // 3~6个月前
      status = '预警沉睡'
    } else if (lastVisit >= months12) {
      // 6~12个月前
      status = '冰冻'
    } else {
      // 超过12个月
      status = '休眠'
    }

    byStatus[status].push(row.user_id)
  }

  for (const [status, ids] of Object.entries(byStatus)) {
    console.log(`  ${status}：${ids.length} 人`)
  }

  if (!dryRun) {
    // 非会员客置 NULL
    await client.query(`UPDATE client_wechat_users SET customer_status = NULL WHERE customer_type != '会员客'`)

    for (const [status, userIds] of Object.entries(byStatus)) {
      if (userIds.length === 0) continue
      await client.query(
        `UPDATE client_wechat_users SET customer_status = $1, updated_at = NOW() WHERE user_id = ANY($2)`,
        [status, userIds]
      )
    }
    console.log('\n✓ 到店状态已更新')
  } else {
    console.log('\n⚠ 预览模式，未写入')
  }
}

main()
