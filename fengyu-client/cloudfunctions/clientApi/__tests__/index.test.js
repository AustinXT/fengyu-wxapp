/**
 * 云函数入口测试
 * 覆盖：路由分发、缺少 action、未知 action、错误码映射（-401/-403/-400/-1）
 */

const path = require('path')
const pg = globalThis.__mocks__.pg
const cloud = globalThis.__mocks__.cloud

const clientApiDir = path.resolve(__dirname, '..')

/** 仅清除 routes/middleware/index 缓存，保留 db/pg 和 node_modules 的 mock */
function clearClientApiCache() {
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(clientApiDir) && !key.includes('node_modules') && !key.includes('__tests__') && !key.includes('/db/')) {
      delete require.cache[key]
    }
  })
}

describe('clientApi 入口', () => {
  let main

  beforeEach(() => {
    vi.clearAllMocks()
    clearClientApiCache()
    main = require('../index').main

    // 默认：auth 中间件查到已绑定用户
    cloud.getWXContext.mockReturnValue({ OPENID: 'test-openid-001' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-001',
      phone: '13800001111',
      bound_store_id: 'store-001',
      bound_store_name: '凤御测试店',
      bound_market_name: '华东市场',
    }])
  })

  test('缺少 action 返回 code: -1', async () => {
    const result = await main({}, {})
    expect(result.code).toBe(-1)
    expect(result.message).toContain('action')
  })

  test('未知 action 返回 code: -1', async () => {
    const result = await main({ action: 'unknown.method' }, {})
    expect(result.code).toBe(-1)
    expect(result.message).toContain('未知')
  })

  test('成功路由返回 code: 0 + data', async () => {
    pg.query.mockResolvedValueOnce([
      { store_id: 's1', store_name: '店A', market_name: '市场A' },
    ])

    const result = await main({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(0)
    expect(result.message).toBe('success')
    expect(result.data).toBeDefined()
  })

  test('UNAUTHORIZED 错误映射为 code: -401', async () => {
    vi.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: '' })

    clearClientApiCache()
    const mainFresh = require('../index').main

    const result = await mainFresh({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(-401)
    expect(result.message).toContain('UNAUTHORIZED')
  })

  test('INVALID_PARAMS 错误映射为 code: -400', async () => {
    const result = await main({
      action: 'product.skuDetail',
      payload: {},
    }, {})

    expect(result.code).toBe(-400)
    expect(result.message).toContain('INVALID_PARAMS')
  })

  test('PHONE_REQUIRED 错误映射为 code: -403', async () => {
    // 覆盖 auth 返回：用户存在但未绑定手机号
    // beforeEach 已消费第一个 mockResolvedValueOnce（返回有手机号的用户）
    // 需要清缓存+重设 mock 让 auth 中间件获得无手机号的用户
    pg.query.mockReset().mockResolvedValue([])
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-user-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-new',
      phone: null,
      bound_store_id: null,
      bound_store_name: null,
      bound_market_name: null,
    }])

    clearClientApiCache()
    const mainFresh = require('../index').main

    const result = await mainFresh({
      action: 'order.create',
      payload: { storeId: 's1', items: [{ skuId: 'sku1' }], paymentMethod: 'wechat' },
    }, {})

    expect(result.code).toBe(-403)
    expect(result.message).toContain('PHONE_REQUIRED')
  })

  test('PERMISSION_DENIED 错误映射为 code: -403', async () => {
    // auth middleware 已在 beforeEach 中设好 mock
    // cancelUnbindRequest 内部: 查 request → user_id 不匹配
    pg.query.mockResolvedValueOnce([{
      user_id: 'other-user',
      status: 'pending',
    }])

    const result = await main({
      action: 'store.cancelUnbindRequest',
      payload: { requestId: 'req-001' },
    }, {})

    expect(result.code).toBe(-403)
    expect(result.message).toContain('PERMISSION_DENIED')
  })
})
