#!/usr/bin/env node



const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[BACKFILL-SALE-ORDERS-CUSTOMER-NAME] ${new Date().toISOString()} ${msg}`)
}


const PREVIEW_SQL = `
SELECT COUNT(*) AS cnt
  FROM sale_orders o
  JOIN client_wechat_users c ON c.user_id = o.client_user_id
 WHERE o.customer_name ~ '^1[3-9][0-9]{9}$'
   AND o.client_user_id IS NOT NULL
   AND c.name IS NOT NULL
   AND c.name <> ''
`


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
