#!/usr/bin/env node

/**
 * merge-deposit-treatment-cards.js — 已停用的历史合并脚本。
 *
 * 2026-08-11 起，寄存单疗程卡必须逐张写入 sale_items，展示层负责聚合；继续合并会破坏
 * 单张转换能力。本文件仅保留旧实现供审计，禁止执行。历史修复请使用
 * split-deposit-treatment-cards.js。
 *
 * 合并边界：仅 sale_order_type='寄存单'、item_direction='购买'、product_type='疗程卡'，
 * 且仅在同一 sale_order_id + sku_id 内处理。普通销售单、家居产品、跨 SKU/跨订单不受影响。
 *
 * 安全策略：
 * - 主行固定取字典序最小 sale_item_id，汇总 quantity/session_count/remaining_sessions/
 *   paid_sessions/sale_amount/received/pending_received/service_fee。
 * - unit_price、unit_real_price 或每次标价不一致的组跳过，留给人工处理。
 * - paid_sessions 全 NULL 时保持 NULL；全非 NULL 时求和；混合状态视为数据异常并终止。
 * - 仅迁移已结束服务明细、已结束预约，以及 note='寄存单初始化实收' 的回款引用。
 *   活跃服务/预约、营业额分配、库存、提货、衍生销售行或未知 FK 引用都会拒绝该组。
 * - 每个实际合并写一条 operation_logs(action='datafix.mergeDepositTreatmentCards')。
 *
 * 用法：
 *   # 默认 dry-run：事务内完整预检后回滚，不写数据
 *   DATABASE_URL="postgresql://..." node db/scripts/merge-deposit-treatment-cards.js
 *
 *   # 实际提交：先在开发/测试库验证，再由人工明确执行生产库
 *   DATABASE_URL="postgresql://..." node db/scripts/merge-deposit-treatment-cards.js --apply
 *
 * 仅接受显式 DATABASE_URL，避免误用环境中遗留的连接串。
 */

'use strict'

const { Pool } = require('pg')

const APPLY = process.argv.includes('--apply')
const DEPOSIT_RECEIPT_NOTE = '寄存单初始化实收'
const ALLOWED_ORDER_STATUSES = new Set(['待审批', '已支付', '已作废'])
const MAX_EXAMPLES_PER_REASON = 12

// 当前 schema 中所有直接引用 sale_items 的 FK。发现新增引用时必须先补齐迁移策略，不能静默删除。
const EXPECTED_DIRECT_SALE_ITEM_REFS = new Set([
  'appointments.sale_item_id',
  'pickup_records.sale_item_id',
  'sale_allocations.sale_item_id',
  'sale_items.ref_sale_item_id',
  'sale_order_payments.ref_sale_item_id',
  'sale_payment_allocatable_items.sale_item_id',
  'sale_payment_item_receipts.sale_item_id',
  'service_items.sale_item_id',
  'store_inventory_doc_items.sale_item_id',
  'store_inventory_movements.sale_item_id',
])

function log(message) {
  console.log(`[MERGE-DEPOSIT-TREATMENT-CARDS] ${new Date().toISOString()} ${message}`)
}

