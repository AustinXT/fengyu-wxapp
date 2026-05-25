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

  test('店长查看待审批转店申请（含目标门店）', async () => {
    const ctx = createManagerCtx()

    pg.query.mockResolvedValueOnce([{
      request_id: 'req-001',
      user_id: 'u1',
      from_store_id: 'store-001',
      from_store_name: '凤御A店',
      to_store_id: 'store-002',
      to_store_name: '凤御B店',
      note: '搬家了',
      created_at: '2024-01-15',
      phone: '13800001111',
    }])

    await storeRoutes.unbindRequests(ctx)

    expect(ctx.result.requests).toHaveLength(1)
    // 手机号应脱敏
    expect(ctx.result.requests[0].phoneMasked).toBe('138****1111')
    expect(ctx.result.requests[0].toStoreName).toBe('凤御B店')
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

  test('审批通过转店申请 → 改绑到目标门店', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1',
        from_store_id: 'store-001',
        to_store_id: 'store-002',
        status: '待处理',
      }])
      .mockResolvedValueOnce([{ store_id: 'store-002' }]) // 目标店存在且营业中

    // 事务内：先 CAS UPDATE store_unbind_requests（rowCount=1），再 UPDATE client_wechat_users
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => {
      return await cb({ query: clientQuery })
    })

    await storeRoutes.approveUnbind(ctx)
    expect(ctx.result.success).toBe(true)
    // 第二条 UPDATE 应把 bound_store_id 改为目标店（而非 NULL）
    const bindUpd = clientQuery.mock.calls[1]
    expect(bindUpd[0]).toMatch(/UPDATE client_wechat_users SET bound_store_id = \$1/)
    expect(bindUpd[1][0]).toBe('store-002')
  })

  test('CAS 守卫：申请已被他人审批 → 抛 INVALID_STATE 且不改绑顾客', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1',
        from_store_id: 'store-001',
        to_store_id: 'store-002',
        status: '待处理',
      }])
      .mockResolvedValueOnce([{ store_id: 'store-002' }])

    // 事务内：CAS UPDATE 命中 0 行（被另一会话先翻），第二个 UPDATE 不应被调用
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = { query: clientQuery }
      return await cb(client)
    })

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests/)
    // 只调了 CAS UPDATE 一次，client_wechat_users 没被改绑
    expect(clientQuery).toHaveBeenCalledTimes(1)
  })

  test('申请缺少目标门店 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      user_id: 'u1',
      from_store_id: 'store-001',
      to_store_id: null, // 历史/异常数据无目标店
      status: '待处理',
    }])

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_STATE.*目标门店/)
  })

  test('目标门店已停业 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1',
        from_store_id: 'store-001',
        to_store_id: 'store-002',
        status: '待处理',
      }])
      .mockResolvedValueOnce([]) // 目标店查不到（已停业/不存在）

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*目标门店不存在或已停业/)
  })

  test('非本门店申请拒绝审批', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      user_id: 'u1',
      from_store_id: 'store-other', // 不是当前门店
      to_store_id: 'store-002',
      status: '待处理',
    }])

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非 pending 状态拒绝审批', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      user_id: 'u1',
      from_store_id: 'store-001',
      to_store_id: 'store-002',
      status: '已通过', // 已审批
    }])

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许审批/)
  })

  test('缺少 requestId 时拒绝（line 80 TRUE 分支）', async () => {
    const ctx = createManagerCtx({})

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*requestId/)
  })

  test('申请不存在时拒绝（line 86 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ requestId: 'req-nonexist' })

    pg.query.mockResolvedValueOnce([]) // 查不到申请

    await expect(storeRoutes.approveUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*申请不存在/)
  })
})

describe('store.rejectUnbind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('拒绝解绑申请', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001', rejectReason: '不允许' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: null,
      from_store_id: 'store-001',
      status: '待处理',
    }])
    // 事务内 CAS UPDATE（rowCount=1）+ 审计日志
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await storeRoutes.rejectUnbind(ctx)
    expect(ctx.result.success).toBe(true)
  })

  test('CAS 守卫：申请已被他人改 → 抛 INVALID_STATE', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001', rejectReason: '不允许' })

    pg.query
      .mockResolvedValueOnce([{
        from_store_id: 'store-001',
        status: '待处理',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests/)
  })

  test('缺少 requestId 拒绝', async () => {
    const ctx = createManagerCtx({})

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*requestId/)
  })

  test('申请不存在时拒绝（line 123 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ requestId: 'req-nonexist' })

    pg.query.mockResolvedValueOnce([])

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*申请不存在/)
  })

  test('非本门店申请拒绝审批（line 125 PERMISSION_DENIED）', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      from_store_id: 'store-other',
      status: '待处理',
    }])

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非 pending 状态拒绝审批（line 126 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ requestId: 'req-001' })

    pg.query.mockResolvedValueOnce([{
      from_store_id: 'store-001',
      status: '已拒绝',
    }])

    await expect(storeRoutes.rejectUnbind(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许审批/)
  })
})
