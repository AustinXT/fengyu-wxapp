#!/usr/bin/env node

/**
 * backfill-allocations-commission.js — 一次性回填 sale_allocations.commission_rate / commission_amount
 *
 * 背景：
 *   2026-05-26 落地 staff.pr.spec §3.15 双维度提成模型，员工绩效页 / 数据看板「员工收入」/ staffRanking
 *   的销售部分从「营业额份额」(total_amount) 改为「真实销售提成」(commission_amount = 份额 × 提成率)。
 *   migration 0057 给 sale_allocations 加了 commission_rate / commission_amount 两列，存量历史行为 NULL，
 *   需一次性回填，固化各行的提成率快照。
 *
 * 口径（与 staffApi allocation.js buildSalesRateLookup / payNotify / admin allocations.ts 一致）：
 *   - 费率来源：commission_rate_matrix，market = sale_orders.market_name、order_type = '销售单'、
 *     role_type = sa.role_type、sales_category = sale_items.sales_category；
 *   - tier 基准：该订单全部明细 received 之和（订单级合计），多 tier 命中取 amount_tier_min 最大者；
 *   - 匹配不到（market 为空 / 无配置）→ rate = 0 → commission_amount = 0；
 *   - commission_amount = ROUND(total_amount × commission_rate, 2)，退款行 total_amount 为负随之为负。
 *
 * 用法：
 *   # prod（必跑）
 *   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-allocations-commission.js            # dry-run 预览
 *   PG_CONNECTION_STRING="..." node db/scripts/backfill-allocations-commission.js --commit  # 实际写入
 *
 * 自检：执行后 `commission_amount IS NULL AND is_void = FALSE` 应等于 0。
 * 幂等：只回填 commission_amount IS NULL 且未作废（is_void = FALSE）的行，已写过的不覆盖。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  max: 3,
}

const commit = process.argv.includes('--commit')

function log(msg) {
  console.log(`[BACKFILL-ALLOCATIONS-COMMISSION] ${new Date().toISOString()} ${msg}`)
}

const PREVIEW_SQL = `
SELECT COUNT(*) FILTER (WHERE commission_amount IS NULL) AS null_count,
       COUNT(*)                                          AS total,
       COALESCE(SUM(total_amount::numeric) FILTER (WHERE commission_amount IS NULL), 0) AS null_share_amount
  FROM sale_allocations
 WHERE is_void = FALSE
`

// 订单级 received 合计作 tier 基准；相关子查询取高 tier 优先命中费率；无匹配 → 0。
// 注：UPDATE...FROM 的 LATERAL 不能引用 UPDATE 目标表（sa）—— 改在 rated CTE 内做相关子查询
// （此时 sa 是 CTE 的普通 FROM 表，可被子查询引用），费率只算一次，再按 id JOIN 回写。
const BACKFILL_SQL = `
WITH order_totals AS (
  SELECT sale_order_id, SUM(received::numeric) AS order_total
    FROM sale_items
   GROUP BY sale_order_id
),
rated AS (
  SELECT sa.id,
         sa.total_amount,
         COALESCE((
           SELECT crm.commission_rate
             FROM commission_rate_matrix crm
             JOIN org_nodes n ON n.id = crm.org_id
            WHERE n.name = so.market_name
              AND crm.order_type = '销售单'
              AND crm.role_type = sa.role_type::text
              AND crm.sales_category = si.sales_category::text
              AND crm.amount_tier_min <= ot.order_total
              AND (crm.amount_tier_max IS NULL OR crm.amount_tier_max >= ot.order_total)
            ORDER BY crm.amount_tier_min DESC
            LIMIT 1
         ), 0) AS rate
    FROM sale_allocations sa
    JOIN sale_items si   ON si.sale_item_id  = sa.sale_item_id
    JOIN sale_orders so  ON so.sale_order_id = si.sale_order_id
    JOIN order_totals ot ON ot.sale_order_id = si.sale_order_id
   WHERE sa.is_void = FALSE
     AND sa.commission_amount IS NULL
)
UPDATE sale_allocations sa
   SET commission_rate   = rated.rate,
       commission_amount = ROUND(sa.total_amount::numeric * rated.rate, 2),
       updated_at        = NOW()
  FROM rated
 WHERE rated.id = sa.id
`

const SELFCHECK_SQL = `
SELECT COUNT(*) AS cnt
  FROM sale_allocations
 WHERE commission_amount IS NULL
   AND is_void = FALSE
`

const GROUP_STATS_SQL = `
SELECT CASE WHEN commission_rate > 0 THEN '命中费率(>0)' ELSE '零费率(无配置/未匹配)' END AS bucket,
       COUNT(*) AS cnt,
       COALESCE(SUM(commission_amount::numeric), 0) AS total_commission
  FROM sale_allocations
 WHERE is_void = FALSE
 GROUP BY bucket
 ORDER BY cnt DESC
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: PG_CONNECTION_STRING 或 DATABASE_URL 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${commit ? 'COMMIT（实际写入）' : 'DRY-RUN（仅预览，不写入；加 --commit 才执行 UPDATE）'}`)
  log('提醒: 生产业务库 118.178.196.26:5433/fengyu_wxapp（必跑）；dev 库 101.34.242.103:5433/fengyu_wxapp 先验证。两端均 5433/fengyu_wxapp，仅 IP 区分；务必先 db:migrate 加列、再发读取端代码')

  const pool = new Pool(PG_CONFIG)
  try {
    const preview = await pool.query(PREVIEW_SQL)
    const { null_count, total, null_share_amount } = preview.rows[0]
    log(`未作废分配总行数: ${total}`)
    log(`其中 commission_amount IS NULL 行数: ${null_count}`)
    log(`其中 commission_amount IS NULL 涉及营业额份额: ${null_share_amount}`)

    if (Number(null_count) === 0) {
      log('✓ 无需回填，自检直接通过')
      return
    }

    if (!commit) {
      log('--commit 未指定，跳过 UPDATE。复核以上统计，确认后用 --commit 重新执行')
      return
    }

    const r1 = await pool.query(BACKFILL_SQL)
    log(`回填完成：已写入 ${r1.rowCount} 行 commission_rate + commission_amount`)

    const after = await pool.query(SELFCHECK_SQL)
    const remaining = Number(after.rows[0].cnt)
    if (remaining === 0) {
      log('✓ 自检通过：commission_amount IS NULL AND is_void = FALSE 已清零')
    } else {
      log(`✗ 自检失败：仍有 ${remaining} 行 commission_amount IS NULL（不应发生）`)
      process.exitCode = 1
    }

    const grouped = await pool.query(GROUP_STATS_SQL)
    log('按是否命中费率分组统计（人工核对）:')
    for (const row of grouped.rows) {
      log(`  ${row.bucket} : ${row.cnt} 行，提成合计 ${row.total_commission}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('回填失败:', err)
  process.exit(1)
})
