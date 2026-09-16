#!/usr/bin/env node

/**
 * backfill-became-member-at.js — 一次性回填 client_wechat_users.became_member_at
 *
 * 背景：
 *   2026-04-25 起，mgmt-dashboard 的「会员数」指标历史化（T2），
 *   口径从 `customer_type='会员客'`（实时快照）改为 `became_member_at::date <= $date`（时间戳）。
 *   存量数据的 became_member_at 在 schema 落库前可能为 NULL，需要一次性回填。
 *
 * 跃迁路径（已与 customer_type 同步写入 became_member_at = NOW()）：
 *   - fengyu-staff/cloudfunctions/staffApi/routes/order.js  recalcCustomerType()
 *   - fengyu-client/cloudfunctions/payNotify/index.js       重算路径（confirmOrder 后）
 *
 * 用法：
 *   # dev（先跑验证）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-became-member-at.js
 *
 *   # prod（必跑）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-became-member-at.js
 *
 *   # 预览（不写入）
 *   node db/scripts/backfill-became-member-at.js --dry-run
 *
 * 时间戳来源（COALESCE）：
 *   1. member_level_upgraded_at — 会员等级首次跃迁的时间（最准）
 *   2. updated_at               — 顾客档案最近一次写入时间（次准）
 *   3. created_at               — 顾客档案创建时间（保底）
 *   4. NOW()                    — 兜底，理论上不会落到这层
 *
 * 自检：执行后 `customer_type='会员客' AND became_member_at IS NULL` 应等于 0。
 *
 * 幂等：只回填 became_member_at IS NULL 的会员客行，已写过的不会被覆盖。
 *
 * 历史执行状态（2026-04-25 T2 完成时已双库执行）：
 *   - 5434/fengyu       自检通过，残留 NULL = 0
 *   - 5433/fengyu_wxapp 自检通过，残留 NULL = 0
 *
 * 后续无需重跑。仅当出现下列情况之一时才需要再执行：
 *   1. 新增了一批历史会员客（如手工 INSERT、新一轮 WorkFine 同步 backfill）→ 跑一次补全 became_member_at
 *   2. 自检 SQL（SELECTCHECK_SQL）查到 NULL > 0
 *
 * ⚠ DEPRECATED（2026-07-17）：本脚本的 COALESCE(member_level_upgraded_at, updated_at,
 *   created_at, NOW()) 兜底口径已过时。became_member_at 现口径 = 首笔达标单时间
 *   （COALESCE(paid_at, created_at)，见 recalc-became-member-at.js，在线五端镜像同口径）。
 *   继续跑本脚本会把已是新口径的值（在 became_member_at IS NULL 残留场景）错误覆盖回
 *   member_level_upgraded_at。已禁用，运行即退出。重算请用 recalc-became-member-at.js。
 */

// DEPRECATED 守卫：禁用本脚本，指向继任者。
console.error('[BACKFILL-BECAME-MEMBER-AT] DEPRECATED: 本脚本口径已过时；became_member_at 重算请改用 db/scripts/recalc-became-member-at.js（支持 dry-run / --apply）')
process.exit(1)

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[BACKFILL-BECAME-MEMBER-AT] ${new Date().toISOString()} ${msg}`)
}

const PREVIEW_SQL = `
SELECT COUNT(*) AS cnt
  FROM client_wechat_users
 WHERE customer_type = '会员客'
   AND became_member_at IS NULL
`

const BACKFILL_SQL = `
UPDATE client_wechat_users
   SET became_member_at = COALESCE(member_level_upgraded_at, updated_at, created_at, NOW())
 WHERE customer_type = '会员客'
   AND became_member_at IS NULL
`

const SELFCHECK_SQL = `
SELECT COUNT(*) AS cnt
  FROM client_wechat_users
 WHERE customer_type = '会员客'
   AND became_member_at IS NULL
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
      return
    }

    const r = await pool.query(BACKFILL_SQL)
    log(`已回填: ${r.rowCount} 行`)

    const after = await pool.query(SELFCHECK_SQL)
    const remaining = Number(after.rows[0].cnt)
    if (remaining === 0) {
      log('✓ 自检通过：customer_type=\'会员客\' AND became_member_at IS NULL 已清零')
    } else {
      log(`✗ 自检失败：仍有 ${remaining} 行 became_member_at IS NULL（不应发生）`)
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('回填失败:', err)
  process.exit(1)
})
