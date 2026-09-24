#!/usr/bin/env node

/**
 * 将历史寄存单的聚合购买行拆为 quantity=1 的独立 sale_items。
 *
 * 默认 DRY-RUN；只有显式 --apply 才提交。脚本保留原 sale_item_id 作为首张卡，
 * 其余卡使用新 ID，所有卡的 sale_item_group_id 均为原 ID。这样既能安全迁移既有外键，
 * 又能让展示层按 group_id 合并为一行。
 *
 * 仅处理 production 已审计的数据形状：寄存初始化回款、服务/服务提成、预约和转换转出
 * 都会随卡拆分；提货、库存、资金分配等未审计引用一律拒绝写入，绝不静默丢数据。
 *
 * 用法：
 *   DATABASE_URL='postgresql://...' node db/scripts/split-deposit-treatment-cards.js
 *   DATABASE_URL='postgresql://...' node db/scripts/split-deposit-treatment-cards.js --apply
 *   DATABASE_URL='postgresql://...' node db/scripts/split-deposit-treatment-cards.js \
 *     --sale-item-id XSLSH-WX-202607130035 --apply
 */

'use strict'

const { createHash } = require('node:crypto')
const { Pool } = require('pg')

const APPLY = process.argv.includes('--apply')
const EXERCISE = process.argv.includes('--exercise')
const SKIP_GROUP_BACKFILL = process.argv.includes('--skip-group-backfill')
const INITIAL_RECEIPT_NOTE = '寄存单初始化实收'
const ALLOWED_ORDER_STATUSES = new Set(['待审批', '已支付', '已作废'])
const CLOSED_CONVERSION_STATUSES = new Set(['已关闭', '已作废'])
const ACTIVE_RESERVATION_STATUSES = new Set(['服务中', '待客户确认'])
const EXPECTED_DIRECT_REFS = new Set([
  'appointments.sale_item_id',
  'pickup_records.sale_item_id',
  'sale_allocations.sale_item_id',
  'sale_items.ref_sale_item_id',
  'sale_order_payments.ref_sale_item_id',
  'sale_payment_allocatable_items.sale_item_id',
  'sale_payment_item_receipts.sale_item_id',
  'service_items.sale_item_id',
  'inventory_doc_items.sale_item_id',
])

function log(message) {
  console.log(`[SPLIT-DEPOSIT-CARDS] ${message}`)
}

