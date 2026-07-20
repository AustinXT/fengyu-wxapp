#!/usr/bin/env node

/**
 * audit-treatment-card-listing.js — 疗程卡列表缺卡排查（read-only）
 *
 * 背景：notes/tickets/2026-05-18-treatment-card-listing-filter-audit.md
 *   张凯打开转换单时发现「疗程卡管理」列表（admin /cards）漏卡。
 *   本脚本跑 5 个普查 + 输出对账 CSV，用来定位走 §2-A / §2-C 哪条修复路径。
 *
 * 已排除（不再普查）：
 *   - H4-a store_id NULL —— migration 0002 已 NOT NULL，结构上不可能
 *   - sale_order_type 5 值 —— enums.ts 现为 3 值（销售单/内部单/转换单）
 *
 * 仍需普查：
 *   H1  product_type 错填 / NULL
 *   H2  item_direction 非「购买」
 *   H3  remaining_sessions 漏写
 *   X1  /cards 与 转换单选卡器 候选差集（对账用）
 *   X2  store 维度分布（辅助 scope 决策）
 *
 * 用法：
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/audit-treatment-card-listing.js
 *
 *   # 自定义 store_id 看转换器差集（默认空 = 跳过 X1）
 *   AUDIT_STORE_ID=STORE_xxx node db/scripts/audit-treatment-card-listing.js
 *
 * 产出：
 *   - stdout 打印 5 个查询结果
 *   - db/scripts/.out/audit-treatment-card-listing-YYYYMMDD.csv（差集明细）
 */

const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const STORE_ID = process.env.AUDIT_STORE_ID || null

function log(msg) {
  console.log(`[AUDIT-CARDS] ${new Date().toISOString()} ${msg}`)
}

function printTable(rows) {
  if (!rows.length) {
    console.log('  (empty)')
    return
  }
  console.table(rows)
}

const Q_H1 = `
SELECT COALESCE(product_type::text, '<NULL>') AS product_type, COUNT(*) AS cnt
  FROM sale_items
 WHERE remaining_sessions IS NOT NULL
 GROUP BY 1
 ORDER BY cnt DESC
`

const Q_H2 = `
SELECT item_direction::text AS item_direction, COUNT(*) AS cnt
  FROM sale_items
 WHERE product_type = '疗程卡'
 GROUP BY 1
 ORDER BY cnt DESC
`

const Q_H3 = `
SELECT COUNT(*) AS missing_sessions
  FROM sale_items
 WHERE product_type = '疗程卡'
   AND item_direction = '购买'
   AND remaining_sessions IS NULL
`

const Q_X2_STORE_DIST = `
SELECT store_id, COUNT(*) AS cnt
  FROM sale_items
 WHERE product_type = '疗程卡'
   AND item_direction = '购买'
 GROUP BY 1
 ORDER BY cnt DESC
 LIMIT 30
`

/**
 * X1: /cards 候选 vs 转换器候选差集。
 *
 *   /cards (admin)              : itemDirection='购买' AND productType='疗程卡' AND remainingSessions IS NOT NULL
 *   converter (getCustomerHeldCards) : 上述 + remainingSessions > 0 + saleOrders.status IN ('已支付','已完成')
 *                                       + storeId = $STORE_ID
 *
 * 输出：在 /cards 出现但在 converter 排除的卡（仅给定 store_id 下的对账）。
 * 字段：sale_item_id / sale_order_id / store_id / product_type / item_direction /
 *      remaining_sessions / sale_order_status / client_user_id / paid_at / 排除原因
 */
const Q_X1_DIFF = `
SELECT
  si.sale_item_id,
  si.sale_order_id,
  si.store_id,
  si.product_type::text AS product_type,
  si.item_direction::text AS item_direction,
  si.remaining_sessions,
  so.status::text AS sale_order_status,
  so.client_user_id,
  so.paid_at,
  CASE
    WHEN COALESCE(si.remaining_sessions, 0) <= 0 THEN 'remaining_sessions<=0'
    WHEN so.status NOT IN ('已支付', '已完成') THEN 'order_status=' || so.status::text
    ELSE 'other'
  END AS reason_excluded
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE si.product_type = '疗程卡'
  AND si.item_direction = '购买'
  AND si.remaining_sessions IS NOT NULL
  AND si.store_id = $1
  AND (
    COALESCE(si.remaining_sessions, 0) <= 0
    OR so.status NOT IN ('已支付', '已完成')
  )
ORDER BY so.paid_at DESC NULLS LAST
`

function writeCsv(rows, outPath) {
  if (!rows.length) {
    fs.writeFileSync(outPath, '(no rows)\n')
    return
  }
  const headers = Object.keys(rows[0])
  const escape = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ]
  fs.writeFileSync(outPath, lines.join('\n') + '\n')
}

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`AUDIT_STORE_ID: ${STORE_ID || '(未设置 — 跳过 X1 差集)'}`)

  const outDir = path.join(__dirname, '.out')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  const pool = new Pool(PG_CONFIG)
  try {
    log('--- H1: product_type 分布（仅含 remaining_sessions 的行）---')
    const h1 = await pool.query(Q_H1)
    printTable(h1.rows)

    log('--- H2: 疗程卡的 item_direction 分布 ---')
    const h2 = await pool.query(Q_H2)
    printTable(h2.rows)

    log('--- H3: 疗程卡购买行 remaining_sessions 漏写计数 ---')
    const h3 = await pool.query(Q_H3)
    const missing = Number(h3.rows[0].missing_sessions)
    console.log(`  missing_sessions = ${missing}`)
    if (missing > 0) {
      log(`  ✗ H3 命中：${missing} 行疗程卡购买行 remaining_sessions 为 NULL`)
    } else {
      log(`  ✓ H3 通过：无漏写`)
    }

    log('--- X2: 疗程卡按门店分布 TOP 30 ---')
    const x2 = await pool.query(Q_X2_STORE_DIST)
    printTable(x2.rows)

    if (STORE_ID) {
      log(`--- X1: /cards vs 转换器候选差集 @store=${STORE_ID} ---`)
      const x1 = await pool.query(Q_X1_DIFF, [STORE_ID])
      console.log(`  差集行数: ${x1.rows.length}`)
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const csvPath = path.join(outDir, `audit-treatment-card-listing-${stamp}.csv`)
      writeCsv(x1.rows, csvPath)
      log(`  CSV 写入: ${csvPath}`)
      if (x1.rows.length) {
        console.log('  前 10 行预览：')
        printTable(x1.rows.slice(0, 10))
      }
    } else {
      log('--- X1: 跳过（未设置 AUDIT_STORE_ID） ---')
    }

    log('---')
    log('Decision Gate（依结果选 Step 2 分支）：')
    log(`  · H1 出现非「疗程卡」/<NULL> 行 → §2-A 写入侧 bug + 回填`)
    log(`  · H2 出现 转出/转入/退出 且数量 ≠ 预期 → 排查 convert/refund 流程`)
    log(`  · H3 missing_sessions > 0 → §2-A 回填 remaining_sessions`)
    log(`  · X1 全部 reason_excluded 均符合业务（已核销/未支付）→ §2-C 文档化即可`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('普查失败:', err)
  process.exit(1)
})
