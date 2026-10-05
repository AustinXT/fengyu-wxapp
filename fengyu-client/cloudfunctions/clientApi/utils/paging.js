/** clientApi 内部独立分页工具，不与其它端共享。 */
const MAX_PAGE_SIZE = 50
const MAX_LIST_ROWS = 1000
const BOUNDED_LIST_FETCH_LIMIT = MAX_LIST_ROWS + 1

function normalizePaging(payload = {}) {
  const page = payload.page === undefined ? 1 : payload.page
  const requestedSize = payload.pageSize === undefined ? 20 : payload.pageSize
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 1) {
    throw new Error('INVALID_PARAMS: page 和 pageSize 必须为正整数')
  }
  const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) throw new Error('INVALID_PARAMS: 分页偏移量过大')
  return { page, pageSize, offset }
}

// 旧接口无翻页入口，不能把超上限权益静默隐藏。多读一条只用于判定溢出。
function assertBoundedList(rows) {
  if (rows.length > MAX_LIST_ROWS) {
    throw new Error('INVALID_STATE: 记录数量超过单次查询上限，请联系门店处理')
  }
  return rows
}

module.exports = { normalizePaging, assertBoundedList, BOUNDED_LIST_FETCH_LIMIT, MAX_LIST_ROWS }
