#!/usr/bin/env node

/**
 * backfill-sale-orders-customer-name.js — 一次性回填 sale_orders.customer_name
 *
 * 背景：
 *   2026-07-08 T1 修复：admin「订单管理」列表的"顾客"列把手机号（如 18270881485）
 *   当作姓名展示。根因：员工端 order-create.ts:1572 与 admin 端 order-create-page.tsx:1468
 *   都有 `name || phone` 的 fallback 模式，当 client_wechat_users.name 为空时把 phone
 *   写入了 sale_orders.customer_name。
 *
 * 兜底方案（与修复同时上线）：
 *   - 读取侧：admin 5+ 端点 + staffApi list 全部加 left join client_wechat_users 兜底
 *   - 写入侧：staffApi/admin 后端在 order.create 内从 client_wechat_users 反查权威值
 *   - 前端：name 为空时阻断开单，提示先补全顾客姓名
 *
 * 本脚本处理"已污染的存量数据"：把所有形如大陆手机号（1[3-9]\d{9}）且能匹配
 * client_wechat_users 的 sale_orders.customer_name 覆写为权威 name。
 *
 * 用法：
 *   # 5434 / fengyu（开发库）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-sale-orders-customer-name.js
 *
 *   # 5433 / fengyu_wxapp（生产业务库）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-sale-orders-customer-name.js
 *
 *   # 预览（不写入）
 *   node db/scripts/backfill-sale-orders-customer-name.js --dry-run
 *
 * 幂等：只更新 customer_name 形如手机号的行，权威 name 为空的行不动（视为非污染）。
 * 自检：执行后 sale_orders 形如 1\d{10} 的 customer_name 且 client_user_id 非空
 *       但 client_wechat_users.name 非空 的行数应等于 0。
 *
 * 后续无需重跑。仅当自检查到 > 0 时再跑。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[BACKFILL-SALE-ORDERS-CUSTOMER-NAME] ${new Date().toISOString()} ${msg}`)
}

// 待回填预览：形如手机号 + client_user_id 非空 + 客户档案 name 非空
const PREVIEW_SQL = `
SELECT COUNT(*) AS cnt
  FROM sale_orders o
  JOIN client_wechat_users c ON c.user_id = o.client_user_id
 WHERE o.customer_name ~ '^1[3-9][0-9]{9}$'
   AND o.client_user_id IS NOT NULL
   AND c.name IS NOT NULL
   AND c.name <> ''
`

// 回填：仅更新形如手机号的行；客户档案 name 为空时不动
const BACKFILL_SQL = `
UPDATE sale_orders o
   SET customer_name = c.name
  FROM client_wechat_users c
 WHERE c.user_id = o.client_user_id
   AND o.client_user_id IS NOT NULL
   AND c.name IS NOT NULL
   AND c.name <> ''
   AND o.customer_name ~ '^1[3-9][0-9]{9}$'
`

// 自检：所有形如手机号且 client_user_id 命中客户档案的 sale_orders.customer_name 都被覆写
const SELFCHECK_SQL = `
SELECT COUNT(*) AS cnt
  FROM sale_orders o
  JOIN client_wechat_users c ON c.user_id = o.client_user_id
 WHERE o.customer_name ~ '^1[3-9][0-9]{9}$'
   AND o.client_user_id IS NOT NULL
   AND c.name IS NOT NULL
   AND c.name <> ''
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${dryRun ? 'DRY-RUN（仅预览，不写入）' : 'EXECUTE（实际写入）'}`)

  const pool = new Pool(PG_CONFIG)
  try {
    const preview = await pool.query(PREVIEW_SQL)
    const pending = Number(preview.rows[0].cnt)
    log(`待回填行数: ${pending}`)

    if (pending === 0) {
      log('✓ 无需回填，自检直接通过')
      return
    }

    if (dryRun) {
      log('--dry-run 模式，跳过 UPDATE')
      log('预览 SQL 已展示目标行数；正式执行请去掉 --dry-run')
      return
    }

    const r = await pool.query(BACKFILL_SQL)
    log(`已回填: ${r.rowCount} 行`)

    const after = await pool.query(SELFCHECK_SQL)
    const remaining = Number(after.rows[0].cnt)
    if (remaining === 0) {
      log('✓ 自检通过：sale_orders 形如 1\\d{10} 且能匹配客户档案的 customer_name 已清零')
    } else {
      log(`✗ 自检失败：仍有 ${remaining} 行未覆写（理论不应发生；可能是 race condition）`)
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[BACKFILL-SALE-ORDERS-CUSTOMER-NAME] FATAL:', err)
  process.exit(1)
})
