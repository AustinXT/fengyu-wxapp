#!/usr/bin/env node

/**
 * 将历史转换单的聚合转入疗程卡拆为 quantity=1 的独立权益卡。
 *
 * 默认只审计；--exercise 在单事务内完整执行并回滚；--apply 才会提交。
 * 原 sale_item_id 保留为第一张卡，克隆卡使用确定性 ID，所有实体卡共享
 * sale_item_group_id=原 sale_item_id。服务记录、服务提成、款项子项实收和
 * 营业额分配会随实体卡一起拆分，且提交前校验次数和金额守恒。
 *
 * 用法：
 *   DATABASE_URL='postgresql://...' node db/scripts/split-conversion-treatment-cards.js
 *   DATABASE_URL='postgresql://...' node db/scripts/split-conversion-treatment-cards.js --exercise
 *   DATABASE_URL='postgresql://...' node db/scripts/split-conversion-treatment-cards.js --apply
 */

'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { buildTreatmentCardAllocationPlan } = require('./split-deposit-treatment-cards')

const APPLY = process.argv.includes('--apply')
const EXERCISE = process.argv.includes('--exercise')
const EXPECTED_DIRECT_REFS = new Set([
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
  console.log(`[SPLIT-CONVERSION-CARDS] ${message}`)
}

function redactConnectionString(value) {
  return value.replace(/(\/\/[^:/?#]+:)[^@/]+@/, '$1***@')
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`)
  return value
}

function parseTargetIds(args) {
  const ids = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--sale-item-id') continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('--sale-item-id 缺少值')
    ids.push(value)
    index++
  }
  return [...new Set(ids)]
}

function int(value, field, id) {
  const result = Number(value)
  if (!Number.isInteger(result)) throw new Error(`INVALID_INTEGER: ${id}.${field}=${String(value)}`)
  return result
}

function money(value, field, id) {
  const result = Number(value ?? 0)
  if (!Number.isFinite(result)) throw new Error(`INVALID_MONEY: ${id}.${field}=${String(value)}`)
  return Math.round(result * 100)
}

function sqlMoney(cents) {
  return (cents / 100).toFixed(2)
}

function splitCents(total, count) {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`INVALID_SPLIT_COUNT: ${count}`)
  const sign = total < 0 ? -1 : 1
  const absolute = Math.abs(total)
  const each = Math.trunc(absolute / count)
  const remainder = absolute % count
  return Array.from({ length: count }, (_unused, index) =>
    sign * (each + (index === count - 1 ? remainder : 0)))
}

function splitCapacity(total, capacity, count) {
  const result = []
  let remaining = total
  for (let index = 0; index < count; index++) {
    const value = Math.min(capacity, Math.max(0, remaining))
    result.push(value)
    remaining -= value
  }
  if (remaining !== 0) throw new Error(`CAPACITY_OVERFLOW: total=${total}, capacity=${capacity}, count=${count}`)
  return result
}

function proportionalCents(total, weights) {
  const denominator = weights.reduce((sum, value) => sum + Math.abs(value), 0)
  if (denominator === 0) return splitCents(total, weights.length)
  const sign = total < 0 ? -1 : 1
  const absolute = Math.abs(total)
  let assigned = 0
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return sign * (absolute - assigned)
    const value = Math.floor((absolute * Math.abs(weight)) / denominator)
    assigned += value
    return sign * value
  })
}

function generatedSaleItemId(sourceId, index) {
  const hash = createHash('sha1').update(`conversion:${sourceId}`).digest('hex').slice(0, 20).toUpperCase()
  return `CV-${hash}-${String(index + 1).padStart(3, '0')}`
}

function generatedServiceItemId(sourceId, index) {
  const hash = createHash('sha1').update(`conversion-service:${sourceId}`).digest('hex').slice(0, 20)
  return `cvsi_${hash}_${index + 1}`
}

async function assertSchema(client) {
  const { rows } = await client.query(
    `SELECT child.relname AS table_name, attribute.attname AS column_name
       FROM pg_constraint fk
       JOIN pg_class child ON child.oid = fk.conrelid
       JOIN pg_namespace ns ON ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = fk.confrelid
       JOIN LATERAL unnest(fk.conkey) AS key_column(attnum) ON true
       JOIN pg_attribute attribute ON attribute.attrelid = fk.conrelid AND attribute.attnum = key_column.attnum
      WHERE fk.contype = 'f' AND ns.nspname = 'public' AND parent.relname = 'sale_items'
      ORDER BY child.relname, attribute.attname`,
  )
  const actual = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
  const unexpected = [...actual].filter((item) => !EXPECTED_DIRECT_REFS.has(item))
  const missing = [...EXPECTED_DIRECT_REFS].filter((item) => !actual.has(item))
  if (unexpected.length || missing.length) {
    throw new Error(`SALE_ITEM_FK_CHANGED: 新增=${unexpected.join(',') || '-'}；缺失=${missing.join(',') || '-'}`)
  }
}

async function candidateIds(client, targetIds) {
  if (targetIds.length > 0) return targetIds
  const { rows } = await client.query(
    `SELECT si.sale_item_id
       FROM sale_items si
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE so.sale_order_type = '转换单'
        AND si.item_direction = '转入'
        AND si.product_type = '疗程卡'
        AND si.quantity > 1
      ORDER BY si.sale_order_id, si.sale_item_id`,
  )
  return rows.map((row) => row.sale_item_id)
}

async function inspect(client, saleItemId) {
  const { rows: sourceRows } = await client.query(
    `SELECT si.*, so.sale_order_type::text, so.status::text AS order_status
       FROM sale_items si
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE si.sale_item_id = $1
      FOR UPDATE OF si`,
    [saleItemId],
  )
  const source = sourceRows[0]
  if (!source) throw new Error(`${saleItemId}: 明细不存在`)
  if (source.sale_order_type !== '转换单' || source.item_direction !== '转入' || source.product_type !== '疗程卡') {
    throw new Error(`${saleItemId}: 不是转换单转入疗程卡`)
  }

  const quantity = int(source.quantity, 'quantity', saleItemId)
  if (quantity <= 1) throw new Error(`${saleItemId}: 已是单卡明细`)
  const totalSessions = int(source.session_count, 'session_count', saleItemId)
  const remainingSessions = int(source.remaining_sessions, 'remaining_sessions', saleItemId)
  if (totalSessions <= 0 || totalSessions % quantity !== 0) {
    throw new Error(`${saleItemId}: 总次数 ${totalSessions} 不能按 ${quantity} 张拆分`)
  }
  if (remainingSessions < 0 || remainingSessions > totalSessions) {
    throw new Error(`${saleItemId}: remaining_sessions 越界`)
  }
  const perCardSessions = totalSessions / quantity
  if (source.paid_sessions != null) {
    const paid = int(source.paid_sessions, 'paid_sessions', saleItemId)
    if (paid < 0 || paid > totalSessions) throw new Error(`${saleItemId}: paid_sessions 越界`)
  }

  const { rows: refCountsRows } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM appointments WHERE sale_item_id = $1) AS appointments,
       (SELECT count(*)::int FROM pickup_records WHERE sale_item_id = $1) AS pickups,
       (SELECT count(*)::int FROM sale_allocations WHERE sale_item_id = $1) AS allocations,
       (SELECT count(*)::int FROM sale_items WHERE ref_sale_item_id = $1) AS child_items,
       (SELECT count(*)::int FROM sale_order_payments WHERE ref_sale_item_id = $1) AS directed_payments,
       (SELECT count(*)::int FROM sale_payment_allocatable_items WHERE sale_item_id = $1) AS allocatables,
       (SELECT count(*)::int FROM store_inventory_doc_items WHERE sale_item_id = $1) AS inventory_doc_items,
       (SELECT count(*)::int FROM store_inventory_movements WHERE sale_item_id = $1) AS inventory_movements`,
    [saleItemId],
  )
  const unsupported = Object.entries(refCountsRows[0]).find(([, count]) => Number(count) > 0)
  if (unsupported) throw new Error(`${saleItemId}: 未支持关联 ${unsupported[0]}=${unsupported[1]}`)

  const { rows: services } = await client.query(
    `SELECT sit.*, so.status::text AS service_status, so.completed_at AS service_completed_at
       FROM service_items sit
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE sit.sale_item_id = $1
      ORDER BY sit.service_item_id
      FOR UPDATE OF sit`,
    [saleItemId],
  )
  const serviceIds = services.map((row) => row.service_item_id)
  const { rows: commissions } = serviceIds.length === 0 ? { rows: [] } : await client.query(
    `SELECT * FROM service_commissions WHERE service_item_id = ANY($1) ORDER BY id FOR UPDATE`,
    [serviceIds],
  )
  const { rows: receipts } = await client.query(
    `SELECT * FROM sale_payment_item_receipts WHERE sale_item_id = $1 ORDER BY id FOR UPDATE`,
    [saleItemId],
  )
  const receiptIds = receipts.map((row) => row.id)
  const { rows: receiptAllocations } = receiptIds.length === 0 ? { rows: [] } : await client.query(
    `SELECT * FROM sale_payment_item_allocations
      WHERE sale_payment_item_receipt_id = ANY($1)
      ORDER BY id FOR UPDATE`,
    [receiptIds],
  )

  const inspected = {
    ok: true,
    source,
    quantity,
    perCardSessions,
    services,
    children: [],
    commissions,
    receipts,
    receiptAllocations,
  }
  buildTreatmentCardAllocationPlan(inspected, Array.from({ length: quantity }, (_unused, index) => `preview-${index}`))
  return inspected
}

async function insertSaleItem(client, source, values) {
  await client.query(
    `INSERT INTO sale_items (
       sale_item_id, sale_item_group_id, sale_order_id, store_id, item_direction, ref_sale_item_id, sku_id,
       product_name, product_type, session_count, remaining_sessions, paid_sessions,
       unit_price, quantity, unit_real_price, sale_amount, received, pending_received,
       expire_date, picked_up_quantity, remark, sales_category, service_fee,
       is_shengmei, is_experience, is_manager_special, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15::numeric,$16::numeric,$17::numeric,
       $18,0,$19,$20,$21::numeric,$22,$23,$24,$25,$26
     )`,
    [
      values.saleItemId, values.groupId, source.sale_order_id, source.store_id, source.item_direction,
      source.ref_sale_item_id, source.sku_id, source.product_name, source.product_type,
      values.sessionCount, values.remainingSessions, values.paidSessions,
      source.unit_price, source.unit_real_price, sqlMoney(values.saleAmount), sqlMoney(values.received),
      sqlMoney(values.pendingReceived), source.expire_date, source.remark, source.sales_category,
      sqlMoney(values.serviceFee), source.is_shengmei, source.is_experience, source.is_manager_special,
      source.created_at, source.updated_at,
    ],
  )
}

async function updateSourceSaleItem(client, source, values) {
  await client.query(
    `UPDATE sale_items
        SET sale_item_group_id = $2, session_count = $3, remaining_sessions = $4,
            paid_sessions = $5, quantity = 1, sale_amount = $6::numeric,
            received = $7::numeric, pending_received = $8::numeric,
            service_fee = $9::numeric, updated_at = NOW()
      WHERE sale_item_id = $1`,
    [source.sale_item_id, values.groupId, values.sessionCount, values.remainingSessions,
      values.paidSessions, sqlMoney(values.saleAmount), sqlMoney(values.received),
      sqlMoney(values.pendingReceived), sqlMoney(values.serviceFee)],
  )
}

async function splitServiceCommissions(client, inspected, service, cloneIds, chunkSizes) {
  const rows = inspected.commissions.filter((row) => row.service_item_id === service.service_item_id)
  const totalUsage = chunkSizes.reduce((sum, value) => sum + value, 0)
  for (const commission of rows) {
    const fixedParts = proportionalCents(money(commission.fixed_fee, 'fixed_fee', commission.id), chunkSizes)
    const consumeParts = proportionalCents(money(commission.consume_amount, 'consume_amount', commission.id), chunkSizes)
    const amountParts = proportionalCents(money(commission.commission_amount, 'commission_amount', commission.id), chunkSizes)
    await client.query(
      `UPDATE service_commissions
          SET fixed_fee = $2::numeric, consume_amount = $3::numeric,
              commission_amount = $4::numeric, updated_at = NOW()
        WHERE id = $1`,
      [commission.id, sqlMoney(fixedParts[0]), sqlMoney(consumeParts[0]), sqlMoney(amountParts[0])],
    )
    for (let index = 1; index < cloneIds.length; index++) {
      await client.query(
        `INSERT INTO service_commissions (
           service_item_id, employee_id, role_type, allocation_ratio, commission_rate,
           fixed_fee, consume_amount, commission_amount, is_void, voided_at, voided_reason,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13)`,
        [cloneIds[index], commission.employee_id, commission.role_type, commission.allocation_ratio,
          commission.commission_rate, sqlMoney(fixedParts[index]), sqlMoney(consumeParts[index]),
          sqlMoney(amountParts[index]), commission.is_void, commission.voided_at,
          commission.voided_reason, commission.created_at, commission.updated_at],
      )
    }
  }
  if (totalUsage !== int(service.session_used, 'session_used', service.service_item_id)) {
    throw new Error(`SERVICE_CHUNK_MISMATCH: ${service.service_item_id}`)
  }
}

async function distributeServices(client, inspected, allocationPlan) {
  for (const service of inspected.services) {
    if (service.service_status === '已取消') continue
    const chunks = allocationPlan.serviceChunks.get(service.service_item_id)
    if (!chunks || chunks.length === 0) throw new Error(`SERVICE_PLAN_MISSING: ${service.service_item_id}`)
    const cloneIds = chunks.map((_chunk, index) =>
      index === 0 ? service.service_item_id : generatedServiceItemId(service.service_item_id, index))
    if (cloneIds.length > 1) {
      const existing = await client.query(
        'SELECT service_item_id FROM service_items WHERE service_item_id = ANY($1)',
        [cloneIds.slice(1)],
      )
      if (existing.rowCount > 0) throw new Error(`SERVICE_ITEM_ID_EXISTS: ${existing.rows.map((row) => row.service_item_id).join(',')}`)
    }
    await client.query(
      `UPDATE service_items SET sale_item_id = $2, session_used = $3, updated_at = NOW()
        WHERE service_item_id = $1`,
      [service.service_item_id, chunks[0].saleItemId, chunks[0].quantity],
    )
    for (let index = 1; index < chunks.length; index++) {
      await client.query(
        `INSERT INTO service_items (
           service_item_id, sale_item_id, unit_real_price, is_shengmei, sales_category,
           service_order_id, session_used, employee_id, service_duration, reserved_at,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [cloneIds[index], chunks[index].saleItemId, service.unit_real_price, service.is_shengmei,
          service.sales_category, service.service_order_id, chunks[index].quantity,
          service.employee_id, service.service_duration, service.reserved_at,
          service.created_at, service.updated_at],
      )
    }
    if (chunks.length > 1) {
      await splitServiceCommissions(client, inspected, service, cloneIds, chunks.map((chunk) => chunk.quantity))
    }
  }
}

function nullableMoneyParts(value, weights, field, id) {
  if (value == null) return weights.map(() => null)
  return proportionalCents(money(value, field, id), weights)
}

async function distributeReceipts(client, inspected, cardIds) {
  const allocationsByReceipt = new Map()
  for (const allocation of inspected.receiptAllocations) {
    const key = String(allocation.sale_payment_item_receipt_id)
    if (!allocationsByReceipt.has(key)) allocationsByReceipt.set(key, [])
    allocationsByReceipt.get(key).push(allocation)
  }

  for (const receipt of inspected.receipts) {
    const amountParts = splitCents(money(receipt.amount, 'receipt.amount', receipt.id), cardIds.length)
    const receiptIds = [receipt.id]
    await client.query(
      `UPDATE sale_payment_item_receipts SET sale_item_id = $2, amount = $3::numeric WHERE id = $1`,
      [receipt.id, cardIds[0], sqlMoney(amountParts[0])],
    )
    for (let index = 1; index < cardIds.length; index++) {
      const { rows } = await client.query(
        `INSERT INTO sale_payment_item_receipts (
           sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at
         ) VALUES ($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
        [receipt.sale_payment_id, receipt.sale_order_id, cardIds[index],
          sqlMoney(amountParts[index]), receipt.sales_category, receipt.created_at],
      )
      receiptIds.push(rows[0].id)
    }

    for (const allocation of allocationsByReceipt.get(String(receipt.id)) || []) {
      const allocatedParts = proportionalCents(
        money(allocation.allocated_amount, 'allocated_amount', allocation.id),
        amountParts,
      )
      const commissionParts = nullableMoneyParts(
        allocation.commission_amount,
        amountParts,
        'commission_amount',
        allocation.id,
      )
      await client.query(
        `UPDATE sale_payment_item_allocations
            SET allocated_amount = $2::numeric, commission_amount = $3::numeric, updated_at = NOW()
          WHERE id = $1`,
        [allocation.id, sqlMoney(allocatedParts[0]),
          commissionParts[0] == null ? null : sqlMoney(commissionParts[0])],
      )
      for (let index = 1; index < receiptIds.length; index++) {
        await client.query(
          `INSERT INTO sale_payment_item_allocations (
             sale_payment_item_receipt_id, employee_id, role_type, department_name,
             allocation_ratio, allocated_amount, commission_rate, commission_amount,
             is_void, voided_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,$9,$10,$11,$12)`,
          [receiptIds[index], allocation.employee_id, allocation.role_type,
            allocation.department_name, allocation.allocation_ratio,
            sqlMoney(allocatedParts[index]), allocation.commission_rate,
            commissionParts[index] == null ? null : sqlMoney(commissionParts[index]),
            allocation.is_void, allocation.voided_at, allocation.created_at, allocation.updated_at],
        )
      }
    }
  }
}

async function splitOne(client, inspected) {
  const { source, quantity, perCardSessions } = inspected
  const cardIds = [source.sale_item_id]
  for (let index = 1; index < quantity; index++) cardIds.push(generatedSaleItemId(source.sale_item_id, index))
  const existing = await client.query(
    'SELECT sale_item_id FROM sale_items WHERE sale_item_id = ANY($1)',
    [cardIds.slice(1)],
  )
  if (existing.rowCount > 0) throw new Error(`SALE_ITEM_ID_EXISTS: ${existing.rows.map((row) => row.sale_item_id).join(',')}`)

  const allocationPlan = buildTreatmentCardAllocationPlan(inspected, cardIds)
  const parts = {
    saleAmount: splitCents(money(source.sale_amount, 'sale_amount', source.sale_item_id), quantity),
    received: splitCents(money(source.received, 'received', source.sale_item_id), quantity),
    pendingReceived: splitCents(money(source.pending_received, 'pending_received', source.sale_item_id), quantity),
    serviceFee: splitCents(money(source.service_fee, 'service_fee', source.sale_item_id), quantity),
    paid: source.paid_sessions == null
      ? Array(quantity).fill(null)
      : splitCapacity(int(source.paid_sessions, 'paid_sessions', source.sale_item_id), perCardSessions, quantity),
  }
  const groupId = source.sale_item_id
  await updateSourceSaleItem(client, source, {
    groupId,
    sessionCount: perCardSessions,
    remainingSessions: allocationPlan.remaining[0],
    paidSessions: parts.paid[0],
    saleAmount: parts.saleAmount[0],
    received: parts.received[0],
    pendingReceived: parts.pendingReceived[0],
    serviceFee: parts.serviceFee[0],
  })
  for (let index = 1; index < quantity; index++) {
    await insertSaleItem(client, source, {
      saleItemId: cardIds[index],
      groupId,
      sessionCount: perCardSessions,
      remainingSessions: allocationPlan.remaining[index],
      paidSessions: parts.paid[index],
      saleAmount: parts.saleAmount[index],
      received: parts.received[index],
      pendingReceived: parts.pendingReceived[index],
      serviceFee: parts.serviceFee[index],
    })
  }
  await distributeServices(client, inspected, allocationPlan)
  await distributeReceipts(client, inspected, cardIds)
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('datafix.splitConversionTreatmentCards', 'sale_item', $1, $2::jsonb, 'datafix', NOW())`,
    [source.sale_item_id, JSON.stringify({ _v: 1, groupId, cardIds, originalQuantity: quantity })],
  )
  return { cardIds, parts, allocationPlan }
}

function sumCents(rows, field, id) {
  return rows.reduce((sum, row) => sum + money(row[field], field, id), 0)
}

async function verifyOne(client, inspected, result) {
  const { source, quantity, perCardSessions } = inspected
  const { rows: cards } = await client.query(
    `SELECT * FROM sale_items WHERE sale_item_group_id = $1 ORDER BY sale_item_id`,
    [source.sale_item_id],
  )
  if (cards.length !== quantity || cards.some((row) => Number(row.quantity) !== 1)) {
    throw new Error(`${source.sale_item_id}: CARD_COUNT_MISMATCH`)
  }
  const expected = {
    sessions: int(source.session_count, 'session_count', source.sale_item_id),
    remaining: int(source.remaining_sessions, 'remaining_sessions', source.sale_item_id),
    paid: source.paid_sessions == null ? null : int(source.paid_sessions, 'paid_sessions', source.sale_item_id),
    saleAmount: money(source.sale_amount, 'sale_amount', source.sale_item_id),
    received: money(source.received, 'received', source.sale_item_id),
    pendingReceived: money(source.pending_received, 'pending_received', source.sale_item_id),
    serviceFee: money(source.service_fee, 'service_fee', source.sale_item_id),
  }
  const actual = {
    sessions: cards.reduce((sum, row) => sum + int(row.session_count, 'session_count', row.sale_item_id), 0),
    remaining: cards.reduce((sum, row) => sum + int(row.remaining_sessions, 'remaining_sessions', row.sale_item_id), 0),
    paid: expected.paid == null ? null : cards.reduce((sum, row) => sum + int(row.paid_sessions, 'paid_sessions', row.sale_item_id), 0),
    saleAmount: sumCents(cards, 'sale_amount', source.sale_item_id),
    received: sumCents(cards, 'received', source.sale_item_id),
    pendingReceived: sumCents(cards, 'pending_received', source.sale_item_id),
    serviceFee: sumCents(cards, 'service_fee', source.sale_item_id),
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${source.sale_item_id}: CARD_TOTAL_MISMATCH expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
  if (cards.some((row) => int(row.session_count, 'session_count', row.sale_item_id) !== perCardSessions)) {
    throw new Error(`${source.sale_item_id}: PER_CARD_SESSION_MISMATCH`)
  }

  const { rows: serviceTotals } = await client.query(
    `SELECT
       (SELECT COALESCE(sum(sit.session_used), 0)::int
          FROM service_items sit WHERE sit.sale_item_id = ANY($1)) AS session_used,
       (SELECT COALESCE(sum(sc.fixed_fee), 0)::numeric
          FROM service_commissions sc JOIN service_items sit ON sit.service_item_id = sc.service_item_id
         WHERE sit.sale_item_id = ANY($1)) AS fixed_fee,
       (SELECT COALESCE(sum(sc.consume_amount), 0)::numeric
          FROM service_commissions sc JOIN service_items sit ON sit.service_item_id = sc.service_item_id
         WHERE sit.sale_item_id = ANY($1)) AS consume_amount,
       (SELECT COALESCE(sum(sc.commission_amount), 0)::numeric
          FROM service_commissions sc JOIN service_items sit ON sit.service_item_id = sc.service_item_id
         WHERE sit.sale_item_id = ANY($1)) AS commission_amount`,
    [result.cardIds],
  )
  const expectedServiceTotals = {
    sessionUsed: inspected.services.reduce(
      (sum, row) => sum + int(row.session_used, 'session_used', row.service_item_id),
      0,
    ),
    fixedFee: sumCents(inspected.commissions, 'fixed_fee', source.sale_item_id),
    consumeAmount: sumCents(inspected.commissions, 'consume_amount', source.sale_item_id),
    commissionAmount: sumCents(inspected.commissions, 'commission_amount', source.sale_item_id),
  }
  const actualServiceTotals = {
    sessionUsed: int(serviceTotals[0].session_used, 'service_total', source.sale_item_id),
    fixedFee: money(serviceTotals[0].fixed_fee, 'fixed_fee_total', source.sale_item_id),
    consumeAmount: money(serviceTotals[0].consume_amount, 'consume_amount_total', source.sale_item_id),
    commissionAmount: money(serviceTotals[0].commission_amount, 'commission_amount_total', source.sale_item_id),
  }
  if (JSON.stringify(actualServiceTotals) !== JSON.stringify(expectedServiceTotals)) {
    throw new Error(
      `${source.sale_item_id}: SERVICE_TOTAL_MISMATCH expected=${JSON.stringify(expectedServiceTotals)} actual=${JSON.stringify(actualServiceTotals)}`,
    )
  }

  const { rows: receiptTotals } = await client.query(
    `SELECT COALESCE(sum(amount), 0)::numeric AS amount
       FROM sale_payment_item_receipts WHERE sale_item_id = ANY($1)`,
    [result.cardIds],
  )
  const expectedReceiptAmount = sumCents(inspected.receipts, 'amount', source.sale_item_id)
  if (money(receiptTotals[0].amount, 'receipt_total', source.sale_item_id) !== expectedReceiptAmount) {
    throw new Error(`${source.sale_item_id}: RECEIPT_TOTAL_MISMATCH`)
  }

  const { rows: allocationTotals } = await client.query(
    `SELECT COALESCE(sum(spia.allocated_amount), 0)::numeric AS allocated_amount,
            COALESCE(sum(spia.commission_amount), 0)::numeric AS commission_amount
       FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      WHERE spir.sale_item_id = ANY($1)`,
    [result.cardIds],
  )
  const expectedAllocated = sumCents(inspected.receiptAllocations, 'allocated_amount', source.sale_item_id)
  const expectedCommission = sumCents(inspected.receiptAllocations, 'commission_amount', source.sale_item_id)
  if (money(allocationTotals[0].allocated_amount, 'allocated_total', source.sale_item_id) !== expectedAllocated
      || money(allocationTotals[0].commission_amount, 'commission_total', source.sale_item_id) !== expectedCommission) {
    throw new Error(`${source.sale_item_id}: RECEIPT_ALLOCATION_TOTAL_MISMATCH`)
  }
}

function snapshotPath(args) {
  const explicit = optionValue(args, '--snapshot-file')
  if (explicit) return path.resolve(explicit)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `/tmp/fengyu-conversion-card-snapshot-${stamp}.json`
}

function writeSnapshot(filePath, inspectedRows) {
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    candidates: inspectedRows.map((row) => ({
      source: row.source,
      services: row.services,
      serviceCommissions: row.commissions,
      receipts: row.receipts,
      receiptAllocations: row.receiptAllocations,
    })),
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.chmodSync(filePath, 0o600)
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 必须显式指定')
  if (APPLY && EXERCISE) throw new Error('--apply 与 --exercise 不能同时使用')
  const args = process.argv.slice(2)
  const targetIds = parseTargetIds(args)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const client = await pool.connect()
  try {
    log(`目标库: ${redactConnectionString(process.env.DATABASE_URL)}`)
    log(`模式: ${APPLY ? 'APPLY' : EXERCISE ? 'EXERCISE（完整执行后回滚）' : 'DRY-RUN'}${targetIds.length ? `；指定明细=${targetIds.length}` : ''}`)
    await assertSchema(client)
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    try {
      const ids = await candidateIds(client, targetIds)
      log(`聚合候选: ${ids.length}`)
      const inspectedRows = []
      for (const id of ids) inspectedRows.push(await inspect(client, id))
      const totalCards = inspectedRows.reduce((sum, row) => sum + row.quantity, 0)
      const totalServices = inspectedRows.reduce((sum, row) => sum + row.services.length, 0)
      const totalReceipts = inspectedRows.reduce((sum, row) => sum + row.receipts.length, 0)
      const totalAllocations = inspectedRows.reduce((sum, row) => sum + row.receiptAllocations.length, 0)
      log(`预检通过: ${totalCards} 张实体卡；服务明细 ${totalServices}；款项子项 ${totalReceipts}；营业额分配 ${totalAllocations}`)

      if (APPLY) {
        const filePath = snapshotPath(args)
        writeSnapshot(filePath, inspectedRows)
        log(`回滚快照: ${filePath}`)
      }

      if (APPLY || EXERCISE) {
        for (const inspected of inspectedRows) {
          const result = await splitOne(client, inspected)
          await verifyOne(client, inspected, result)
        }
        const { rows } = await client.query(
          `SELECT count(*)::int AS count
             FROM sale_items si
             JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
            WHERE so.sale_order_type = '转换单'
              AND si.item_direction = '转入'
              AND si.product_type = '疗程卡'
              AND si.quantity > 1`,
        )
        if (targetIds.length === 0 && Number(rows[0].count) !== 0) {
          throw new Error(`POSTCHECK_AGGREGATES_REMAIN: ${rows[0].count}`)
        }
      }

      if (APPLY) {
        await client.query('COMMIT')
        log(`提交完成: 拆分 ${inspectedRows.length} 行为 ${totalCards} 张实体卡`)
      } else {
        await client.query('ROLLBACK')
        log(`${EXERCISE ? 'EXERCISE' : 'DRY-RUN'} 完成并已回滚，未写入数据`)
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    client.release()
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[SPLIT-CONVERSION-CARDS] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  generatedSaleItemId,
  proportionalCents,
  splitCapacity,
  splitCents,
}
