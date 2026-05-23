/**
 * 门店路由测试
 * 覆盖：list、detail、requestUnbind、getUnbindRequest、cancelUnbindRequest、geocode
 */

const https = require('https')
const pg = globalThis.__mocks__.pg
const { createCtx, createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/store')
})

describe('store.list', () => {
  test('返回所有门店列表', async () => {
    pg.query.mockResolvedValueOnce([
      { store_id: 's1', store_name: '凤御A店', market_name: '华东', open_date: '2023-01-15' },
      { store_id: 's2', store_name: '凤御B店', market_name: '华南', open_date: null },
    ])

    const ctx = createCtx({ payload: {} })
    await routes.list(ctx)

    expect(ctx.result.stores).toHaveLength(2)
    expect(ctx.result.stores[0].open_date).toBe('2023年1月')
    expect(ctx.result.stores[1].open_date).toBe('')
  })

  test('按城市筛选', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { city: '华东' } })
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('s.district LIKE')
    expect(pg.query.mock.calls[0][1]).toEqual(['%华东%'])
  })
})

describe('store.detail', () => {
  test('按 storeId 查询门店详情', async () => {
    pg.query
      .mockResolvedValueOnce([{
        store_id: 's1', store_name: '凤御A店', market_name: '华东',
        open_date: '2023-06-01', street_address: '测试路1号',
      }])
      .mockResolvedValueOnce([{ staff_count: 5 }])
      .mockResolvedValueOnce([{ customer_count: 100 }])

    const ctx = createCtx({ payload: { storeId: 's1' } })
    await routes.detail(ctx)

    expect(ctx.result.store.store_name).toBe('凤御A店')
    expect(ctx.result.store.staff_count).toBe(5)
    expect(ctx.result.store.customer_count).toBe(100)
  })

  test('缺少 storeId 和 storeName → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*storeId.*storeName/)
  })

  test('门店不存在 → INVALID_PARAMS', async () => {
    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ staff_count: 0 }])
      .mockResolvedValueOnce([{ customer_count: 0 }])

    const ctx = createCtx({ payload: { storeId: 'nonexistent' } })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店不存在/)
  })
})

describe('store.requestUnbind（转店）', () => {
  test('正常提交转店申请（带 toStoreId）', async () => {
    pg.query
      .mockResolvedValueOnce([{ store_id: 'store-002' }]) // 目标店存在
      .mockResolvedValueOnce([])                          // 无 pending
      .mockResolvedValueOnce([{ request_id: 'req-new' }]) // INSERT RETURNING

    const ctx = createBoundCtx({ toStoreId: 'store-002', note: '搬家了' })
    await routes.requestUnbind(ctx)

    expect(ctx.result.requestId).toBeTruthy()
  })

  test('已有 pending 申请 → INVALID_PARAMS', async () => {
    pg.query
      .mockResolvedValueOnce([{ store_id: 'store-002' }]) // 目标店存在
      .mockResolvedValueOnce([{ request_id: 'req-1' }])   // 已有 pending

    const ctx = createBoundCtx({ toStoreId: 'store-002' })
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/INVALID_PARAMS.*已有待审批/)
  })

  test('缺少 toStoreId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ note: '' })
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/INVALID_PARAMS.*目标门店/)
  })

  test('目标门店与当前门店相同 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ toStoreId: 'store-001' }) // 与 boundStoreId 相同
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/INVALID_PARAMS.*不能与当前门店相同/)
  })

  test('目标门店不存在或已停业 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([]) // 目标店查不到

    const ctx = createBoundCtx({ toStoreId: 'store-999' })
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/INVALID_PARAMS.*目标门店不存在或已停业/)
  })

  test('未绑定门店 → INVALID_PARAMS', async () => {
    const ctx = createCtx({
      payload: { toStoreId: 'store-002' },
      auth: { userId: 'u1', boundStoreId: null },
    })
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/INVALID_PARAMS.*未绑定/)
  })

  test('未登录 → UNAUTHORIZED', async () => {
    const ctx = createCtx({ payload: {}, auth: { userId: null } })
    await expect(routes.requestUnbind(ctx)).rejects.toThrow(/UNAUTHORIZED/)
  })
})

