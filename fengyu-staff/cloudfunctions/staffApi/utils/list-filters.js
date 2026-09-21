'use strict'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(value) {
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
  const rawPage = Number(payload.page)
  const rawPageSize = Number(payload.pageSize)
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage) || 1) : 1
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.max(1, Math.min(100, Math.trunc(rawPageSize) || defaultPageSize))
    : defaultPageSize
  const keyword = String(payload.keyword || '').trim()
  const startDate = String(payload.startDate || '').trim()
  const endDate = String(payload.endDate || '').trim()

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
    offset: (page - 1) * pageSize,
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
