#!/usr/bin/env node

/**
 * 修复历史寄存疗程卡拆分后的单卡余额/引用错位，并清理终态服务残留预扣。
 *
 * 安全约束：
 * - 默认 DRY-RUN，只有显式 --apply 才提交；--exercise 执行完整写路径后回滚。
 * - 按分组独立事务处理；存在“服务中/待客户确认”的分组直接跳过，避免停机和改写活跃业务。
 * - 仅以已完成服务和未关闭/未作废转换为真实消耗，重新绑定历史引用并重算每张卡余额。
 * - 每个实际修改的分组以及终态预扣清理都会写 operation_logs，脚本可重复执行。
 *
 * 用法：
 *   DATABASE_URL='postgresql://...' node db/scripts/repair-split-treatment-card-integrity.js
 *   DATABASE_URL='postgresql://...' node db/scripts/repair-split-treatment-card-integrity.js --exercise
 *   DATABASE_URL='postgresql://...' node db/scripts/repair-split-treatment-card-integrity.js --apply
 *   DATABASE_URL='postgresql://...' node db/scripts/repair-split-treatment-card-integrity.js \
 *     --group-id XSLSH-WX-202607310757 --apply
 *   DATABASE_URL='postgresql://...' node db/scripts/repair-split-treatment-card-integrity.js \
 *     --apply --retry-active --retry-interval-ms 30000 --max-retries 120
 */

'use strict'

const { Pool } = require('pg')

const ACTIVE_SERVICE_STATUSES = new Set(['服务中', '待客户确认'])
const CLOSED_CONVERSION_STATUSES = new Set(['已关闭', '已作废'])
const APPLY = process.argv.includes('--apply')
const EXERCISE = process.argv.includes('--exercise')

function log(message) {
  console.log(`[REPAIR-SPLIT-CARDS] ${message}`)
}

