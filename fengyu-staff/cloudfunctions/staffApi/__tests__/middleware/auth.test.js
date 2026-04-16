/**
 * 认证中间件测试
 * 覆盖：auth / requireStaffBound / requireManager / invalidateAuthCache
 */



const cloud = globalThis.__mocks__.cloud
const pg = globalThis.__mocks__.pg
const { auth, requireStaffBound, requireManager, invalidateAuthCache } = require('../../middleware/auth')

describe('auth 中间件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清除模块内部缓存（通过 invalidateAuthCache 间接实现）
    invalidateAuthCache('test-openid-001')
    invalidateAuthCache('staff-openid-001')
    invalidateAuthCache('resigned-openid')
    invalidateAuthCache('')
  })

  test('有效 openid 填充 ctx.auth（活跃员工）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'staff-openid-001' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-001',
        phone: '13800001111',
        name: '张三',
        position_name: '门店经理',
        store_id: 'store-001',
        is_resigned: false,
        skills: ['美容师', '推广师'],
        store_name: '凤御测试店',
        market_name: '华东市场',
        department: '美容部',
      }])
      .mockResolvedValueOnce([{ role: 'manager' }])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    let called = false
    await auth(ctx, async () => { called = true })

    expect(called).toBe(true)
    expect(ctx.auth.openid).toBe('staff-openid-001')
    expect(ctx.auth.phone).toBe('13800001111')
    expect(ctx.auth.staffWfId).toBe('emp-001')
    expect(ctx.auth.storeId).toBe('store-001')
    expect(ctx.auth.roles).toEqual(['manager'])
    expect(ctx.auth.position).toBe('门店经理')
    expect(ctx.auth.storeName).toBe('凤御测试店')
    expect(ctx.auth.marketName).toBe('华东市场')
    expect(ctx.auth.department).toBe('美容部')
    expect(ctx.auth.skills).toEqual(['美容师', '推广师'])
  })

  test('skills 为 null 兜底为空数组（P2-14 Q5）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'staff-openid-no-skills' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-no-skills',
        phone: '13800003333',
        name: '无技能员工',
        position_name: '美容师',
        store_id: 'store-001',
        is_resigned: false,
        skills: null,
        store_name: '凤御测试店',
        market_name: '华东市场',
        department: '美容部',
      }])
      .mockResolvedValueOnce([])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})

    expect(ctx.auth.skills).toEqual([])

    invalidateAuthCache('staff-openid-no-skills')
  })

  test('未注册 openid 返回空 auth（新用户）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-user-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    let called = false
    await auth(ctx, async () => { called = true })

    expect(called).toBe(true)
    expect(ctx.auth.openid).toBe('new-user-openid')
    expect(ctx.auth.phone).toBeNull()
    expect(ctx.auth.staffWfId).toBeNull()
    expect(ctx.auth.roles).toEqual([])
    expect(ctx.auth.skills).toEqual([])

    // 清理
    invalidateAuthCache('new-user-openid')
  })

  test('离职员工视为未关联', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'resigned-openid' })
    pg.query.mockResolvedValueOnce([{
      employee_id: 'emp-resigned',
      phone: '13900009999',
      name: '李四',
      position_name: '美容师',
      store_id: 'store-002',
      is_resigned: true,
      store_name: '另一店',
      market_name: '华南市场',
      department: '美容部',
    }])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffWfId).toBeNull()
    expect(ctx.auth.storeId).toBeNull()
    expect(ctx.auth.roles).toEqual([])
    expect(ctx.auth.position).toBeNull()
  })

  test('无 OPENID 抛出 UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' })
    const ctx = { event: {}, context: {}, auth: {}, result: null }

    await expect(auth(ctx, async () => {}))
      .rejects.toThrow(/UNAUTHORIZED/)
  })

  test('_testOpenid 覆盖真实 OPENID', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'real-openid' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-test',
        phone: '13800002222',
        name: '测试员工',
        position_name: '美容师',
        store_id: 'store-001',
        is_resigned: false,
        store_name: '测试店',
        market_name: '测试市场',
        department: null,
      }])
      .mockResolvedValueOnce([])

    const ctx = {
      event: { payload: { _testOpenid: 'test-override-openid' } },
      context: {},
      auth: {},
      result: null,
    }
    await auth(ctx, async () => {})

    expect(ctx.auth.openid).toBe('test-override-openid')
    // 查询用的是 test-override-openid
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE u.openid = $1'),
      ['test-override-openid']
    )

    invalidateAuthCache('test-override-openid')
  })

  test('缓存命中时不查询数据库', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'cached-openid' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-cached',
        phone: '138',
        name: 'cached',
        position_name: '美容师',
        store_id: 's1',
        is_resigned: false,
        store_name: 'S1',
        market_name: 'M1',
        department: null,
      }])
      .mockResolvedValueOnce([])

    const ctx1 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx1, async () => {})
    expect(pg.query).toHaveBeenCalledTimes(2) // staff + roles

    vi.clearAllMocks()

    // 第二次调用应命中缓存
    const ctx2 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx2, async () => {})
    expect(pg.query).not.toHaveBeenCalled()
    expect(ctx2.auth.openid).toBe('cached-openid')

    invalidateAuthCache('cached-openid')
  })
})

describe('requireStaffBound', () => {
  test('已绑定员工通过', async () => {
    const ctx = {
      auth: { phone: '13800001111', staffWfId: 'emp-001' },
    }
    let called = false
    await requireStaffBound()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('未绑定手机号抛出 PHONE_REQUIRED', async () => {
    const ctx = { auth: { phone: null, staffWfId: null } }
    await expect(requireStaffBound()(ctx, async () => {}))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('手机号已绑但无员工档案抛出 UNAUTHORIZED', async () => {
    const ctx = { auth: { phone: '138', staffWfId: null } }
    await expect(requireStaffBound()(ctx, async () => {}))
      .rejects.toThrow(/UNAUTHORIZED/)
  })
})

describe('requireManager', () => {
  test('店长角色通过', async () => {
    const ctx = {
      auth: { staffWfId: 'emp-001', roles: ['manager'] },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('非店长拒绝（PERMISSION_DENIED）', async () => {
    const ctx = {
      auth: { staffWfId: 'emp-002', roles: [] },
    }
    await expect(requireManager()(ctx, async () => {}))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('无员工档案抛出 UNAUTHORIZED', async () => {
    const ctx = {
      auth: { staffWfId: null, roles: [] },
    }
    await expect(requireManager()(ctx, async () => {}))
      .rejects.toThrow(/UNAUTHORIZED/)
  })
})

describe('invalidateAuthCache', () => {
  test('清除缓存后重新查询数据库', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'cache-test-openid' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-c',
        phone: '138',
        name: 'C',
        position_name: '美容师',
        store_id: 's1',
        is_resigned: false,
        store_name: 'S1',
        market_name: 'M1',
        department: null,
      }])
      .mockResolvedValueOnce([])

    const ctx1 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx1, async () => {})

    vi.clearAllMocks()

    // 清除缓存
    invalidateAuthCache('cache-test-openid')

    // 重新设置 mock
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-c',
        phone: '138',
        name: 'C-updated',
        position_name: '门店经理',
        store_id: 's1',
        is_resigned: false,
        store_name: 'S1',
        market_name: 'M1',
        department: null,
      }])
      .mockResolvedValueOnce([{ role: 'manager' }])

    const ctx2 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx2, async () => {})

    // 应重新查询
    expect(pg.query).toHaveBeenCalled()
    expect(ctx2.auth.roles).toEqual(['manager'])

    invalidateAuthCache('cache-test-openid')
  })
})
