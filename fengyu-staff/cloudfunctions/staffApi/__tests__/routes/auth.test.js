/**
 * 认证路由测试
 * 覆盖：login / bindPhone
 */



const cloud = globalThis.__mocks__.cloud
const pg = globalThis.__mocks__.pg
const authRoutes = require('../../routes/auth')

describe('auth.login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'staff-openid-001' })
  })

  test('已注册的活跃员工返回完整信息（含 P2-14 skills）', async () => {
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-001',
        phone: '13800001111',
        name: '张三',
        position_name: '门店经理',
        is_resigned: false,
        skills: ['美容师', '推广师'],
        store_id: 'store-001',
        store_name: '凤御测试店',
        market_name: '华东市场',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE last_login_at
      .mockResolvedValueOnce([{ role: 'manager' }])      // queryRoles

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await authRoutes.login(ctx)

    expect(ctx.result.isNewUser).toBe(false)
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.staffWfId).toBe('emp-001')
    expect(ctx.result.staffName).toBe('张三')
    expect(ctx.result.position).toBe('门店经理')
    expect(ctx.result.roles).toEqual(['manager'])
    expect(ctx.result.skills).toEqual(['美容师', '推广师'])
    expect(ctx.result.boundStoreName).toBe('凤御测试店')
    expect(ctx.result.boundStoreId).toBe('store-001')
  })

  test('未注册用户返回 isNewUser: true', async () => {
    pg.query.mockResolvedValueOnce([]) // 未找到

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await authRoutes.login(ctx)

    expect(ctx.result.isNewUser).toBe(true)
    expect(ctx.result.phone).toBeNull()
    expect(ctx.result.staffWfId).toBeNull()
    expect(ctx.result.roles).toEqual([])
  })

  test('离职员工返回 staffWfId 为 null', async () => {
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-resigned',
        phone: '139',
        name: '离职员工',
        position_name: '美容师',
        is_resigned: true,
        store_id: 'store-001',
        store_name: '测试店',
        market_name: '测试市场',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await authRoutes.login(ctx)

    expect(ctx.result.isNewUser).toBe(false)
    expect(ctx.result.staffWfId).toBeNull()
    expect(ctx.result.staffName).toBeNull()
    expect(ctx.result.roles).toEqual([])
  })

  test('登录更新 last_login_at', async () => {
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-001',
        phone: '138',
        name: 'X',
        position_name: 'Y',
        is_resigned: false,
        store_id: 's1',
        store_name: 'S',
        market_name: 'M',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE
      .mockResolvedValueOnce([])                          // roles

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await authRoutes.login(ctx)

    // 第二次 query 应该是 UPDATE last_login_at
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE staff_wechat_users SET last_login_at'),
      expect.any(Array)
    )
  })

  test('已注册员工返回的 roleBindings 含 scopeName 字段（mgmt-profile 用）', async () => {
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-mgmt-001',
        phone: '13900001111',
        name: '王总',
        position_name: '总经理',
        is_resigned: false,
        skills: [],
        store_id: null,
        store_name: null,
        market_name: null,
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // UPDATE last_login_at
      .mockResolvedValueOnce([
        { role: 'admin', scope_id: 'org-hq', scope_type: '总部', scope_name: '凤御总部' },
        { role: 'manager', scope_id: 'org-store-1', scope_type: '门店', scope_name: '龙岗店' },
      ])  // queryRoleBindings
      .mockResolvedValueOnce([])  // expandScopeStoreIds 内部查询
      .mockResolvedValueOnce([])  // fetchScopedStores

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await authRoutes.login(ctx)

    expect(ctx.result.roleBindings).toEqual([
      { role: 'admin', scopeId: 'org-hq', scopeType: '总部', scopeName: '凤御总部' },
      { role: 'manager', scopeId: 'org-store-1', scopeType: '门店', scopeName: '龙岗店' },
    ])
  })
})

