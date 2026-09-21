'use strict'

const { safePaging } = require('./paging')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(value) {
  // ⚠️ typeof 守卫不可省：`DATE_RE.test(value)` 会对 value 做 ToString，而
  // `JSON.parse('{"toString": null}')` 这种普通 JSON 对象会让 ToPrimitive 失败抛
  // `TypeError: Cannot convert object to primitive value`（详见 utils/paging.js 同类说明）。
  // 对日期而言非字符串本来就一律 false（`DATE_RE.test(20260801)` 也是 false），
  // 所以这道守卫对既有合法用法**完全等价**，只是把异常路径变成返回 false。
  if (typeof value !== 'string') return false
  if (!DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function normalizeListFilters(payload = {}, defaultPageSize = 20) {
  // 委托 utils/paging 单源（#240）。原先这里自带一套 `Number.isFinite` + `Math.trunc` 的归一，
  // 与 paging.js 语义不一致，且 **page 侧漏**：`isFinite(1e20)` 为真 → `offset = 2e21`，
  // `String(2e21)` 输出指数记法 `"2e+21"` → PG `int8in` 抛
  // `invalid input syntax for type bigint`（500 级），与本 issue 同一个根因。
  // 保留两套实现还会让 invariant `D-search-pagination` 的抄写者面对两个语义不同的模板。
  const { safePage: page, safePageSize: pageSize, offset } = safePaging(
    payload.page,
    payload.pageSize,
    defaultPageSize,
  )
  // `String(raw)` 同样会走 ToPrimitive，同样会被 `{"toString": null}` 抛 TypeError
  // （既有缺陷，5 个 route 模块共用本 normalizer）。非法形状回落空串 = 视作"未提供"，
  // 与下方 `if (startDate && …)` 的既有 truthy 语义一致；数字/布尔等的强转行为不变。
  const toTrimmed = (raw) => {
    try {
      return String(raw || '').trim()
    } catch {
      return ''
    }
  }
  const keyword = toTrimmed(payload.keyword)
  const startDate = toTrimmed(payload.startDate)
  const endDate = toTrimmed(payload.endDate)

  if (startDate && !isValidDate(startDate)) {
    throw new Error('INVALID_PARAMS: startDate 必须为 YYYY-MM-DD 格式')
  }
  if (endDate && !isValidDate(endDate)) {
    throw new Error('INVALID_PARAMS: endDate 必须为 YYYY-MM-DD 格式')
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error('INVALID_PARAMS: startDate 不能晚于 endDate')
  }

  return {
    page,
    pageSize,
    offset,
    keyword,
    keywordPattern: keyword ? `%${escapeLike(keyword)}%` : '',
    phoneKeyword: keyword.replace(/\D/g, ''),
    startDate,
    endDate,
  }
}

function addTimestampDateRange(conditions, params, column, startDate, endDate) {
  if (startDate) {
    params.push(startDate)
    conditions.push(`${column} >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`)
  }
  if (endDate) {
    params.push(endDate)
    conditions.push(`${column} < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`)
  }
}

function addDateRange(conditions, params, column, startDate, endDate) {
  if (startDate) {
    params.push(startDate)
    conditions.push(`${column} >= $${params.length}::date`)
  }
  if (endDate) {
    params.push(endDate)
    conditions.push(`${column} <= $${params.length}::date`)
  }
}

module.exports = {
  isValidDate,
  normalizeListFilters,
  addTimestampDateRange,
  addDateRange,
}