function redactConnectionString(value) {
  return value.replace(/(\/\/[^:/?#]+:)[^@/]+@/, '$1***@')
}

function canonicalSnapshot(value) {
  if (value === null || value === undefined) return '<NULL>'
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

function toInteger(value, field, saleItemId) {
  const number = Number(value)
  if (!Number.isInteger(number)) {
    throw new Error(`INVALID_INTEGER: ${saleItemId}.${field}=${String(value)}`)
  }
  return number
}

function toCents(value, field, saleItemId) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) {
    throw new Error(`INVALID_MONEY: ${saleItemId}.${field}=${String(value)}`)
  }
  return Math.round(number * 100)
}

function sumInteger(rows, field) {
  return rows.reduce((total, row) => total + toInteger(row[field], field, row.sale_item_id), 0)
}

function sumCents(rows, field) {
  return rows.reduce((total, row) => total + toCents(row[field], field, row.sale_item_id), 0)
}

function centsToSql(cents) {
  return (cents / 100).toFixed(2)
}

function gcd(left, right) {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b !== 0) {
    const next = a % b
    a = b
    b = next
  }
  return a || 1
}

function perSessionPriceSignature(row) {
  const sessionCount = toInteger(row.session_count, 'session_count', row.sale_item_id)
  if (sessionCount <= 0) return null
  const saleAmountCents = toCents(row.sale_amount, 'sale_amount', row.sale_item_id)
  const divisor = gcd(saleAmountCents, sessionCount)
  return `${saleAmountCents / divisor}/${sessionCount / divisor}`
}

function hasSingleValue(rows, field) {
  return new Set(rows.map((row) => canonicalSnapshot(row[field]))).size === 1
}

function buildPlan(rows) {
  if (rows.length < 2) return { skip: 'no_longer_duplicate' }

  const primary = rows[0]
  const saleOrderStatus = primary.order_status
  if (!ALLOWED_ORDER_STATUSES.has(saleOrderStatus)) {
    return { skip: `unsupported_order_status:${saleOrderStatus}` }
  }

  const compatibilityFields = [
    'store_id',
    'item_direction',
    'sku_id',
    'product_name',
    'product_type',
    'sales_category',
    'is_shengmei',
    'is_experience',
    'is_manager_special',
    'expire_date',
    'remark',
  ]
  for (const field of compatibilityFields) {
    if (!hasSingleValue(rows, field)) return { skip: `snapshot_mismatch:${field}` }
  }

  if (rows.some((row) => row.ref_sale_item_id != null)) {
    return { skip: 'source_has_ref_sale_item_id' }
  }
  if (rows.some((row) => Number(row.picked_up_quantity ?? 0) !== 0)) {
    return { skip: 'nonzero_picked_up_quantity' }
  }

  for (const field of ['unit_price', 'unit_real_price']) {
    const prices = new Set(rows.map((row) => toCents(row[field], field, row.sale_item_id)))
    if (prices.size !== 1) return { skip: `price_mismatch:${field}` }
  }
  const perSessionPrices = new Set(rows.map(perSessionPriceSignature))
  if (perSessionPrices.has(null) || perSessionPrices.size !== 1) {
    return { skip: 'price_mismatch:sale_amount_per_session' }
  }

  const paidSessions = rows.map((row) => row.paid_sessions)
  const nullPaidSessions = paidSessions.filter((value) => value == null).length
  if (nullPaidSessions > 0 && nullPaidSessions < paidSessions.length) {
    throw new Error(
      `MIXED_PAID_SESSIONS: ${primary.sale_order_id}/${primary.sku_id} 同组 paid_sessions 同时存在 NULL 与非 NULL`,
    )
  }

  const quantity = sumInteger(rows, 'quantity')
  const sessionCount = sumInteger(rows, 'session_count')
  const remainingSessions = sumInteger(rows, 'remaining_sessions')
  const paidSessionCount = nullPaidSessions === paidSessions.length
    ? null
    : paidSessions.reduce(
      (total, value, index) => total + toInteger(value, 'paid_sessions', rows[index].sale_item_id),
      0,
    )

  if (quantity <= 0 || sessionCount <= 0 || remainingSessions < 0 || remainingSessions > sessionCount) {
    return { skip: 'invalid_session_invariant' }
  }
  if (paidSessionCount != null && (paidSessionCount < 0 || paidSessionCount > sessionCount)) {
    return { skip: 'invalid_paid_sessions_invariant' }
  }
  if (paidSessionCount != null && sessionCount - remainingSessions > paidSessionCount) {
    return { skip: 'paid_sessions_underflow' }
  }

  return {
    primaryId: primary.sale_item_id,
    saleOrderId: primary.sale_order_id,
    skuId: primary.sku_id,
    redundantIds: rows.slice(1).map((row) => row.sale_item_id),
    totals: {
      quantity,
      sessionCount,
      remainingSessions,
      paidSessions: paidSessionCount,
      saleAmount: centsToSql(sumCents(rows, 'sale_amount')),
      received: centsToSql(sumCents(rows, 'received')),
      pendingReceived: centsToSql(sumCents(rows, 'pending_received')),
      serviceFee: centsToSql(sumCents(rows, 'service_fee')),
    },
  }
}

async function assertKnownDirectReferences(client) {
  const { rows } = await client.query(`
    SELECT child.relname AS table_name, attribute.attname AS column_name
    FROM pg_constraint fk_constraint
    JOIN pg_class child ON child.oid = fk_constraint.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk_constraint.confrelid
    JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
    JOIN LATERAL unnest(fk_constraint.conkey) AS key_column(attnum) ON true
    JOIN pg_attribute attribute
      ON attribute.attrelid = fk_constraint.conrelid
     AND attribute.attnum = key_column.attnum
    WHERE fk_constraint.contype = 'f'
      AND child_schema.nspname = 'public'
      AND parent_schema.nspname = 'public'
      AND parent.relname = 'sale_items'
    ORDER BY child.relname, attribute.attname
  `)

  const actual = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
  const unexpected = [...actual].filter((ref) => !EXPECTED_DIRECT_SALE_ITEM_REFS.has(ref))
  const missing = [...EXPECTED_DIRECT_SALE_ITEM_REFS].filter((ref) => !actual.has(ref))
  if (unexpected.length || missing.length) {
    throw new Error(
      `UNEXPECTED_SALE_ITEM_FK: 新增=${unexpected.join(',') || '-'}；缺失=${missing.join(',') || '-'}`,
    )
  }
}

async function assertNoMixedPaidSessions(client) {
  const { rows } = await client.query(`
    SELECT si.sale_order_id, si.sku_id,
           array_agg(si.sale_item_id ORDER BY si.sale_item_id) AS sale_item_ids
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
     WHERE so.sale_order_type = '寄存单'
       AND si.item_direction = '购买'
       AND si.product_type = '疗程卡'
       AND si.sku_id IS NOT NULL
     GROUP BY si.sale_order_id, si.sku_id
    HAVING COUNT(*) > 1
       AND COUNT(*) FILTER (WHERE si.paid_sessions IS NULL) > 0
       AND COUNT(*) FILTER (WHERE si.paid_sessions IS NOT NULL) > 0
     ORDER BY si.sale_order_id, si.sku_id
     LIMIT 20
  `)
  if (rows.length > 0) {
    const examples = rows
      .map((row) => `${row.sale_order_id}/${row.sku_id}(${row.sale_item_ids.join(',')})`)
      .join('; ')
    throw new Error(`MIXED_PAID_SESSIONS: 检测到混合 paid_sessions 组，需人工处理：${examples}`)
  }
}

async function loadCandidateGroups(client) {
  const { rows } = await client.query(`
    SELECT si.sale_order_id, si.sku_id, COUNT(*)::int AS line_count
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
     WHERE so.sale_order_type = '寄存单'
       AND si.item_direction = '购买'
       AND si.product_type = '疗程卡'
       AND si.sku_id IS NOT NULL
     GROUP BY si.sale_order_id, si.sku_id
    HAVING COUNT(*) > 1
     ORDER BY si.sale_order_id, si.sku_id
  `)
  return rows
}

async function lockAndLoadGroup(client, saleOrderId, skuId) {
  const { rows } = await client.query(
    `SELECT si.*, so.status::text AS order_status
       FROM sale_orders so
       JOIN sale_items si ON si.sale_order_id = so.sale_order_id
      WHERE so.sale_order_id = $1
        AND so.sale_order_type = '寄存单'
        AND si.sku_id = $2
        AND si.item_direction = '购买'
        AND si.product_type = '疗程卡'
      ORDER BY si.sale_item_id
      FOR UPDATE OF so, si`,
    [saleOrderId, skuId],
  )
  return rows
}

async function inspectReferences(client, plan) {
  const ids = plan.redundantIds

  const paymentResult = await client.query(
    `SELECT id, change_type::text AS change_type, note
       FROM sale_order_payments
      WHERE ref_sale_item_id = ANY($1::varchar[])
      FOR UPDATE`,
    [ids],
  )
  const unsafePayment = paymentResult.rows.find(
    (row) => row.change_type !== '回款' || row.note !== DEPOSIT_RECEIPT_NOTE,
  )
  if (unsafePayment) {
    return { skip: `unsafe_payment_reference:${unsafePayment.id}` }
  }

  const serviceResult = await client.query(
    `SELECT sit.service_item_id, sit.reserved_at, service_order.status::text AS service_status
       FROM service_items sit
       JOIN service_orders service_order ON service_order.service_order_id = sit.service_order_id
      WHERE sit.sale_item_id = ANY($1::varchar[])
      FOR UPDATE OF sit, service_order`,
    [ids],
  )
  const activeService = serviceResult.rows.find(
    (row) => row.reserved_at != null || ['待服务', '服务中', '待客户确认'].includes(row.service_status),
  )
  if (activeService) {
    return { skip: `active_service_reference:${activeService.service_item_id}` }
  }

  const appointmentResult = await client.query(
    `SELECT appointment_id, status::text AS status
       FROM appointments
      WHERE sale_item_id = ANY($1::varchar[])
      FOR UPDATE`,
    [ids],
  )
  const activeAppointment = appointmentResult.rows.find(
    (row) => ['待确认', '已确认'].includes(row.status),
  )
  if (activeAppointment) {
    return { skip: `active_appointment_reference:${activeAppointment.appointment_id}` }
  }

  const { rows: highRiskRows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sale_items
         WHERE ref_sale_item_id = ANY($1::varchar[])) AS derived_sale_items,
       (SELECT COUNT(*)::int FROM sale_allocations
         WHERE sale_item_id = ANY($1::varchar[])) AS sale_allocations,
       (SELECT COUNT(*)::int FROM sale_payment_allocatable_items
         WHERE sale_item_id = ANY($1::varchar[])) AS payment_allocatables,
       (SELECT COUNT(*)::int FROM sale_payment_item_receipts
         WHERE sale_item_id = ANY($1::varchar[])) AS payment_receipts,
       (SELECT COUNT(*)::int FROM pickup_records
         WHERE sale_item_id = ANY($1::varchar[])) AS pickup_records,
       (SELECT COUNT(*)::int FROM store_inventory_doc_items
         WHERE sale_item_id = ANY($1::varchar[])) AS inventory_doc_items,
       (SELECT COUNT(*)::int FROM store_inventory_movements
         WHERE sale_item_id = ANY($1::varchar[])) AS inventory_movements`,
    [ids],
  )
  const highRisk = highRiskRows[0]
  const conflict = Object.entries(highRisk).find(([, count]) => Number(count) > 0)
  if (conflict) {
    return { skip: `high_risk_reference:${conflict[0]}=${conflict[1]}` }
  }

  return {
    moved: {
      serviceItems: serviceResult.rowCount,
      appointments: appointmentResult.rowCount,
      receiptPayments: paymentResult.rowCount,
    },
  }
}

async function mergeGroup(client, plan, moved) {
  const { primaryId, redundantIds, saleOrderId, skuId, totals } = plan

  if (moved.serviceItems > 0) {
    await client.query(
      `UPDATE service_items
          SET sale_item_id = $1, updated_at = NOW()
        WHERE sale_item_id = ANY($2::varchar[])`,
      [primaryId, redundantIds],
    )
  }
  if (moved.appointments > 0) {
    await client.query(
      `UPDATE appointments
          SET sale_item_id = $1, updated_at = NOW()
        WHERE sale_item_id = ANY($2::varchar[])`,
      [primaryId, redundantIds],
    )
  }
  if (moved.receiptPayments > 0) {
    await client.query(
      `UPDATE sale_order_payments
          SET ref_sale_item_id = $1
        WHERE ref_sale_item_id = ANY($2::varchar[])
          AND change_type = '回款'
          AND note = $3`,
      [primaryId, redundantIds, DEPOSIT_RECEIPT_NOTE],
    )
  }

  const updateResult = await client.query(
    `UPDATE sale_items
        SET quantity = $2,
            session_count = $3,
            remaining_sessions = $4,
            paid_sessions = $5,
            sale_amount = $6::numeric,
            received = $7::numeric,
            pending_received = $8::numeric,
            service_fee = $9::numeric,
            updated_at = NOW()
      WHERE sale_item_id = $1
      RETURNING sale_item_id, quantity, session_count, remaining_sessions, paid_sessions,
                sale_amount::numeric AS sale_amount, received::numeric AS received,
                pending_received::numeric AS pending_received, service_fee::numeric AS service_fee`,
    [
      primaryId,
      totals.quantity,
      totals.sessionCount,
      totals.remainingSessions,
      totals.paidSessions,
      totals.saleAmount,
      totals.received,
      totals.pendingReceived,
      totals.serviceFee,
    ],
  )
  if (updateResult.rowCount !== 1) {
    throw new Error(`UPDATE_PRIMARY_FAILED: ${primaryId}`)
  }

  const updated = updateResult.rows[0]
  const updateMatches = updated.quantity === totals.quantity
    && updated.session_count === totals.sessionCount
    && updated.remaining_sessions === totals.remainingSessions
    && updated.paid_sessions === totals.paidSessions
    && toCents(updated.sale_amount, 'sale_amount', primaryId) === toCents(totals.saleAmount, 'sale_amount', primaryId)
    && toCents(updated.received, 'received', primaryId) === toCents(totals.received, 'received', primaryId)
    && toCents(updated.pending_received, 'pending_received', primaryId) === toCents(totals.pendingReceived, 'pending_received', primaryId)
    && toCents(updated.service_fee, 'service_fee', primaryId) === toCents(totals.serviceFee, 'service_fee', primaryId)
  if (!updateMatches) {
    throw new Error(`UPDATE_PRIMARY_VERIFY_FAILED: ${primaryId}`)
  }

  const deleteResult = await client.query(
    'DELETE FROM sale_items WHERE sale_item_id = ANY($1::varchar[])',
    [redundantIds],
  )
  if (deleteResult.rowCount !== redundantIds.length) {
    throw new Error(`DELETE_REDUNDANT_FAILED: ${saleOrderId}/${skuId}`)
  }

  const detail = JSON.stringify({
    _v: 1,
    skuId,
    primarySaleItemId: primaryId,
    removedSaleItemIds: redundantIds,
    movedReferences: moved,
    totals,
  })
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('datafix.mergeDepositTreatmentCards', 'sale_order', $1, $2::jsonb, 'datafix', NOW())`,
    [saleOrderId, detail],
  )
}

