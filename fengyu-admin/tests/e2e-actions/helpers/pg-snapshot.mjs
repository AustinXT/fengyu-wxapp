/**
 * 关键表行快照 + before/after diff，用于断言云函数副作用。
 *
 * snapshot(specs)
 *   specs: { tableName: { where: 'SQL fragment', params: [...] } }
 *
 *   返回 { tableName: rows[] }，rows 已按主键稳定排序方便 diff
 *
 * diff(before, after)
 *   返回 { tableName: { added, removed, addedRows, removedRows,
 *                       rowsBefore, rowsAfter } }
 */
import { pgQuery } from '../setup.mjs'

// 已知表的稳定排序键（影响 diff 结果展示但不影响行差集）
const STABLE_ORDER = {
  point_transactions: 'id',
  operation_logs: 'id',
  sale_orders: 'sale_order_id',
  sale_items: 'sale_item_id',
  sale_order_payments: 'id',
  sale_allocations: 'id',
  client_wechat_users: 'user_id',
  staff_wechat_users: 'employee_id',
  prepaid_cards: 'card_id',
  card_transactions: 'id',
}

export async function snapshot(specs) {
  const out = {}
  for (const [table, spec] of Object.entries(specs)) {
    const order = STABLE_ORDER[table] || '1'
    const where = spec.where ? `WHERE ${spec.where}` : ''
    const sql = `SELECT * FROM ${table} ${where} ORDER BY ${order}`
    out[table] = await pgQuery(sql, spec.params || [])
  }
  return out
}

function keyOf(table, row) {
  const k = STABLE_ORDER[table]
  if (k && row[k] !== undefined) return String(row[k])
  return JSON.stringify(row)
}

export function diff(before, after) {
  const result = {}
  const allTables = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const table of allTables) {
    const beforeRows = before[table] || []
    const afterRows = after[table] || []
    const beforeMap = new Map(beforeRows.map((r) => [keyOf(table, r), r]))
    const afterMap = new Map(afterRows.map((r) => [keyOf(table, r), r]))

    const addedRows = []
    for (const [k, r] of afterMap) {
      if (!beforeMap.has(k)) addedRows.push(r)
    }
    const removedRows = []
    for (const [k, r] of beforeMap) {
      if (!afterMap.has(k)) removedRows.push(r)
    }
    // 列级 changed：相同 key 的 row 字段值变化（忽略 updated_at 抖动）
    const changedRows = []
    for (const [k, ar] of afterMap) {
      const br = beforeMap.get(k)
      if (!br) continue
      const changes = {}
      for (const col of Object.keys(ar)) {
        if (col === 'updated_at') continue
        const a = ar[col]
        const b = br[col]
        const aS = a instanceof Date ? a.toISOString() : a
        const bS = b instanceof Date ? b.toISOString() : b
        if (JSON.stringify(aS) !== JSON.stringify(bS)) {
          changes[col] = { before: bS, after: aS }
        }
      }
      if (Object.keys(changes).length) changedRows.push({ key: k, changes })
    }
    result[table] = {
      rowsBefore: beforeRows.length,
      rowsAfter: afterRows.length,
      added: addedRows.length,
      removed: removedRows.length,
      changed: changedRows.length,
      addedRows,
      removedRows,
      changedRows,
    }
  }
  return result
}

/**
 * 简洁打印一个 diff（用于失败时输出诊断）
 */
export function fmtDiff(d) {
  const lines = []
  for (const [table, info] of Object.entries(d)) {
    lines.push(
      `  ${table}: before=${info.rowsBefore} after=${info.rowsAfter} +${info.added} -${info.removed} ~${info.changed || 0}`,
    )
    if (info.addedRows.length) {
      lines.push(`    + ${JSON.stringify(info.addedRows).slice(0, 400)}`)
    }
    if (info.removedRows.length) {
      lines.push(`    - ${JSON.stringify(info.removedRows).slice(0, 400)}`)
    }
    if (info.changedRows && info.changedRows.length) {
      for (const c of info.changedRows) {
        lines.push(`    ~ key=${c.key}: ${JSON.stringify(c.changes).slice(0, 400)}`)
      }
    }
  }
  return lines.join('\n')
}
