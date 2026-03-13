/**
 * 云函数入口测试
 * 覆盖：路由分发、缺少 action、未知 action、错误码映射（-401/-403/-400/-1）
 */

vi.mock('../db/pg', () => require('./mocks/pg'))
vi.mock('wx-server-sdk', () => require('./mocks/wx-server-sdk'))

const cloud = require('wx-server-sdk')
const pg = require('../db/pg')

describe('clientApi 入口', () => {
  let main

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    // 重新 require 以清除懒加载缓存
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
    // store.list 查门店列表
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

    vi.resetModules()
    const mainFresh = require('../index').main

    const result = await mainFresh({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(-401)
    expect(result.message).toContain('UNAUTHORIZED')
  })

  test('INVALID_PARAMS 错误映射为 code: -400', async () => {
    // product.skuDetail 缺少 skuId
    const result = await main({
      action: 'product.skuDetail',
      payload: {},
    }, {})

    expect(result.code).toBe(-400)
    expect(result.message).toContain('INVALID_PARAMS')
  })

  test('PHONE_REQUIRED 错误映射为 code: -403', async () => {
    vi.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-user-openid' })
    // 用户存在但未绑定手机号
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-new',
      phone: null,
      bound_store_id: null,
      bound_store_name: null,
      bound_market_name: null,
    }])

    vi.resetModules()
    const mainFresh = require('../index').main

    // order.create 需要手机号
    const result = await mainFresh({
      action: 'order.create',
      payload: { storeId: 's1', items: [{ skuId: 'sku1' }], paymentMethod: 'wechat' },
    }, {})

    expect(result.code).toBe(-403)
    expect(result.message).toContain('PHONE_REQUIRED')
  })

  test('PERMISSION_DENIED 错误映射为 code: -403', async () => {
    // store.cancelUnbindRequest — 不属于该用户的申请
    pg.query
      // cancelUnbindRequest 内部查 request
      .mockResolvedValueOnce([{
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
