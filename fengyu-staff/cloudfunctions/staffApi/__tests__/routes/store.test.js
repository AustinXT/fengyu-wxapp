/**
 * 门店路由测试
 * 覆盖：list / unbindRequests / approveUnbind / rejectUnbind
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx, createCtx } = require('../helpers')
const storeRoutes = require('../../routes/store')

describe('store.list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('返回所有营业中门店', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([
      { store_id: 's1', store_name: '凤御A店', market_name: '华东市场' },
      { store_id: 's2', store_name: '凤御B店', market_name: '华南市场' },
    ])

    await storeRoutes.list(ctx)

    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].storeId).toBe('s1')
    expect(ctx.result[0].storeName).toBe('凤御A店')
    expect(ctx.result[0].marketName).toBe('华东市场')
  })

  test('无门店时返回空数组', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([])

    await storeRoutes.list(ctx)
    expect(ctx.result).toEqual([])
  })
})

describe('store.unbindRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长查看待审批解绑申请', async () => {
    const ctx = createManagerCtx()

    pg.query.mockResolvedValueOnce([{
      request_id: 'req-001',
      user_id: 'u1',
      from_store_id: 'store-001',
      from_store_name: '凤御A店',
      note: '搬家了',
      created_at: '2024-01-15',
      phone: '13800001111',
    }])

    await storeRoutes.unbindRequests(ctx)

    expect(ctx.result.requests).toHaveLength(1)
    // 手机号应脱敏
    expect(ctx.result.requests[0].phoneMasked).toBe('138****1111')
  })

  test('非店长拒绝查看', async () => {
    const ctx = createBeauticianCtx()

    await expect(storeRoutes.unbindRequests(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('store.approveUnbind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('审批通过解绑申请', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1',
        from_store_id: 'store-001',
        status: 'pending',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE client_wechat_users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE store_unbind_requests

    await storeRoutes.approveUnbind(ctx)
    expect(ctx.result.success).toBe(true)
  })

  test('非本门店申请拒绝审批', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      user_id: 'u1',
      from_store_id: 'store-other', // 不是当前门店
      status: 'pending',
    }])

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非 pending 状态拒绝审批', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      user_id: 'u1',
      from_store_id: 'store-001',
      status: 'approved', // 已审批
    }])

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许审批/)
  })
})

describe('store.rejectUnbind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('拒绝解绑申请', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001', rejectReason: '不允许' })

    pg.query
      .mockResolvedValueOnce([{
        from_store_id: 'store-001',
        status: 'pending',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await storeRoutes.rejectUnbind(ctx)
    expect(ctx.result.success).toBe(true)
  })

  test('缺少 requestId 拒绝', async () => {
    const ctx = createManagerCtx({})

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*requestId/)
  })
})