function redactConnectionString(value) {
  return value.replace(/(\/\/[^:/?#]+:)[^@/]+@/, '$1***@')
}

function parseRepeatedOption(args, name) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`)
    values.push(value)
    index++
  }
  return [...new Set(values)]
}

function parseIntegerOption(args, name, fallback, { min = 0 } = {}) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} 必须是不小于 ${min} 的整数`)
  return value
}

function int(value, field, id) {
  const result = Number(value)
  if (!Number.isInteger(result)) throw new Error(`INVALID_INTEGER: ${id}.${field}=${String(value)}`)
  return result
}

function timestamp(value, fallback, id) {
  const date = value ?? fallback
  const result = new Date(date).getTime()
  if (!Number.isFinite(result)) throw new Error(`INVALID_TIMESTAMP: ${id}=${String(date)}`)
  return result
}

function conversionConsumesSource(child) {
  return !CLOSED_CONVERSION_STATUSES.has(child.child_order_status)
}

function sortCards(cards, recordedCardIds, groupId) {
  const order = new Map((recordedCardIds || []).map((id, index) => [id, index]))
  return [...cards].sort((left, right) => {
    const leftOrder = order.get(left.sale_item_id)
    const rightOrder = order.get(right.sale_item_id)
    if (leftOrder != null || rightOrder != null) {
      if (leftOrder == null) return 1
      if (rightOrder == null) return -1
      return leftOrder - rightOrder
    }
    if (left.sale_item_id === groupId) return -1
    if (right.sale_item_id === groupId) return 1
    return left.sale_item_id.localeCompare(right.sale_item_id)
  })
}

/**
 * 将一条历史消耗完整放到一张卡上。拆分后的线上数据中单条用量均不大于单卡容量；
 * 保持记录不拆行，避免改变服务提成等关联记录的主键关系。
 */
function assignConsumption(cards, event) {
  const target = cards.find((card) => (
    card.remaining >= event.quantity && card.paidRemaining >= event.quantity
  ))
  if (!target) {
    throw new Error(`EVENT_CAPACITY_OVERFLOW: ${event.type}.${event.id}=${event.quantity}`)
  }
  target.remaining -= event.quantity
  target.paidRemaining -= event.quantity
  return target.saleItemId
}

function buildGroupRepairPlan({ cards, services, children }) {
  const workingCards = cards.map((card) => {
    const capacity = int(card.session_count, 'session_count', card.sale_item_id)
    const paid = card.paid_sessions == null
      ? capacity
      : int(card.paid_sessions, 'paid_sessions', card.sale_item_id)
    if (capacity <= 0 || paid < 0 || paid > capacity) {
      throw new Error(`INVALID_CARD_CAPACITY: ${card.sale_item_id} capacity=${capacity} paid=${paid}`)
    }
    return { saleItemId: card.sale_item_id, capacity, remaining: capacity, paidRemaining: paid }
  })

  const events = []
  for (const service of services) {
    if (service.service_status !== '已完成') continue
    const quantity = int(service.session_used, 'session_used', service.service_item_id)
    if (quantity <= 0) throw new Error(`INVALID_SERVICE_USAGE: ${service.service_item_id}=${quantity}`)
    events.push({
      type: 'service',
      id: service.service_item_id,
      quantity,
      at: timestamp(service.completed_at, service.created_at, service.service_item_id),
    })
  }
  for (const child of children) {
    if (!conversionConsumesSource(child)) continue
    const quantity = Math.abs(int(child.quantity, 'quantity', child.sale_item_id))
    if (quantity <= 0) throw new Error(`INVALID_CONVERSION_USAGE: ${child.sale_item_id}=${quantity}`)
    events.push({
      type: 'conversion',
      id: child.sale_item_id,
      quantity,
      at: timestamp(child.created_at, child.sale_order_datetime, child.sale_item_id),
    })
  }
  events.sort((left, right) => left.at - right.at || left.type.localeCompare(right.type) || left.id.localeCompare(right.id))

  const serviceTargets = new Map()
  const conversionTargets = new Map()
  for (const event of events) {
    const target = assignConsumption(workingCards, event)
    if (event.type === 'service') serviceTargets.set(event.id, target)
    else conversionTargets.set(event.id, target)
  }

  // 待服务本身不占余额，但应落在一张当前确有可用已付次数的卡上，避免修复后仍无法开始。
  for (const service of services) {
    if (service.service_status !== '待服务') continue
    const quantity = int(service.session_used, 'session_used', service.service_item_id)
    const target = workingCards.find((card) => (
      card.remaining >= quantity && card.paidRemaining >= quantity
    ))
    if (!target) throw new Error(`PENDING_SERVICE_CAPACITY_OVERFLOW: ${service.service_item_id}=${quantity}`)
    serviceTargets.set(service.service_item_id, target.saleItemId)
  }

  return {
    remainingByCardId: new Map(workingCards.map((card) => [card.saleItemId, card.remaining])),
    serviceTargets,
    conversionTargets,
  }
}

async function assertSchema(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('sale_items', 'sale_item_group_id'),
          ('service_items', 'reserved_at')
        )`,
  )
  const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
  for (const expected of ['sale_items.sale_item_group_id', 'service_items.reserved_at']) {
    if (!found.has(expected)) throw new Error(`SCHEMA_MISSING: ${expected}`)
  }
}

async function findMismatchedGroupIds(client, targetGroupIds, limit) {
  const params = []
  let targetFilter = ''
  if (targetGroupIds.length > 0) {
    params.push(targetGroupIds)
    targetFilter = `AND split.group_id = ANY($${params.length})`
  }
  params.push(limit)
  const { rows } = await client.query(
    `WITH split_groups AS (
       SELECT DISTINCT target_id AS group_id
         FROM operation_logs
        WHERE action = 'datafix.splitDepositCards'
          AND target_type = 'sale_item'
     ), completed AS (
       SELECT sit.sale_item_id, SUM(sit.session_used)::int AS used
         FROM service_items sit
         JOIN service_orders so ON so.service_order_id = sit.service_order_id
        WHERE so.status = '已完成'
        GROUP BY sit.sale_item_id
     ), converted AS (
       SELECT child.ref_sale_item_id AS sale_item_id, SUM(ABS(child.quantity))::int AS used
         FROM sale_items child
         JOIN sale_orders child_order ON child_order.sale_order_id = child.sale_order_id
        WHERE child.ref_sale_item_id IS NOT NULL
          AND child.item_direction = '转出'
          AND child_order.status NOT IN ('已关闭', '已作废')
        GROUP BY child.ref_sale_item_id
     )
     SELECT split.group_id
       FROM split_groups split
       JOIN sale_items card
         ON card.sale_item_group_id = split.group_id
        AND card.item_direction = '购买'
       LEFT JOIN completed ON completed.sale_item_id = card.sale_item_id
       LEFT JOIN converted ON converted.sale_item_id = card.sale_item_id
      WHERE card.product_type = '疗程卡'
        ${targetFilter}
     GROUP BY split.group_id
     HAVING bool_or(
       card.remaining_sessions IS DISTINCT FROM
       card.session_count - COALESCE(completed.used, 0) - COALESCE(converted.used, 0)
     )
      ORDER BY split.group_id
      LIMIT $${params.length}`,
    params,
  )
  return rows.map((row) => row.group_id)
}

async function terminalReservationIds(client) {
  const { rows } = await client.query(
    `SELECT sit.service_item_id
       FROM service_items sit
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE sit.reserved_at IS NOT NULL
        AND so.status NOT IN ('服务中', '待客户确认')
      ORDER BY sit.service_item_id`,
  )
  return rows.map((row) => row.service_item_id)
}

async function clearTerminalReservations(client, mode) {
  const ids = await terminalReservationIds(client)
  if (ids.length === 0 || mode === 'dry-run') return ids

  await client.query('BEGIN')
  try {
    const result = await client.query(
      `UPDATE service_items sit
          SET reserved_at = NULL, updated_at = NOW()
         FROM service_orders so
        WHERE so.service_order_id = sit.service_order_id
          AND sit.reserved_at IS NOT NULL
          AND so.status NOT IN ('服务中', '待客户确认')
        RETURNING sit.service_item_id`,
    )
    if (result.rowCount > 0) {
      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('datafix.clearTerminalServiceReservations', 'service_items', 'terminal-reservations', $1::jsonb, 'datafix', NOW())`,
        [JSON.stringify({ _v: 1, count: result.rowCount, serviceItemIds: result.rows.slice(0, 100).map((row) => row.service_item_id) })],
      )
    }
    if (mode === 'apply') await client.query('COMMIT')
    else await client.query('ROLLBACK')
    return result.rows.map((row) => row.service_item_id)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function latestRecordedCardIds(client, groupId) {
  const { rows } = await client.query(
    `SELECT detail
       FROM operation_logs
      WHERE action = 'datafix.splitDepositCards'
        AND target_type = 'sale_item'
        AND target_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [groupId],
  )
  const cardIds = rows[0]?.detail?.cardIds
  return Array.isArray(cardIds) ? cardIds.map(String) : null
}

async function hasActiveService(client, groupId) {
  const { rowCount } = await client.query(
    `SELECT 1
       FROM service_items sit
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
       JOIN sale_items card ON card.sale_item_id = sit.sale_item_id
      WHERE card.sale_item_group_id = $1
        AND so.status IN ('服务中', '待客户确认')
      LIMIT 1`,
    [groupId],
  )
  return rowCount > 0
}

async function loadLockedGroup(client, groupId) {
  const recordedCardIds = await latestRecordedCardIds(client, groupId)
  const { rows: cards } = await client.query(
    `SELECT sale_item_id, sale_item_group_id, product_type, item_direction,
            session_count, remaining_sessions, paid_sessions
       FROM sale_items
      WHERE sale_item_group_id = $1
        AND item_direction = '购买'
      ORDER BY sale_item_id
      FOR UPDATE`,
    [groupId],
  )
  if (cards.length < 2) throw new Error(`INVALID_GROUP_SIZE: ${cards.length}`)
  if (cards.some((card) => card.product_type !== '疗程卡')) throw new Error('NON_TREATMENT_CARD_IN_GROUP')

  const orderedCards = sortCards(cards, recordedCardIds, groupId)
  const cardIds = orderedCards.map((card) => card.sale_item_id)
  const { rows: services } = await client.query(
    `SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.reserved_at,
            sit.created_at, so.status::text AS service_status, so.completed_at
       FROM service_items sit
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE sit.sale_item_id = ANY($1)
      ORDER BY sit.service_item_id
      FOR UPDATE OF sit`,
    [cardIds],
  )
  const { rows: children } = await client.query(
    `SELECT child.sale_item_id, child.ref_sale_item_id, child.quantity, child.created_at,
            child_order.status::text AS child_order_status,
            child_order.sale_order_datetime
       FROM sale_items child
       JOIN sale_orders child_order ON child_order.sale_order_id = child.sale_order_id
      WHERE child.ref_sale_item_id = ANY($1)
        AND child.item_direction = '转出'
      ORDER BY child.sale_item_id
      FOR UPDATE OF child`,
    [cardIds],
  )
  return { cards: orderedCards, services, children }
}

function describeChanges(group, plan) {
  const balances = []
  const services = []
  const conversions = []
  for (const card of group.cards) {
    const after = plan.remainingByCardId.get(card.sale_item_id)
    const before = int(card.remaining_sessions, 'remaining_sessions', card.sale_item_id)
    if (before !== after) balances.push({ saleItemId: card.sale_item_id, before, after })
  }
  for (const service of group.services) {
    const after = plan.serviceTargets.get(service.service_item_id)
    if (after && after !== service.sale_item_id) {
      services.push({ serviceItemId: service.service_item_id, before: service.sale_item_id, after })
    }
  }
  for (const child of group.children) {
    const after = plan.conversionTargets.get(child.sale_item_id)
    if (after && after !== child.ref_sale_item_id) {
      conversions.push({ saleItemId: child.sale_item_id, before: child.ref_sale_item_id, after })
    }
  }
  return { balances, services, conversions }
}

async function applyChanges(client, groupId, changes) {
  for (const change of changes.services) {
    await client.query(
      'UPDATE service_items SET sale_item_id = $2, updated_at = NOW() WHERE service_item_id = $1',
      [change.serviceItemId, change.after],
    )
  }
  for (const change of changes.conversions) {
    await client.query(
      'UPDATE sale_items SET ref_sale_item_id = $2, updated_at = NOW() WHERE sale_item_id = $1',
      [change.saleItemId, change.after],
    )
  }
  for (const change of changes.balances) {
    await client.query(
      'UPDATE sale_items SET remaining_sessions = $2, updated_at = NOW() WHERE sale_item_id = $1',
      [change.saleItemId, change.after],
    )
  }
  const count = changes.services.length + changes.conversions.length + changes.balances.length
  if (count > 0) {
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('datafix.repairSplitTreatmentCardIntegrity', 'sale_item_group', $1, $2::jsonb, 'datafix', NOW())`,
      [groupId, JSON.stringify({ _v: 1, ...changes })],
    )
  }
  return count
}