describe('auth.bindPhone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-staff-openid' })
  })

  test('直接传入手机号 — 匹配已有员工行', async () => {
    pg.query
      .mockResolvedValueOnce([])                          // openid 预检：未占用
      .mockResolvedValueOnce([{
        employee_id: 'emp-sync-001',
        openid: null, // 尚未绑定
        name: '同步员工',
        position_name: '美容师',
        is_resigned: false,
        store_id: 'store-001',
        store_name: '测试店',
        market_name: '测试市场',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE openid
      .mockResolvedValueOnce([])                          // queryRoles

    const ctx = {
      event: { payload: { phoneNumber: '13800009999' } },
      context: {},
      auth: {},
      result: null,
    }
    await authRoutes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13800009999')
    expect(ctx.result.staffWfId).toBe('emp-sync-001')
    expect(ctx.result.staffName).toBe('同步员工')
    // 验证 UPDATE 了 openid
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE staff_wechat_users SET openid'),
      ['new-staff-openid', 'emp-sync-001']
    )
  })

  test('手机号已被其他 openid 绑定时拒绝', async () => {
    pg.query
      .mockResolvedValueOnce([])                          // openid 预检：未占用
      .mockResolvedValueOnce([{
        employee_id: 'emp-other',
        openid: 'other-openid-999',
        name: '他人',
        position_name: '美容师',
        is_resigned: false,
        store_id: 's1',
        store_name: 'S',
        market_name: 'M',
      }])

    const ctx = {
      event: { payload: { phoneNumber: '13800009999' } },
      context: {},
      auth: {},
      result: null,
    }

    await expect(authRoutes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已被其他账号绑定/)
  })

  test('未找到已有行 — 自动建档', async () => {
    pg.query.mockResolvedValueOnce([]) // 未找到已有行

    // transaction mock
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [] }) // advisory lock
          .mockResolvedValueOnce({ rows: [] }) // SELECT max employee_id
          .mockResolvedValueOnce({ rows: [] }), // INSERT
      }
      return await cb(client)
    })

    const ctx = {
      event: { payload: { phoneNumber: '13899998888' } },
      context: {},
      auth: {},
      result: null,
    }
    await authRoutes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13899998888')
    // staffWfId 应为新生成的 FY-WX-YYMMDD001 格式
    expect(ctx.result.staffWfId).toMatch(/^FY-WX-\d{6}\d{3}$/)
    expect(ctx.result.staffName).toBeNull()
    expect(ctx.result.roles).toEqual([])
    expect(pg.transaction).toHaveBeenCalled()
  })

  test('缺少 phoneData 和 phoneNumber 抛出 INVALID_PARAMS', async () => {
    const ctx = {
      event: { payload: {} },
      context: {},
      auth: {},
      result: null,
    }

    await expect(authRoutes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*缺少.*phoneData.*phoneNumber/)
  })

  test('CloudID 解密失败抛出 INVALID_PARAMS', async () => {
    const ctx = {
      event: {
        payload: {},
        phoneData: { errCode: -1, errMsg: 'decrypt fail' },
      },
      context: {},
      auth: {},
      result: null,
    }

    await expect(authRoutes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*解密失败/)
  })

  test('CloudID data 为 null 时抛出未解密错误（lines 134-135）', async () => {
    const ctx = {
      event: {
        payload: {},
        phoneData: { data: null }, // 无 errCode 但 data 为 null
      },
      context: {},
      auth: {},
      result: null,
    }

    await expect(authRoutes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*CloudID 未被解密/)
  })

  test('CloudID 方式正常解密手机号', async () => {
    pg.query
      .mockResolvedValueOnce([])                          // openid 预检：未占用
      .mockResolvedValueOnce([{
        employee_id: 'emp-cloud-001',
        openid: null,
        name: 'CloudID员工',
        position_name: '美容师',
        is_resigned: false,
        store_id: 'store-001',
        store_name: '测试店',
        market_name: '测试市场',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce([])

    const ctx = {
      event: {
        payload: {},
        phoneData: {
          data: { purePhoneNumber: '13700001234', phoneNumber: '+8613700001234' },
        },
      },
      context: {},
      auth: {},
      result: null,
    }
    await authRoutes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13700001234')
  })

  test('CloudID purePhoneNumber 为空时降级使用 phoneNumber（line 137 右侧操作数）', async () => {
    pg.query
      .mockResolvedValueOnce([])                          // openid 预检：未占用
      .mockResolvedValueOnce([{
        employee_id: 'emp-cloud-002',
        openid: null,
        name: 'CloudID降级员工',
        position_name: '美容师',
        is_resigned: false,
        store_id: 'store-001',
        store_name: '测试店',
        market_name: '测试市场',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce([])

    const ctx = {
      event: {
        payload: {},
        phoneData: {
          data: { phoneNumber: '+8613700005678' }, // purePhoneNumber 缺失 → 降级
        },
      },
      context: {},
      auth: {},
      result: null,
    }
    await authRoutes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('+8613700005678')
  })

  test('CloudID 解析后手机号均为空时抛出 INVALID_PARAMS（lines 138-139）', async () => {
    const ctx = {
      event: {
        payload: {},
        phoneData: {
          data: { purePhoneNumber: '', phoneNumber: '' },
        },
      },
      context: {},
      auth: {},
      result: null,
    }

    await expect(authRoutes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*无法从 CloudID 获取手机号/)
  })

  test('自动建档当日已有记录时序号递增（generateEmployeeId line 36 TRUE 分支）', async () => {
    pg.query.mockResolvedValueOnce([]) // 未找到已有行 → 走自动建档

    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [] })                                      // advisory lock
          .mockResolvedValueOnce({ rows: [{ employee_id: 'FY-WX-260315001' }] })   // 当日已有 → seq+1
          .mockResolvedValueOnce({ rows: [] }),                                     // INSERT
      }
      return await cb(client)
    })

    const ctx = {
      event: { payload: { phoneNumber: '13800007777' } },
      context: {},
      auth: {},
      result: null,
    }
    await authRoutes.bindPhone(ctx)

    // seq = parseInt('001', 10) + 1 = 2 → 末3位应为 002
    expect(ctx.result.staffWfId).toMatch(/002$/)
    expect(ctx.result.success).toBe(true)
  })
})
