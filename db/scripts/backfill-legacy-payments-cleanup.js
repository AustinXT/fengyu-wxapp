#!/usr/bin/env node

/**
 * backfill-legacy-payments-cleanup.js — 一次性清理历史订单审核时补登的
 * sale_order_payments「首次支付」流水（note='历史订单核对通过补登'）。
 *
 * 背景：
 *   2026-07-13 起 approveLegacyOrder / batchApproveLegacyOrders 在审核历史单时
 *   补登一条「首次支付」流水维持资金不变量 I1。新口径下历史单定位为「只记录
 *   消费痕迹」（门店+时间+实付金额），不应有任何支付流水——received 直接等于
 *   旧系统实收（UDF_S_507 = total_amount），sale_order_payments 留空。资金不变量
 *   I1 已对 legacy_source='workfine' 豁免（见 audit-payment-invariants.ts）。
 *   本脚本清理存量已审核历史单的补登流水。
 *
 * 选行口径：
 *   sale_order_payments.note = '历史订单核对通过补登'
 *   （该 note 仅由 legacy-orders.ts 审核逻辑产生，全仓唯一，定位精确安全）
 *
 * 安全性：
 *   - 只删 note='历史订单核对通过补登' 的行，不影响任何其它支付流水。
 *   - DELETE 额外限定 sale_order_id 属于 legacy_source='workfine' 的单，双保险防误伤。
 *   - sale_order_payments 是流水叶子表，无下游表 FK 引用其 id，DELETE 安全。
 *   - 删除后历史单 received 仍 = total_amount（审核时 UPDATE 设的），不受影响。
 *   - 会员等级/消费档位重算读 sale_orders.total_amount，不读 payments，不受影响。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-legacy-payments-cleanup.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-legacy-payments-cleanup.js --apply
 *
 * 顺序：先 dev(47.113.202.7:5433) --apply 验证；再 prod(118.178.196.26:5433) --apply。
 * 永远显式传 DATABASE_URL。两个库同名同端口，仅靠 IP 区分，执行前核对连接串 IP。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-LEGACY-PAYMENTS] ${new Date().toISOString()} ${msg}`)
}

const WHERE_NOTE = `note = '历史订单核对通过补登'`

const PREVIEW_SQL = `
SELECT COUNT(*)::int AS total_rows
FROM sale_order_payments
WHERE ${WHERE_NOTE}
`

const SAMPLE_SQL = `
SELECT sop.id, sop.sale_order_id, sop.change_type, sop.amount, sop.status, sop.paid_at,
       so.legacy_source, so.sale_order_type, so.received, so.total_amount
FROM sale_order_payments sop
JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
WHERE sop.${WHERE_NOTE}
ORDER BY sop.sale_order_id
LIMIT 20
`

// 双保险：note 已是唯一标记，再加 legacy_source='workfine' 校验，防任何同名 note 误伤。
const DELETE_SQL = `
DELETE FROM sale_order_payments
WHERE ${WHERE_NOTE}
  AND sale_order_id IN (
    SELECT sale_order_id FROM sale_orders WHERE legacy_source = 'workfine'
  )
RETURNING id, sale_order_id, amount
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${apply ? 'APPLY（实际写入）' : 'DRY-RUN（默认；加 --apply 提交）'}`)

  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const preview = await client.query(PREVIEW_SQL)
    const total = preview.rows[0].total_rows
    log(`note='历史订单核对通过补登' 的 payments 行：${total} 行`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（前 20 行：id | sale_order_id | change_type | amount | status | paid_at | legacy_source | type | received/total）:')
      for (const r of sample.rows) {
        log(
          `  ${r.id} | ${r.sale_order_id} | ${r.change_type} | ${r.amount} | ${r.status} | ${r.paid_at} | ${r.legacy_source} | ${r.sale_order_type} | ${r.received}/${r.total_amount}`,
        )
      }
    } else if (total === 0) {
      log('无待清理行（口径已符合，或尚未有历史单被审核过）。')
    }

    if (apply) {
      const del = await client.query(DELETE_SQL)
      log(
        `APPLY：删除 ${del.rowCount} 行 sale_order_payments（note='历史订单核对通过补登' 且属 legacy 单）`,
      )
      await client.query('COMMIT')
      log('事务已提交')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN：已回滚，未写入。加 --apply 提交。')
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (_) {}
    console.error('FATAL:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