function redactConnectionString(value) {
  return value.replace(/(\/\/[^:/?#]+:)[^@/]+@/, '$1***@')
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

function parsePositiveOption(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = Number(args[index + 1])
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`)
  return value
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

function sqlMoney(value) {
  return (value / 100).toFixed(2)
}

function splitCents(total, count) {
  const sign = total < 0 ? -1 : 1
  const absolute = Math.abs(total)
  const each = Math.trunc(absolute / count)
  const remainder = absolute % count
  return Array.from({ length: count }, (_unused, index) => sign * (each + (index === count - 1 ? remainder : 0)))
}

function splitInteger(total, count) {
  const each = Math.trunc(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_unused, index) => each + (index === count - 1 ? remainder : 0))
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

function generatedSaleItemId(sourceId, index) {
  const hash = createHash('sha1').update(sourceId).digest('hex').slice(0, 20).toUpperCase()
  return `DS-${hash}-${String(index + 1).padStart(3, '0')}`
}

function generatedServiceItemId(sourceId, index) {
  const hash = createHash('sha1').update(sourceId).digest('hex').slice(0, 20)
  return `dsi_${hash}_${index + 1}`
}

function proportionalCents(total, chunks, denominator) {
  if (denominator <= 0) return chunks.map(() => 0)
  const sign = total < 0 ? -1 : 1
  const absolute = Math.abs(total)
  let assigned = 0
  return chunks.map((chunk, index) => {
    if (index === chunks.length - 1) return sign * (absolute - assigned)
    const value = Math.floor((absolute * chunk) / denominator)
    assigned += value
    return sign * value
  })
}

function conversionConsumesSource(child) {
  return !CLOSED_CONVERSION_STATUSES.has(child.child_order_status)
}

function serviceReservationAfterSplit(service) {
  return ACTIVE_RESERVATION_STATUSES.has(service.service_status) ? service.reserved_at : null
}

function usageTimestamp(row, fields, id) {
  for (const field of fields) {
    const value = row[field]
    if (value == null) continue
    const timestamp = new Date(value).getTime()
    if (Number.isFinite(timestamp)) return timestamp
    throw new Error(`INVALID_TIMESTAMP: ${id}.${field}=${String(value)}`)
  }
  throw new Error(`MISSING_TIMESTAMP: ${id}.${fields.join('|')}`)
}

function treatmentHistoryConsumption(source, services, children) {
  const completedServices = services
    .filter((service) => service.service_status === '已完成')
    .reduce((sum, service) => sum + int(service.session_used, 'service_items.session_used', service.service_item_id), 0)
  const conversions = children
    .filter(conversionConsumesSource)
    .reduce((sum, child) => sum + Math.abs(int(child.quantity, 'child.quantity', child.sale_item_id)), 0)
  const total = int(source.session_count, 'session_count', source.sale_item_id)
  const remaining = int(source.remaining_sessions, 'remaining_sessions', source.sale_item_id)
  return { completedServices, conversions, consumed: completedServices + conversions, expected: total - remaining }
}

/**
 * 按实际发生时间将服务核销、转换和服务预扣映射至同一批子卡。
 *
 * completed service / conversion 会扣减卡余额；服务中的 reserved_at 仅占用可用次数，
 * 保持与运行时“remaining_sessions - reserved”语义一致。待服务明细不占余额，
 * 但也必须被绑定到当前仍可用的单卡，确保后续 start 能按单卡校验。
 */
function buildTreatmentCardAllocationPlan(inspected, cardIds) {
  const { source, services, children, perCardSessions } = inspected
  const history = treatmentHistoryConsumption(source, services, children)
  if (history.consumed !== history.expected) {
    throw new Error(
      `HISTORY_CONSUMPTION_MISMATCH: 已核销=${history.completedServices}，有效转换=${history.conversions}，` +
      `合计=${history.consumed}，应为=${history.expected}`,
    )
  }

  const cards = cardIds.map((saleItemId) => ({ saleItemId, remaining: perCardSessions, reserved: 0 }))
  const events = []
  for (const service of services) {
    if (service.service_status === '已取消') continue
    const quantity = int(service.session_used, 'service_items.session_used', service.service_item_id)
    if (quantity <= 0) throw new Error(`INVALID_SERVICE_USAGE: ${service.service_item_id}=${quantity}`)
    const effectiveReservedAt = serviceReservationAfterSplit(service)
    const mode = service.service_status === '已完成'
      ? 'consume'
      : effectiveReservedAt != null
        ? 'reserve'
        : 'assign'
    events.push({
      type: 'service',
      id: service.service_item_id,
      quantity,
      mode,
      timestamp: usageTimestamp(
        service,
        mode === 'consume' ? ['service_completed_at', 'created_at'] : mode === 'reserve' ? ['reserved_at', 'created_at'] : ['created_at'],
        service.service_item_id,
      ),
    })
  }
  for (const child of children) {
    if (!conversionConsumesSource(child)) continue
    const quantity = Math.abs(int(child.quantity, 'child.quantity', child.sale_item_id))
    if (quantity <= 0) throw new Error(`INVALID_CONVERSION_USAGE: ${child.sale_item_id}=${quantity}`)
    events.push({
      type: 'child',
      id: child.sale_item_id,
      quantity,
      mode: 'consume',
      timestamp: usageTimestamp(child, ['created_at', 'child_order_datetime'], child.sale_item_id),
    })
  }
  events.sort((left, right) => left.timestamp - right.timestamp || left.type.localeCompare(right.type) || left.id.localeCompare(right.id))

  const serviceChunks = new Map()
  const childChunks = new Map()
  for (const event of events) {
    let left = event.quantity
    const chunks = []
    for (const card of cards) {
      const available = card.remaining - card.reserved
      if (available <= 0) continue
      const quantity = Math.min(left, available)
      chunks.push({ saleItemId: card.saleItemId, quantity })
      if (event.mode === 'consume') card.remaining -= quantity
      if (event.mode === 'reserve') card.reserved += quantity
      left -= quantity
      if (left === 0) break
    }
    if (left !== 0) {
      throw new Error(`${event.type === 'service' ? 'SERVICE' : 'CONVERSION'}_CAPACITY_OVERFLOW: ${event.id}`)
    }
    if (event.type === 'service') serviceChunks.set(event.id, chunks)
    else childChunks.set(event.id, chunks)
  }

  const remaining = cards.map((card) => card.remaining)
  const totalRemaining = remaining.reduce((sum, value) => sum + value, 0)
  const sourceRemaining = int(source.remaining_sessions, 'remaining_sessions', source.sale_item_id)
  if (totalRemaining !== sourceRemaining) {
    throw new Error(`REMAINING_PLAN_MISMATCH: 计划=${totalRemaining}，原明细=${sourceRemaining}`)
  }
  return { remaining, serviceChunks, childChunks }
}

async function assertSchema(client) {
  const column = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sale_items' AND column_name = 'sale_item_group_id'`,
  )
  if (column.rowCount !== 1) throw new Error('SCHEMA_MISSING: 请先应用包含 sale_item_group_id 的数据库迁移')

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

async function candidateIds(client, targetIds, limit, offset) {
  if (targetIds.length > 0) return targetIds
  const { rows } = await client.query(
    `SELECT si.sale_item_id
       FROM sale_items si
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE so.sale_order_type = '寄存单'
        AND si.item_direction = '购买'
        AND si.quantity > 1
      ORDER BY si.sale_order_id, si.sale_item_id`,
  )
  return rows.map((row) => row.sale_item_id).slice(offset, limit == null ? undefined : offset + limit)
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
  if (!source) return { skip: '明细不存在' }
  if (source.sale_order_type !== '寄存单' || source.item_direction !== '购买') return { skip: '不是寄存单购买明细' }
  if (!ALLOWED_ORDER_STATUSES.has(source.order_status)) return { skip: `订单状态不支持: ${source.order_status}` }

  const quantity = int(source.quantity, 'quantity', saleItemId)
  if (quantity <= 1) return { skip: '已是单件明细' }
  const isTreatment = source.product_type === '疗程卡'
  if (!isTreatment && source.product_type !== '家居产品') return { skip: `商品类型不支持: ${source.product_type}` }

  let perCardSessions = null
  if (isTreatment) {
    const totalSessions = int(source.session_count, 'session_count', saleItemId)
    const remaining = int(source.remaining_sessions, 'remaining_sessions', saleItemId)
    if (totalSessions <= 0 || totalSessions % quantity !== 0 || remaining < 0 || remaining > totalSessions) {
      return { skip: '疗程次数不能按张拆分' }
    }
    if (source.paid_sessions != null) {
      const paid = int(source.paid_sessions, 'paid_sessions', saleItemId)
      if (paid < 0 || paid > totalSessions) return { skip: 'paid_sessions 越界' }
    }
    perCardSessions = totalSessions / quantity
  } else if (source.session_count != null || source.remaining_sessions != null || source.paid_sessions != null) {
    return { skip: '家居产品存在疗程次数字段' }
  }

  // #154：本脚本只搬运 picked_up_quantity，拆出的子行两个新列会落默认 0。
  // 家居行的 refunded_quantity / converted_quantity 一旦非零被拆走，那部分已结算额度就凭空消失
  // → 整行重新变成可提可退（资损）。下方 unsafe 守卫只挡 pickup_records，挡不住这两类。
  // 与其在这里补一套没法充分验证的分摊算法，不如照本脚本既有的 fail-closed 风格直接拒绝拆分。
  // 缺列必须当异常而不是当 0：上游是 `SELECT si.*`，真缺了说明取数被改过，
  // 而 `?? 0` 会让守卫静默失效、照常拆分并释放已结算额度（fail-open）。
  if (source.refunded_quantity === undefined || source.converted_quantity === undefined) {
    return { skip: '取数缺少 refunded_quantity / converted_quantity，无法判定是否可安全拆分' }
  }
  if (Number(source.refunded_quantity) !== 0 || Number(source.converted_quantity) !== 0) {
    return { skip: '存在已退款/已转换数量，拆分会丢失已结算额度' }
  }

  const { rows: refCounts } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM pickup_records WHERE sale_item_id = $1) AS pickups,
       (SELECT count(*)::int FROM sale_allocations WHERE sale_item_id = $1) AS allocations,
       (SELECT count(*)::int FROM sale_payment_allocatable_items WHERE sale_item_id = $1) AS allocatables,
       (SELECT count(*)::int FROM sale_payment_item_receipts WHERE sale_item_id = $1) AS receipts,
       (SELECT count(*)::int FROM inventory_doc_items WHERE sale_item_id = $1) AS inventory_doc_items,
       (SELECT count(*)::int FROM sale_items WHERE ref_sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE ref_sale_item_id = $1)) AS nested_children`,
    [saleItemId],
  )
  const unsafe = Object.entries(refCounts[0]).find(([, value]) => Number(value) > 0)
  if (unsafe) return { skip: `未支持关联: ${unsafe[0]}=${unsafe[1]}` }

  const { rows: payments } = await client.query(
    `SELECT * FROM sale_order_payments WHERE ref_sale_item_id = $1 FOR UPDATE`,
    [saleItemId],
  )
  if (payments.length > 1) return { skip: '存在多笔定向款项' }
  if (payments[0] && (payments[0].change_type !== '回款' || payments[0].note !== INITIAL_RECEIPT_NOTE || payments[0].external_txn_id != null)) {
    return { skip: '存在非寄存初始化回款' }
  }

  const { rows: services } = await client.query(
    `SELECT sit.*, so.status::text AS service_status, so.completed_at AS service_completed_at
       FROM service_items sit
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE sit.sale_item_id = $1
      ORDER BY sit.service_item_id
      FOR UPDATE OF sit`,
    [saleItemId],
  )
  if (!isTreatment && services.length > 0) return { skip: '家居产品存在服务明细' }
  const activeUsage = services
    .filter((row) => row.service_status !== '已取消')
    .reduce((sum, row) => sum + int(row.session_used, 'service_items.session_used', saleItemId), 0)
  if (isTreatment && activeUsage > Number(source.session_count)) return { skip: '有效服务次数超过原疗程次数' }

  const { rows: children } = await client.query(
    `SELECT child.*, child_order.status::text AS child_order_status,
            child_order.sale_order_datetime AS child_order_datetime
       FROM sale_items child
       JOIN sale_orders child_order ON child_order.sale_order_id = child.sale_order_id
      WHERE child.ref_sale_item_id = $1
      ORDER BY child.sale_item_id
      FOR UPDATE OF child`,
    [saleItemId],
  )
  if (!isTreatment && children.length > 0) return { skip: '家居产品存在衍生销售明细' }
  if (children.some((row) => row.item_direction !== '转出')) return { skip: '存在非转换转出衍生明细' }
  const activeConversions = children
    .filter(conversionConsumesSource)
    .reduce((sum, row) => sum + Math.abs(int(row.quantity, 'child.quantity', row.sale_item_id)), 0)
  if (isTreatment && activeConversions > Number(source.session_count)) {
    return { skip: '转换转出次数超过原疗程次数' }
  }
  if (isTreatment) {
    const history = treatmentHistoryConsumption(source, services, children)
    if (history.consumed !== history.expected) {
      return { skip: `历史消耗与剩余次数不一致: 已核销=${history.completedServices}，有效转换=${history.conversions}，应消耗=${history.expected}` }
    }
  }

  const { rows: appointments } = await client.query(
    `SELECT * FROM appointments WHERE sale_item_id = $1 ORDER BY appointment_id FOR UPDATE`,
    [saleItemId],
  )
  if (!isTreatment && appointments.length > 0) return { skip: '家居产品存在预约' }

  return { ok: true, source, quantity, perCardSessions, payment: payments[0] || null, services, children, appointments }
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
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
     )`,
    [
      values.saleItemId, values.groupId ?? null, source.sale_order_id, source.store_id, source.item_direction,
      values.refSaleItemId ?? source.ref_sale_item_id, source.sku_id, source.product_name, source.product_type,
      values.sessionCount, values.remainingSessions, values.paidSessions,
      source.unit_price, values.quantity, source.unit_real_price, sqlMoney(values.saleAmount), sqlMoney(values.received), sqlMoney(values.pendingReceived),
      source.expire_date, values.pickedUpQuantity, source.remark, source.sales_category, sqlMoney(values.serviceFee),
      source.is_shengmei, source.is_experience, source.is_manager_special, source.created_at, source.updated_at,
    ],
  )
}

async function updateSaleItem(client, id, values) {
  await client.query(
    `UPDATE sale_items SET sale_item_group_id = $2, ref_sale_item_id = $3,
       session_count = $4, remaining_sessions = $5, paid_sessions = $6, quantity = $7,
       sale_amount = $8::numeric, received = $9::numeric, pending_received = $10::numeric,
       service_fee = $11::numeric, picked_up_quantity = $12, updated_at = NOW()
      WHERE sale_item_id = $1`,
    [id, values.groupId ?? null, values.refSaleItemId ?? null, values.sessionCount, values.remainingSessions,
      values.paidSessions, values.quantity, sqlMoney(values.saleAmount), sqlMoney(values.received),
      sqlMoney(values.pendingReceived), sqlMoney(values.serviceFee), values.pickedUpQuantity],
  )
}

async function cloneServiceCommissions(client, originalServiceItemId, nextServiceItemId, chunks, totalUsage) {
  const { rows } = await client.query(
    `SELECT * FROM service_commissions WHERE service_item_id = $1 ORDER BY id FOR UPDATE`,
    [originalServiceItemId],
  )
  for (const commission of rows) {
    const fixedParts = proportionalCents(money(commission.fixed_fee, 'fixed_fee', originalServiceItemId), chunks, totalUsage)
    const consumeParts = proportionalCents(money(commission.consume_amount, 'consume_amount', originalServiceItemId), chunks, totalUsage)
    const amountParts = proportionalCents(money(commission.commission_amount, 'commission_amount', originalServiceItemId), chunks, totalUsage)
    await client.query(
      `UPDATE service_commissions SET fixed_fee = $2::numeric, consume_amount = $3::numeric,
         commission_amount = $4::numeric, updated_at = NOW() WHERE id = $1`,
      [commission.id, sqlMoney(fixedParts[0]), sqlMoney(consumeParts[0]), sqlMoney(amountParts[0])],
    )
    for (let index = 1; index < chunks.length; index++) {
      await client.query(
        `INSERT INTO service_commissions (
           service_item_id, employee_id, role_type, allocation_ratio, commission_rate,
           fixed_fee, consume_amount, commission_amount, is_void, voided_at, voided_reason, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13)`,
        [nextServiceItemId[index], commission.employee_id, commission.role_type, commission.allocation_ratio, commission.commission_rate,
          sqlMoney(fixedParts[index]), sqlMoney(consumeParts[index]), sqlMoney(amountParts[index]),
          commission.is_void, commission.voided_at, commission.voided_reason, commission.created_at, commission.updated_at],
      )
    }
  }
}

async function distributeServices(client, inspected, serviceChunks) {
  if (inspected.services.length === 0) return
  for (const service of inspected.services) {
    const reservedAt = serviceReservationAfterSplit(service)
    if (service.service_status === '已取消') {
      if (service.reserved_at != null) {
        await client.query(
          'UPDATE service_items SET reserved_at = NULL, updated_at = NOW() WHERE service_item_id = $1',
          [service.service_item_id],
        )
      }
      continue
    }
    const chunks = serviceChunks.get(service.service_item_id)
    if (!chunks) throw new Error(`SERVICE_PLAN_MISSING: ${service.service_item_id}`)
    const cloneIds = chunks.map((chunk, index) => index === 0 ? service.service_item_id : generatedServiceItemId(service.service_item_id, index))
    const existing = await client.query('SELECT service_item_id FROM service_items WHERE service_item_id = ANY($1)', [cloneIds.slice(1)])
    if (existing.rowCount > 0) throw new Error(`SERVICE_ITEM_ID_EXISTS: ${existing.rows.map((row) => row.service_item_id).join(',')}`)
    await client.query(
      `UPDATE service_items
          SET sale_item_id = $2, session_used = $3, reserved_at = $4, updated_at = NOW()
        WHERE service_item_id = $1`,
      [service.service_item_id, chunks[0].saleItemId, chunks[0].quantity, reservedAt],
    )
    for (let index = 1; index < chunks.length; index++) {
      await client.query(
        `INSERT INTO service_items (
           service_item_id, sale_item_id, unit_real_price, is_shengmei, sales_category,
           service_order_id, session_used, employee_id, service_duration, reserved_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [cloneIds[index], chunks[index].saleItemId, service.unit_real_price, service.is_shengmei, service.sales_category,
          service.service_order_id, chunks[index].quantity, service.employee_id, service.service_duration,
          reservedAt, service.created_at, service.updated_at],
      )
    }
    if (chunks.length > 1) await cloneServiceCommissions(client, service.service_item_id, cloneIds, chunks.map((chunk) => chunk.quantity), int(service.session_used, 'session_used', service.service_item_id))
  }
}

async function distributeChildren(client, inspected, childChunks) {
  if (inspected.children.length === 0) return
  const capacity = inspected.perCardSessions
  for (const child of inspected.children) {
    if (!conversionConsumesSource(child)) continue
    const chunks = childChunks.get(child.sale_item_id)
    if (!chunks) throw new Error(`CONVERSION_PLAN_MISSING: ${child.sale_item_id}`)
    const originalQuantity = Math.abs(int(child.quantity, 'child.quantity', child.sale_item_id))
    const parts = {
      saleAmount: proportionalCents(money(child.sale_amount, 'child.sale_amount', child.sale_item_id), chunks.map((chunk) => chunk.quantity), originalQuantity),
      received: proportionalCents(money(child.received, 'child.received', child.sale_item_id), chunks.map((chunk) => chunk.quantity), originalQuantity),
      pendingReceived: proportionalCents(money(child.pending_received, 'child.pending_received', child.sale_item_id), chunks.map((chunk) => chunk.quantity), originalQuantity),
      serviceFee: proportionalCents(money(child.service_fee, 'child.service_fee', child.sale_item_id), chunks.map((chunk) => chunk.quantity), originalQuantity),
    }
    await updateSaleItem(client, child.sale_item_id, {
      groupId: child.sale_item_group_id,
      refSaleItemId: chunks[0].saleItemId,
      sessionCount: capacity,
      remainingSessions: child.remaining_sessions == null ? null : 0,
      paidSessions: child.paid_sessions == null ? null : 0,
      quantity: chunks[0].quantity,
      saleAmount: parts.saleAmount[0], received: parts.received[0], pendingReceived: parts.pendingReceived[0],
      serviceFee: parts.serviceFee[0], pickedUpQuantity: Number(child.picked_up_quantity || 0),
    })
    for (let index = 1; index < chunks.length; index++) {
      const childId = generatedSaleItemId(`${child.sale_item_id}:child`, index)
      await insertSaleItem(client, child, {
        saleItemId: childId, groupId: child.sale_item_group_id, refSaleItemId: chunks[index].saleItemId,
        sessionCount: capacity, remainingSessions: child.remaining_sessions == null ? null : 0,
        paidSessions: child.paid_sessions == null ? null : 0, quantity: chunks[index].quantity,
        saleAmount: parts.saleAmount[index], received: parts.received[index], pendingReceived: parts.pendingReceived[index],
        serviceFee: parts.serviceFee[index], pickedUpQuantity: Number(child.picked_up_quantity || 0),
      })
    }
  }
}

async function distributePayment(client, payment, cardIds) {
  if (!payment) return
  const amountParts = splitCents(money(payment.amount, 'payment.amount', payment.id), cardIds.length)
  const sessionParts = payment.session_count == null ? null : splitInteger(int(payment.session_count, 'payment.session_count', payment.id), cardIds.length)
  const positive = amountParts.map((value, index) => ({ value, index })).filter((part) => part.value > 0)
  if (positive.length === 0) throw new Error(`PAYMENT_SPLIT_EMPTY: ${payment.id}`)
  const first = positive[0]
  await client.query(
    `UPDATE sale_order_payments SET ref_sale_item_id = $2, amount = $3::numeric, session_count = $4 WHERE id = $1`,
    [payment.id, cardIds[first.index], sqlMoney(first.value), sessionParts?.[first.index] ?? null],
  )
  for (const part of positive.slice(1)) {
    await client.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, amount, payment_method, external_txn_id, external_trade_info,
         status, source_end, operator_employee_id, note, refund_reason, ref_sale_item_id, session_count,
         audit_employee_id, audit_at, audit_remark, created_at, paid_at, allocation_status
       ) VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [payment.sale_order_id, payment.change_type, sqlMoney(part.value), payment.payment_method, payment.external_txn_id,
        payment.external_trade_info, payment.status, payment.source_end, payment.operator_employee_id, payment.note,
        payment.refund_reason, cardIds[part.index], sessionParts?.[part.index] ?? null, payment.audit_employee_id,
        payment.audit_at, payment.audit_remark, payment.created_at, payment.paid_at, payment.allocation_status],
    )
  }
}

async function splitOne(client, inspected) {
  const { source, quantity, perCardSessions } = inspected
  const cardIds = [source.sale_item_id]
  for (let index = 1; index < quantity; index++) cardIds.push(generatedSaleItemId(source.sale_item_id, index))
  const exists = await client.query('SELECT sale_item_id FROM sale_items WHERE sale_item_id = ANY($1)', [cardIds.slice(1)])
  if (exists.rowCount > 0) throw new Error(`SALE_ITEM_ID_EXISTS: ${exists.rows.map((row) => row.sale_item_id).join(',')}`)

  const allocationPlan = perCardSessions == null ? null : buildTreatmentCardAllocationPlan(inspected, cardIds)
  const parts = {
    saleAmount: splitCents(money(source.sale_amount, 'sale_amount', source.sale_item_id), quantity),
    received: splitCents(money(source.received, 'received', source.sale_item_id), quantity),
    pendingReceived: splitCents(money(source.pending_received, 'pending_received', source.sale_item_id), quantity),
    serviceFee: splitCents(money(source.service_fee, 'service_fee', source.sale_item_id), quantity),
    remaining: allocationPlan ? allocationPlan.remaining : Array(quantity).fill(null),
    paid: perCardSessions == null || source.paid_sessions == null ? Array(quantity).fill(null) : splitCapacity(int(source.paid_sessions, 'paid_sessions', source.sale_item_id), perCardSessions, quantity),
  }
  const groupId = source.sale_item_id
  await updateSaleItem(client, source.sale_item_id, {
    groupId, refSaleItemId: source.ref_sale_item_id, sessionCount: perCardSessions, remainingSessions: parts.remaining[0], paidSessions: parts.paid[0],
    quantity: 1, saleAmount: parts.saleAmount[0], received: parts.received[0], pendingReceived: parts.pendingReceived[0],
    serviceFee: parts.serviceFee[0], pickedUpQuantity: Number(source.picked_up_quantity || 0),
  })
  for (let index = 1; index < quantity; index++) {
    await insertSaleItem(client, source, {
      saleItemId: cardIds[index], groupId, refSaleItemId: source.ref_sale_item_id,
      sessionCount: perCardSessions, remainingSessions: parts.remaining[index], paidSessions: parts.paid[index], quantity: 1,
      saleAmount: parts.saleAmount[index], received: parts.received[index], pendingReceived: parts.pendingReceived[index],
      serviceFee: parts.serviceFee[index], pickedUpQuantity: 0,
    })
  }
  if (perCardSessions != null) {
    await distributeServices(client, inspected, allocationPlan.serviceChunks)
    await distributeChildren(client, inspected, allocationPlan.childChunks)
    for (const appointment of inspected.appointments) {
      const target = cardIds[0]
      await client.query('UPDATE appointments SET sale_item_id = $2, updated_at = NOW() WHERE appointment_id = $1', [appointment.appointment_id, target])
    }
  }
  await distributePayment(client, inspected.payment, cardIds)
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('datafix.splitDepositCards', 'sale_item', $1, $2::jsonb, 'datafix', NOW())`,
    [source.sale_item_id, JSON.stringify({ _v: 2, groupId, cardIds, productType: source.product_type })],
  )
  return cardIds
}

async function backfillSingleItemGroups(client) {
  const result = await client.query(
    `UPDATE sale_items si SET sale_item_group_id = si.sale_item_id, updated_at = NOW()
       FROM sale_orders so
      WHERE so.sale_order_id = si.sale_order_id
        AND so.sale_order_type = '寄存单'
        AND si.item_direction = '购买'
        AND si.quantity = 1
        AND si.sale_item_group_id IS NULL`,
  )
  return result.rowCount
}

async function processOne(pool, id) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inspected = await inspect(client, id)
    if (!inspected.ok) {
      await client.query('ROLLBACK')
      return { skipped: inspected.skip, cards: 0 }
    }
    if (APPLY || EXERCISE) await splitOne(client, inspected)
    if (APPLY) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    return { skipped: null, cards: inspected.quantity }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw new Error(`${id}: ${error.message}`)
  } finally {
    client.release()
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 必须显式指定')
  const args = process.argv.slice(2)
  const targetIds = parseTargetIds(args)
  const limit = parsePositiveOption(args, '--limit')
  const offset = parsePositiveOption(args, '--offset') ?? 0
  if (APPLY && offset > 0) throw new Error('--apply 不允许 --offset；请反复执行 --limit 直到候选为 0')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  const stats = { split: 0, cards: 0, skipped: 0, reasons: new Map(), q1Grouped: 0 }
  try {
    log(`目标库: ${redactConnectionString(process.env.DATABASE_URL)}`)
    log(`模式: ${APPLY ? 'APPLY' : EXERCISE ? 'EXERCISE（完整模拟后回滚）' : 'DRY-RUN'}${targetIds.length ? `；指定明细=${targetIds.length}` : ''}${limit ? `；limit=${limit}` : ''}${offset ? `；offset=${offset}` : ''}`)
    const client = await pool.connect()
    let ids
    try {
      await assertSchema(client)
      ids = await candidateIds(client, targetIds, limit, offset)
      log(`聚合候选: ${ids.length}`)
    } finally {
      client.release()
    }
    for (let index = 0; index < ids.length; index += 5) {
      const outcomes = await Promise.all(ids.slice(index, index + 5).map((id) => processOne(pool, id)))
      for (const outcome of outcomes) {
        if (outcome.skipped) {
          stats.skipped++
          stats.reasons.set(outcome.skipped, (stats.reasons.get(outcome.skipped) || 0) + 1)
        } else {
          stats.split++
          stats.cards += outcome.cards
        }
      }
    }
    if (!SKIP_GROUP_BACKFILL) {
      const backfillClient = await pool.connect()
      try {
        await backfillClient.query('BEGIN')
        stats.q1Grouped = await backfillSingleItemGroups(backfillClient)
        if (APPLY) await backfillClient.query('COMMIT')
        else await backfillClient.query('ROLLBACK')
      } finally {
        backfillClient.release()
      }
    }
    log(`结果: 已拆 ${stats.split} 行，新增/保留单件 ${stats.cards} 行，补齐单件分组 ${stats.q1Grouped} 行，跳过 ${stats.skipped} 行`)
    if (stats.reasons.size) log(`跳过原因: ${[...stats.reasons.entries()].map(([reason, count]) => `${reason}=${count}`).join('；')}`)
    if (!APPLY) log(`${EXERCISE ? 'EXERCISE' : 'DRY-RUN'} 已回滚，未写入任何数据。`)
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[SPLIT-DEPOSIT-CARDS] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  buildTreatmentCardAllocationPlan,
  conversionConsumesSource,
  serviceReservationAfterSplit,
  treatmentHistoryConsumption,
}
