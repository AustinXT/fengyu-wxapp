#!/usr/bin/env node

/**
 * backfill-service-commissions-roletype.js — 一次性回填 service_commissions.role_type
 *
 * 背景：
 *   2026-04-25 审计发现：service_commissions.role_type 全表 NULL（双库各 616,210 行）。
 *   原因：历史 migration 脚本（migrate-service-records.js / migrate-presale-services.js）
 *   INSERT 路径未填 role_type；当前 staffApi service.complete 路径已正确填，但存量未补。
 *
 *   2026-04-25 起，员工绩效与提成统计开始按 role_type 分流（美容师/养生师/推广师），
 *   存量历史记录需一次性回填。
 *
 * 数据来源（COALESCE 链）：
 *   1. staff_wechat_users.skills[1] — 员工首要角色（最准），按 employee_id 关联
 *   2. '美容师'                     — 兜底默认值
 *
 * 用法：
 *   # 5434 / fengyu（生产业务库，admin + 全部云函数共用，必跑）
 *   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-service-commissions-roletype.js --commit
 *
 *   # 5433 / fengyu_wxapp（冷备库，可选）
 *   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-service-commissions-roletype.js --commit
 *
 *   # dry-run 模式（仅预览统计，不执行 UPDATE）
 *   node db/scripts/backfill-service-commissions-roletype.js
 *
 * 重要：5434 是生产业务库（必跑）；5433 是冷备（可选，参见 db/CLAUDE.md「生产库与冷备库」）。
 *
 * 自检：执行后 `role_type IS NULL AND is_void = FALSE` 应等于 0。
 *
 * 幂等：只回填 role_type IS NULL 且未作废（is_void = FALSE）的行，已写过的不会被覆盖。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  max: 3,
}

const commit = process.argv.includes('--commit')

function log(msg) {
  console.log(`[BACKFILL-SVC-COMM-ROLETYPE] ${new Date().toISOString()} ${msg}`)
}

const PREVIEW_SQL = `
SELECT COUNT(*) FILTER (WHERE role_type IS NULL) AS null_count,
       COUNT(*)                                  AS total,
       COALESCE(SUM(commission_amount::numeric) FILTER (WHERE role_type IS NULL), 0) AS null_amount
  FROM service_commissions
 WHERE is_void = FALSE
`

const BACKFILL_BY_SKILL_SQL = `
UPDATE service_commissions sc
   SET role_type = COALESCE(swu.skills[1], '美容师'),
       updated_at = NOW()
  FROM staff_wechat_users swu
 WHERE sc.employee_id = swu.employee_id
   AND sc.role_type IS NULL
   AND sc.is_void = FALSE
`

const BACKFILL_FALLBACK_SQL = `
UPDATE service_commissions
   SET role_type = '美容师',
       updated_at = NOW()
 WHERE role_type IS NULL
   AND is_void = FALSE
`

const SELFCHECK_SQL = `
SELECT COUNT(*) AS cnt
  FROM service_commissions
 WHERE role_type IS NULL
   AND is_void = FALSE
`

const GROUP_STATS_SQL = `
SELECT role_type, COUNT(*) AS cnt
  FROM service_commissions
 WHERE is_void = FALSE
 GROUP BY role_type
 ORDER BY cnt DESC
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: PG_CONNECTION_STRING 或 DATABASE_URL 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${commit ? 'COMMIT（实际写入）' : 'DRY-RUN（仅预览，不写入；加 --commit 才执行 UPDATE）'}`)
  log('提醒: 5434/fengyu 是生产业务库（必跑）；5433/fengyu_wxapp 已转冷备（可选）')

  const pool = new Pool(PG_CONFIG)
  try {
    const preview = await pool.query(PREVIEW_SQL)
    const { null_count, total, null_amount } = preview.rows[0]
    log(`未作废提成总行数: ${total}`)
    log(`其中 role_type IS NULL 行数: ${null_count}`)
    log(`其中 role_type IS NULL 涉及金额: ${null_amount}`)

    if (Number(null_count) === 0) {
      log('✓ 无需回填，自检直接通过')
      return
    }

    if (!commit) {
      log('--commit 未指定，跳过 UPDATE。复核以上统计，确认后用 --commit 重新执行')
      return
    }

    const r1 = await pool.query(BACKFILL_BY_SKILL_SQL)
    log(`SQL1（按 staff.skills[1] 派生）：已回填 ${r1.rowCount} 行`)

    const r2 = await pool.query(BACKFILL_FALLBACK_SQL)
    log(`SQL2（兜底 '美容师'）：已回填 ${r2.rowCount} 行`)

    const after = await pool.query(SELFCHECK_SQL)
    const remaining = Number(after.rows[0].cnt)
    if (remaining === 0) {
      log('✓ 自检通过：role_type IS NULL AND is_void = FALSE 已清零')
    } else {
      log(`✗ 自检失败：仍有 ${remaining} 行 role_type IS NULL（不应发生）`)
      process.exitCode = 1
    }

    const grouped = await pool.query(GROUP_STATS_SQL)
    log('按 role_type 分组统计（人工核对）:')
    for (const row of grouped.rows) {
      log(`  ${row.role_type ?? '<NULL>'} : ${row.cnt}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('回填失败:', err)
  process.exit(1)
})
