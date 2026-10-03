const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')
const { normalizePaging, assertBoundedList, MAX_LIST_ROWS } = require('../../utils/paging')

beforeEach(() => vi.clearAllMocks())

describe('统一分页校验', () => {
  test.each([null, 2.5, '20', 'abc', true, {}, [], 0, -1, Infinity, NaN, 1e21])('非法 pageSize %s 拒绝', (pageSize) => {
    expect(() => normalizePaging({ pageSize })).toThrow('INVALID_PARAMS:')
  })
  test.each([null, 1.5, '1', 0, -1, 1e21])('非法 page %s 拒绝', (page) => {
    expect(() => normalizePaging({ page })).toThrow('INVALID_PARAMS:')
  })
  test('默认值、上限与安全offset', () => {
    expect(normalizePaging({})).toEqual({ page: 1, pageSize: 20, offset: 0 })
    expect(normalizePaging({ page: 2, pageSize: 100 })).toEqual({ page: 2, pageSize: 50, offset: 50 })
    expect(() => normalizePaging({ page: Number.MAX_SAFE_INTEGER, pageSize: 20 })).toThrow('INVALID_PARAMS:')
  })
  test.each(['message', 'card', 'service', 'order', 'appointment'])('%s.list/history 在任何SQL前拒绝坏分页', async (module) => {
    const routes = require(`../../routes/${module}`)
    const handler = module === 'card' ? routes.history : routes.list
    for (const payload of [{ pageSize: null }, { pageSize: 2.5 }, { page: Number.MAX_SAFE_INTEGER }, { pageSize: 'abc' }]) {
      await expect(handler(createBoundCtx({ cardId: 'card-1', ...payload }))).rejects.toThrow('INVALID_PARAMS:')
    }
    expect(pg.query).not.toHaveBeenCalled()
  })
  test('非分页上限允许1000条，1001条明确报错而非静默隐藏权益', () => {
    const allowed = Array(MAX_LIST_ROWS).fill({})
    expect(assertBoundedList(allowed)).toBe(allowed)
    expect(() => assertBoundedList([...allowed, {}])).toThrow('INVALID_STATE:')
  })
  test.each([
    ['card', 'list', {}, 'cards'],
    ['coupon', 'list', {}, 'coupons'],
    ['coupon', 'available', { items: [{ skuId: 'sku', quantity: 1, price: 1 }], storeId: 'store-001' }, 'coupons'],
    ['order', 'appointableItems', {}, 'items'],
    ['order', 'homeProducts', {}, 'items'],
  ])('%s.%s 的主查询绑定硬上限且溢出报错', async (module, method, payload) => {
    pg.query.mockImplementation(async (sql) => {
      if (sql.includes('LIMIT')) return Array(MAX_LIST_ROWS + 1).fill({})
      return []
    })
    const routes = require(`../../routes/${module}`)
    await expect(routes[method](createBoundCtx(payload))).rejects.toThrow('INVALID_STATE:')
    const limited = pg.query.mock.calls.filter(([sql]) => sql.includes('LIMIT'))
    expect(limited).toHaveLength(1)
    expect(limited[0][1].at(-1)).toBe(MAX_LIST_ROWS + 1)
  })
})
