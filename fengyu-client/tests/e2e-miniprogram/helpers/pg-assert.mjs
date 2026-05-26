// helpers/pg-assert.mjs — PG 状态断言工具
//
// 用法：
//   await assertRowCount('sale_orders', { client_user_id: 'X' }, 1)
//   await assertColumnValue('sale_orders', { sale_order_id: 'X' }, { status: '已支付' })

import { query } from './pg.mjs'

function buildWhere(cond, paramOffset = 0) {
  const keys = Object.keys(cond)
  const where = keys.map((k, i) => `${k} = $${i + 1 + paramOffset}`).join(' AND ')
  const params = keys.map(k => cond[k])
  return { where, params }
}

export async function assertRowCount(table, cond, expectedCount) {
  const { where, params } = buildWhere(cond)
  const rows = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params)
  const actual = rows[0].n
  if (actual !== expectedCount) {
    throw new Error(`[pg-assert] ${table} WHERE ${JSON.stringify(cond)}: expect count=${expectedCount}, got ${actual}`)
  }
}

export async function assertColumnValue(table, cond, expected) {
  const { where, params } = buildWhere(cond)
  const rows = await query(`SELECT ${Object.keys(expected).join(', ')} FROM ${table} WHERE ${where} LIMIT 1`, params)
  if (rows.length === 0) {
    throw new Error(`[pg-assert] ${table} WHERE ${JSON.stringify(cond)}: row not found`)
  }
  for (const [k, v] of Object.entries(expected)) {
    const actual = rows[0][k]
    // 数字宽松比较：PG numeric 返回 '300.00'，spec 常写 300。一律 Number 化对比。
    if (typeof v === 'number' || (!isNaN(Number(v)) && !isNaN(Number(actual)) && String(v).match(/^-?\d/))) {
      if (Number(actual) !== Number(v)) {
        throw new Error(`[pg-assert] ${table}.${k}: expect ${v}, got ${actual}`)
      }
      continue
    }
    if (String(actual) !== String(v)) {
      throw new Error(`[pg-assert] ${table}.${k}: expect ${v}, got ${actual}`)
    }
  }
}

export async function getSingleRow(table, cond) {
  const { where, params } = buildWhere(cond)
  const rows = await query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params)
  return rows[0] ?? null
}