async function processGroup(pool, groupId, mode) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '3s'")
    if (await hasActiveService(client, groupId)) {
      await client.query('ROLLBACK')
      return { status: 'active', changes: 0 }
    }
    const group = await loadLockedGroup(client, groupId)
    // 行锁取得后再检查一次，封住第一次检查与锁定之间新开始的服务。
    if (await hasActiveService(client, groupId)) {
      await client.query('ROLLBACK')
      return { status: 'active', changes: 0 }
    }
    const plan = buildGroupRepairPlan(group)
    const changes = describeChanges(group, plan)
    const count = mode === 'dry-run' ? (
      changes.services.length + changes.conversions.length + changes.balances.length
    ) : await applyChanges(client, groupId, changes)
    if (mode === 'apply') await client.query('COMMIT')
    else await client.query('ROLLBACK')
    return { status: 'processed', changes: count }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return { status: 'failed', changes: 0, error: error.message }
  } finally {
    client.release()
  }
}

async function runPass(pool, options) {
  const client = await pool.connect()
  let groupIds
  let staleReservationIds
  try {
    groupIds = await findMismatchedGroupIds(client, options.targetGroupIds, options.limit)
    staleReservationIds = await clearTerminalReservations(client, options.mode)
  } finally {
    client.release()
  }

  const stats = { candidates: groupIds.length, processed: 0, active: [], failed: [], changes: 0, terminalReservations: staleReservationIds.length }
  for (let index = 0; index < groupIds.length; index += 5) {
    const batch = groupIds.slice(index, index + 5)
    const outcomes = await Promise.all(batch.map(async (groupId) => ({
      groupId,
      outcome: await processGroup(pool, groupId, options.mode),
    })))
    for (const { groupId, outcome } of outcomes) {
      if (outcome.status === 'processed') {
        stats.processed++
        stats.changes += outcome.changes
      } else if (outcome.status === 'active') {
        stats.active.push(groupId)
      } else {
        stats.failed.push({ groupId, error: outcome.error })
      }
    }
  }
  return stats
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 必须显式指定')
  if (APPLY && EXERCISE) throw new Error('--apply 与 --exercise 不能同时使用')
  const args = process.argv.slice(2)
  const options = {
    mode: APPLY ? 'apply' : EXERCISE ? 'exercise' : 'dry-run',
    targetGroupIds: parseRepeatedOption(args, '--group-id'),
    limit: parseIntegerOption(args, '--limit', 100000, { min: 1 }),
    retryActive: args.includes('--retry-active'),
    retryIntervalMs: parseIntegerOption(args, '--retry-interval-ms', 30000, { min: 1000 }),
    maxRetries: parseIntegerOption(args, '--max-retries', 120, { min: 0 }),
  }
  if (options.retryActive && !APPLY) throw new Error('--retry-active 只能与 --apply 同时使用')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  try {
    const client = await pool.connect()
    try {
      await assertSchema(client)
    } finally {
      client.release()
    }
    log(`目标库: ${redactConnectionString(process.env.DATABASE_URL)}`)
    log(`模式: ${options.mode.toUpperCase()}${options.targetGroupIds.length ? `；指定分组=${options.targetGroupIds.join(',')}` : ''}`)

    let attempt = 0
    while (true) {
      const stats = await runPass(pool, options)
      log(`第 ${attempt + 1} 轮: 候选=${stats.candidates}，处理=${stats.processed}，修改=${stats.changes}，活跃跳过=${stats.active.length}，失败=${stats.failed.length}，终态预扣=${stats.terminalReservations}`)
      if (stats.failed.length > 0) {
        for (const failure of stats.failed.slice(0, 20)) log(`失败 ${failure.groupId}: ${failure.error}`)
        process.exitCode = 1
        break
      }
      if (!options.retryActive || stats.active.length === 0 || attempt >= options.maxRetries) {
        if (stats.active.length > 0) log(`仍活跃分组: ${stats.active.join(',')}`)
        if (options.retryActive && stats.active.length > 0 && attempt >= options.maxRetries) process.exitCode = 2
        break
      }
      attempt++
      log(`${options.retryIntervalMs}ms 后重查 ${stats.active.length} 个活跃分组`)
      options.targetGroupIds = stats.active
      await sleep(options.retryIntervalMs)
    }
    if (options.mode !== 'apply') log(`${options.mode.toUpperCase()} 未提交任何数据。`)
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[REPAIR-SPLIT-CARDS] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  buildGroupRepairPlan,
  conversionConsumesSource,
  sortCards,
}