function addSkip(stats, candidate, reason) {
  stats.skipped.set(reason, (stats.skipped.get(reason) || 0) + 1)
  if (stats.examples.length < MAX_EXAMPLES_PER_REASON * 3) {
    stats.examples.push(`${candidate.sale_order_id}/${candidate.sku_id}: ${reason}`)
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('DATABASE_URL="postgresql://..." node db/scripts/merge-deposit-treatment-cards.js [--apply]')
    return
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL 必须显式设置；拒绝使用 PG_CONNECTION_STRING 或默认连接')
  }

  log(`目标库: ${redactConnectionString(connectionString)}`)
  log(`模式: ${APPLY ? 'APPLY（实际写入）' : 'DRY-RUN（默认，事务回滚）'}`)

  const pool = new Pool({ connectionString, max: 3 })
  let client
  try {
    client = await pool.connect()
    await assertKnownDirectReferences(client)
    await assertNoMixedPaidSessions(client)
    const candidates = await loadCandidateGroups(client)
    const candidateRows = candidates.reduce((total, group) => total + Number(group.line_count), 0)
    log(`候选重复组: ${candidates.length} 组 / ${candidateRows} 行`)

    const stats = {
      mergeGroups: 0,
      removedRows: 0,
      movedServiceItems: 0,
      movedAppointments: 0,
      movedReceiptPayments: 0,
      skipped: new Map(),
      examples: [],
    }

    await client.query('BEGIN')
    try {
      for (const candidate of candidates) {
        const rows = await lockAndLoadGroup(client, candidate.sale_order_id, candidate.sku_id)
        let plan
        try {
          plan = buildPlan(rows)
        } catch (error) {
          // paid_sessions 混合会使聚合后的可消费次数不可判定，必须整体退出，不能部分提交。
          throw error
        }
        if (plan.skip) {
          addSkip(stats, candidate, plan.skip)
          continue
        }

        const refs = await inspectReferences(client, plan)
        if (refs.skip) {
          addSkip(stats, candidate, refs.skip)
          continue
        }

        stats.mergeGroups += 1
        stats.removedRows += plan.redundantIds.length
        stats.movedServiceItems += refs.moved.serviceItems
        stats.movedAppointments += refs.moved.appointments
        stats.movedReceiptPayments += refs.moved.receiptPayments

        if (APPLY) {
          await mergeGroup(client, plan, refs.moved)
        }
      }

      log(`可合并: ${stats.mergeGroups} 组，计划删除冗余 sale_items: ${stats.removedRows} 行`)
      log(`引用迁移: service_items=${stats.movedServiceItems}，appointments=${stats.movedAppointments}，寄存初始化回款=${stats.movedReceiptPayments}`)
      if (stats.skipped.size > 0) {
        log(`跳过: ${[...stats.skipped.entries()].map(([reason, count]) => `${reason}=${count}`).join('；')}`)
        for (const example of stats.examples) log(`  跳过样本: ${example}`)
      } else {
        log('跳过: 0 组')
      }

      if (APPLY) {
        await client.query('COMMIT')
        log(`APPLY 完成：已合并 ${stats.mergeGroups} 组，删除 ${stats.removedRows} 行冗余明细，并写入审计日志`)
      } else {
        await client.query('ROLLBACK')
        log('DRY-RUN 已回滚，未写入任何数据。确认统计后使用 --apply 执行。')
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    if (client) client.release()
    await pool.end()
  }
}

console.error('此脚本已停用：寄存单疗程卡必须逐张存储，请改用 split-deposit-treatment-cards.js。')
process.exitCode = 1
