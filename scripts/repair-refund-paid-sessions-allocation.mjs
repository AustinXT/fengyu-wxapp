#!/usr/bin/env node
/**
 * Repair approved-refund side effects for one sale order, or explicitly scan native orders.
 *
 * Default is dry-run: the script opens a transaction, applies the same repair
 * steps, prints before/after summaries, then rolls back. Pass --apply to commit.
 *
 * Usage:
 *   node scripts/repair-refund-paid-sessions-allocation.mjs --order <saleOrderId>
 *   node scripts/repair-refund-paid-sessions-allocation.mjs --order <saleOrderId> --apply
 *   node scripts/repair-refund-paid-sessions-allocation.mjs --scan [--limit N]
 *   node scripts/repair-refund-paid-sessions-allocation.mjs --scan --apply [--limit N]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import pg from 'pg'

const require = createRequire(import.meta.url)
const { Client } = pg
const { recalcPaidSessionsForOrder } = require('../fengyu-staff/cloudfunctions/staffApi/utils/paid-sessions.js')
const { reconcileAllocationStatusAfterRefund } = require('../fengyu-staff/cloudfunctions/staffApi/utils/payment-allocatable.js')

const USAGE = `Usage:
  node scripts/repair-refund-paid-sessions-allocation.mjs --order <saleOrderId>
  node scripts/repair-refund-paid-sessions-allocation.mjs --order <saleOrderId> --apply
  node scripts/repair-refund-paid-sessions-allocation.mjs --scan [--limit N]
  node scripts/repair-refund-paid-sessions-allocation.mjs --scan --apply [--limit N]`

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key && process.env[key] == null) process.env[key] = val
  }
}

function parseArgs(argv) {
  const out = { order: null, scan: false, apply: false, limit: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--scan') out.scan = true
    else if (a === '--limit') {
      const n = Number(argv[++i] || '')
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --limit <N>\n\n${USAGE}`)
      out.limit = n
    }
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length))
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --limit <N>\n\n${USAGE}`)
      out.limit = n
    }
    else if (a === '--order') {
      const order = (argv[++i] || '').trim()
      if (!order || order.startsWith('--')) {
        throw new Error(`Missing required --order <saleOrderId>\n\n${USAGE}`)
      }
      out.order = order
    }
    else if (a.startsWith('--order=')) out.order = a.slice('--order='.length).trim()
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!out.help && !out.order && !out.scan) {
    throw new Error(`Missing required --order <saleOrderId> or explicit --scan\n\n${USAGE}`)
  }
  if (!out.help && out.order && out.scan) {
    throw new Error(`Use either --order or --scan, not both\n\n${USAGE}`)
  }
  return out
}

function parseNote(note) {
  if (!note) return null
  if (typeof note === 'object') return note
  try {
    return JSON.parse(String(note))
  } catch {
    return null
  }
}

function normalizeRefundItems(row) {
  const note = parseNote(row.note)
  if (note && Array.isArray(note.items)) {
    return note.items
      .filter((it) => it && it.refSaleItemId && it.refSaleItemId !== 'OVERPAY')
      .map((it) => ({
        saleItemId: String(it.refSaleItemId),
        refundAmount: Number(it.refundAmount || 0),
      }))
      .filter((it) => it.refundAmount > 0)
  }
  if (row.ref_sale_item_id) {
    return [{ saleItemId: row.ref_sale_item_id, refundAmount: Math.abs(Number(row.amount || 0)) }]
  }
  return []
}

function allocateCents(targetCents, rows) {
  const baseCents = rows.reduce((s, r) => s + Math.round(Number(r.sum_total) * 100), 0)
  if (baseCents <= 0 || targetCents <= 0) return []
  const capped = Math.min(targetCents, baseCents)
  const parts = rows.map((r) => {
    const wCents = Math.round(Number(r.sum_total) * 100)
    const exact = (capped * wCents) / baseCents
    const cents = Math.floor(exact)
    return { r, cents, frac: exact - cents }
  })
  const rem = capped - parts.reduce((s, p) => s + p.cents, 0)
  parts.sort((a, b) => b.frac - a.frac)
  for (let i = 0; i < rem; i += 1) parts[i].cents += 1
  return parts.filter((p) => p.cents > 0)
}

async function snapshot(client, orderId) {
  const order = await client.query(
    `SELECT sale_order_id, status, sale_order_type, legacy_source, received, refunded_amount, allocation_status
       FROM sale_orders WHERE sale_order_id = $1`,
    [orderId],
  )
  const payments = await client.query(
    `SELECT id, change_type, amount, status, allocation_status, paid_at
       FROM sale_order_payments
      WHERE sale_order_id = $1
      ORDER BY id`,
    [orderId],
  )
  const items = await client.query(
    `SELECT sale_item_id, product_name, product_type, sale_amount, received,
            session_count, remaining_sessions, paid_sessions
       FROM sale_items
      WHERE sale_order_id = $1 AND item_direction = '购买'
      ORDER BY sale_item_id`,
    [orderId],
  )
  const allocations = await client.query(
    `SELECT sa.sale_payment_id, sa.sale_item_id,
            SUM(sa.total_amount::numeric) FILTER (WHERE sa.total_amount::numeric > 0 AND sa.is_void = false) AS positive_total,
            SUM(sa.total_amount::numeric) FILTER (WHERE sa.total_amount::numeric < 0 AND sa.is_void = false) AS negative_total,
            SUM(sa.total_amount::numeric) FILTER (WHERE sa.is_void = false) AS net_total,
            COUNT(*) FILTER (WHERE sa.total_amount::numeric < 0 AND sa.is_void = false) AS negative_rows
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      WHERE si.sale_order_id = $1
      GROUP BY sa.sale_payment_id, sa.sale_item_id
      ORDER BY sa.sale_payment_id NULLS LAST, sa.sale_item_id`,
    [orderId],
  )
  return {
    order: order.rows[0] || null,
    payments: payments.rows,
    items: items.rows,
    allocations: allocations.rows,
  }
}

async function backfillNegativeAllocations(client, orderId) {
  const refunds = await client.query(
    `SELECT id, amount, note, refund_reason, ref_sale_item_id, session_count
       FROM sale_order_payments
      WHERE sale_order_id = $1
        AND change_type = '退款'
        AND status = '已支付'
      ORDER BY id`,
    [orderId],
  )

  const stats = {
    insertedNegativeAllocations: 0,
    touchedRefundSpaiItems: 0,
    refundPaymentsMarkedAllocated: 0,
    skippedNoPositiveAllocation: 0,
    skippedNoRemainingAllocation: 0,
  }
  for (const refund of refunds.rows) {
    let refundAllocatableCents = 0
    for (const item of normalizeRefundItems(refund)) {
      const allocRows = await client.query(
        `WITH grouped AS (
           SELECT employee_id, role_type,
                  MAX(allocation_ratio) AS ratio,
                  MAX(department_name) AS dept,
                  SUM(total_amount::numeric) AS sum_total,
                  MAX(commission_rate) AS rate,
                  COALESCE(SUM(commission_amount::numeric), 0) AS sum_comm
             FROM sale_allocations
            WHERE sale_item_id = $1 AND is_void = false AND total_amount > 0
            GROUP BY employee_id, role_type
         ),
         totals AS (
           SELECT COALESCE(SUM(total_amount::numeric) FILTER (WHERE total_amount > 0), 0) AS positive_total,
                  COALESCE(ABS(SUM(total_amount::numeric) FILTER (WHERE total_amount < 0 AND sale_payment_id IS DISTINCT FROM $2)), 0) AS other_negative_total
             FROM sale_allocations
            WHERE sale_item_id = $1 AND is_void = false
         )
         SELECT grouped.*, totals.positive_total, totals.other_negative_total
           FROM grouped CROSS JOIN totals`,
        [item.saleItemId, refund.id],
      )
      if (allocRows.rows.length === 0) {
        stats.skippedNoPositiveAllocation += 1
        continue
      }
      const positiveCents = Math.round(Number(allocRows.rows[0].positive_total || 0) * 100)
      const otherNegativeCents = Math.round(Number(allocRows.rows[0].other_negative_total || 0) * 100)
      const remainingCents = Math.max(0, positiveCents - otherNegativeCents)
      const targetCents = Math.min(Math.round(item.refundAmount * 100), remainingCents)
      if (targetCents <= 0) {
        stats.skippedNoRemainingAllocation += 1
      } else {
        const parts = allocateCents(targetCents, allocRows.rows)
        for (const p of parts) {
          const voidTotal = p.cents / 100
          const sumTotal = Number(p.r.sum_total)
          const sumComm = Number(p.r.sum_comm || 0)
          const voidComm = sumTotal > 0 ? Math.round((sumComm * voidTotal) / sumTotal * 100) / 100 : 0
          const res = await client.query(
            `INSERT INTO sale_allocations
               (sale_item_id, employee_id, role_type, department_name, allocation_ratio,
                total_amount, commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW(), NOW())
             ON CONFLICT (sale_item_id, employee_id, role_type, sale_payment_id) WHERE is_void = false DO NOTHING
             RETURNING id`,
            [
              item.saleItemId,
              p.r.employee_id,
              p.r.role_type,
              p.r.dept,
              p.r.ratio,
              (-voidTotal).toFixed(2),
              p.r.rate,
              (-voidComm).toFixed(2),
              refund.id,
            ],
          )
          stats.insertedNegativeAllocations += res.rowCount || 0
        }
      }
      const currentRefundAlloc = await client.query(
        `SELECT COALESCE(ABS(SUM(sa.total_amount::numeric)), 0) AS refund_allocated,
                MAX(si.sales_category) AS sales_category
           FROM sale_allocations sa
           JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
          WHERE sa.sale_payment_id = $1
            AND sa.sale_item_id = $2
            AND sa.is_void = false
            AND sa.total_amount < 0`,
        [refund.id, item.saleItemId],
      )
      const allocatedCents = Math.round(Number(currentRefundAlloc.rows[0]?.refund_allocated || 0) * 100)
      if (allocatedCents > 0) {
        await client.query(
          `INSERT INTO sale_payment_allocatable_items
             (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (sale_payment_id, sale_item_id)
           DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category`,
          [refund.id, orderId, item.saleItemId, (allocatedCents / 100).toFixed(2), currentRefundAlloc.rows[0]?.sales_category || null],
        )
        refundAllocatableCents += allocatedCents
        stats.touchedRefundSpaiItems += 1
      }
    }
    if (refundAllocatableCents > 0) {
      const statusRes = await client.query(
        `UPDATE sale_order_payments
            SET allocation_status = '已分配'
          WHERE id = $1
            AND change_type = '退款'
            AND allocation_status IS DISTINCT FROM '已分配'`,
        [refund.id],
      )
      stats.refundPaymentsMarkedAllocated += statusRes.rowCount || 0
    }
  }
  return stats
}

async function findScanOrders(client, limit) {
  const params = []
  const limitSql = limit ? `LIMIT $1` : ''
  if (limit) params.push(limit)
  const res = await client.query(
    `SELECT DISTINCT so.sale_order_id
       FROM sale_orders so
       JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
      WHERE so.sale_order_type = '销售单'
        AND so.legacy_source IS DISTINCT FROM 'workfine'
        AND sop.change_type = '退款'
        AND sop.status = '已支付'
      ORDER BY so.sale_order_id
      ${limitSql}`,
    params,
  )
  return res.rows.map((r) => r.sale_order_id)
}

function compactSnapshot(s) {
  const negativeRows = s.allocations.reduce((sum, r) => sum + Number(r.negative_rows || 0), 0)
  const negativeTotal = s.allocations.reduce((sum, r) => sum + Number(r.negative_total || 0), 0)
  const refundPaymentsAllocated = s.payments.filter((p) => p.change_type === '退款' && p.allocation_status === '已分配').length
  const zeroAmountPaidSessions = s.items
    .filter((i) => Number(i.sale_amount) <= 0 && i.session_count != null)
    .map((i) => ({ saleItemId: i.sale_item_id, paidSessions: i.paid_sessions }))
  return {
    orderId: s.order?.sale_order_id ?? null,
    status: s.order?.status ?? null,
    saleOrderType: s.order?.sale_order_type ?? null,
    legacySource: s.order?.legacy_source ?? null,
    refundPaymentsAllocated,
    negativeRows,
    negativeTotal: Math.round(negativeTotal * 100) / 100,
    zeroAmountPaidSessions,
  }
}

async function repairOneOrder(client, orderId, { apply, includeFullSnapshot }) {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`repair-refund:${orderId}`])
    const before = await snapshot(client, orderId)
    if (!before.order) throw new Error(`Order not found: ${orderId}`)

    if (before.order.legacy_source === 'workfine') {
      const output = {
        mode: apply ? 'apply' : 'dry-run',
        orderId,
        skipped: true,
        reason: 'legacy_source=workfine',
        before: includeFullSnapshot ? before : compactSnapshot(before),
      }
      await client.query('ROLLBACK')
      return output
    }

    const allocationRepair = await backfillNegativeAllocations(client, orderId)
    await recalcPaidSessionsForOrder(client, orderId)
    await reconcileAllocationStatusAfterRefund(client, orderId)

    const after = await snapshot(client, orderId)
    const output = {
      mode: apply ? 'apply' : 'dry-run',
      orderId,
      allocationRepair,
      before: includeFullSnapshot ? before : compactSnapshot(before),
      after: includeFullSnapshot ? after : compactSnapshot(after),
    }

    if (apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    return output
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  for (const file of [
    '.env',
    '.env.local',
    'fengyu-admin/.env',
    'fengyu-admin/.env.local',
    'fengyu-staff/cloudfunctions/staffApi/.env',
  ]) {
    loadEnvFile(path.resolve(process.cwd(), file))
  }

  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION_STRING ||
    process.env.POSTGRES_CONNECTION_STRING
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL/POSTGRES_URL/PG_CONNECTION_STRING')
  }

  const client = new Client({ connectionString })
  await client.connect()
  try {
    const orderIds = args.scan ? await findScanOrders(client, args.limit) : [args.order]
    const results = []
    for (const orderId of orderIds) {
      try {
        results.push(await repairOneOrder(client, orderId, {
          apply: args.apply,
          includeFullSnapshot: !args.scan,
        }))
      } catch (err) {
        results.push({
          mode: args.apply ? 'apply' : 'dry-run',
          orderId,
          error: err?.stack || err?.message || String(err),
        })
      }
    }
    const output = args.scan
      ? {
          mode: args.apply ? 'apply' : 'dry-run',
          scan: true,
          limit: args.limit,
          totalOrders: orderIds.length,
          erroredOrders: results.filter((r) => r.error).length,
          totals: results.reduce((acc, r) => {
            const s = r.allocationRepair
            if (!s) return acc
            acc.insertedNegativeAllocations += s.insertedNegativeAllocations || 0
            acc.touchedRefundSpaiItems += s.touchedRefundSpaiItems || 0
            acc.refundPaymentsMarkedAllocated += s.refundPaymentsMarkedAllocated || 0
            acc.skippedNoPositiveAllocation += s.skippedNoPositiveAllocation || 0
            acc.skippedNoRemainingAllocation += s.skippedNoRemainingAllocation || 0
            return acc
          }, {
            insertedNegativeAllocations: 0,
            touchedRefundSpaiItems: 0,
            refundPaymentsMarkedAllocated: 0,
            skippedNoPositiveAllocation: 0,
            skippedNoRemainingAllocation: 0,
          }),
          results,
        }
      : results[0]
    console.log(JSON.stringify(output, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