describe('store.getUnbindRequest', () => {
  test('有 pending 申请时返回（含目标门店）', async () => {
    pg.query.mockResolvedValueOnce([{
      request_id: 'req-1', from_store_id: 'store-1', from_store_name: '凤御A店',
      to_store_id: 'store-2', to_store_name: '凤御B店',
      status: '待处理', note: '搬家', created_at: '2025-01-01',
    }])

    const ctx = createBoundCtx({})
    await routes.getUnbindRequest(ctx)

    expect(ctx.result.request.requestId).toBe('req-1')
    expect(ctx.result.request.toStoreId).toBe('store-2')
    expect(ctx.result.request.toStoreName).toBe('凤御B店')
  })

  test('无申请时返回 null', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.getUnbindRequest(ctx)

    expect(ctx.result.request).toBeNull()
  })

  test('未登录时返回 null', async () => {
    const ctx = createCtx({ payload: {}, auth: { userId: null } })
    await routes.getUnbindRequest(ctx)
    expect(ctx.result.request).toBeNull()
  })
})

describe('store.cancelUnbindRequest', () => {
  test('正常取消 pending 申请', async () => {
    pg.query
      .mockResolvedValueOnce([{ user_id: 'user-001', status: '待处理' }])
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ requestId: 'req-1' })
    await routes.cancelUnbindRequest(ctx)

    expect(ctx.result.success).toBe(true)
  })

  test('非本人申请 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{ user_id: 'other-user', status: '待处理' }])

    const ctx = createBoundCtx({ requestId: 'req-1' })
    await expect(routes.cancelUnbindRequest(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非 pending 状态 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', status: '已通过' }])

    const ctx = createBoundCtx({ requestId: 'req-1' })
    await expect(routes.cancelUnbindRequest(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许取消/)
  })

  test('缺少 requestId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.cancelUnbindRequest(ctx)).rejects.toThrow(/INVALID_PARAMS.*requestId/)
  })

  test('申请不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ requestId: 'nonexistent' })
    await expect(routes.cancelUnbindRequest(ctx)).rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })
})

describe('store.geocode', () => {
  // 模拟 https.get 返回指定 body 的 helper
  function mockHttpsResponse(body) {
    vi.spyOn(https, 'get').mockImplementation((_url, callback) => {
      const res = {
        on: vi.fn((event, handler) => {
          if (event === 'data') handler(body)
          if (event === 'end') handler()
          return res
        }),
      }
      callback(res)
      // 返回具有 .on() 方法的 req 对象（供链式 .on('error') 使用）
      return { on: vi.fn().mockReturnThis() }
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('正常返回城市名（去掉"市"字）', async () => {
    mockHttpsResponse(JSON.stringify({
      status: 0,
      result: { address_component: { city: '南昌市' } },
    }))

    const ctx = createCtx({ payload: { latitude: 28.6, longitude: 115.8 } })
    await routes.geocode(ctx)

    expect(ctx.result.city).toBe('南昌')
  })

  test('无"市"字的城市名原样返回', async () => {
    mockHttpsResponse(JSON.stringify({
      status: 0,
      result: { address_component: { city: '北京' } },
    }))

    const ctx = createCtx({ payload: { latitude: 39.9, longitude: 116.4 } })
    await routes.geocode(ctx)

    expect(ctx.result.city).toBe('北京')
  })

  test('API 返回 city 为空时 → 返回空字符串', async () => {
    mockHttpsResponse(JSON.stringify({
      status: 0,
      result: { address_component: { city: '' } },
    }))

    const ctx = createCtx({ payload: { latitude: 28.6, longitude: 115.8 } })
    await routes.geocode(ctx)

    expect(ctx.result.city).toBe('')
  })

  test('API status 非 0 → INVALID_PARAMS', async () => {
    mockHttpsResponse(JSON.stringify({
      status: 110,
      message: 'key不合法',
    }))

    const ctx = createCtx({ payload: { latitude: 28.6, longitude: 115.8 } })
    await expect(routes.geocode(ctx)).rejects.toThrow(/INVALID_PARAMS.*逆地理编码失败/)
  })

  test('缺少 latitude → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: { longitude: 115.8 } })
    await expect(routes.geocode(ctx)).rejects.toThrow(/INVALID_PARAMS.*坐标/)
  })

  test('缺少 longitude → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: { latitude: 28.6 } })
    await expect(routes.geocode(ctx)).rejects.toThrow(/INVALID_PARAMS.*坐标/)
  })
})
