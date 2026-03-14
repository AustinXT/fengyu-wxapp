/**
 * 认证路由测试
 * 覆盖：login / bindPhone
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('../../db/mssql', () => require('../mocks/mssql'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))


const cloud = require('wx-server-sdk')
const pg = require('../../db/pg')
const authRoutes = require('../../routes/auth')

describe('auth.login', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'staff-openid-001' })
  })

  test('已注册的活跃员工返回完整信息', async () => {
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-001',
        phone: '13800001111',
        name: '张三',
        position_name: '门店经理',
        is_resigned: false,
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
})

describe('auth.bindPhone', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-staff-openid' })
  })

  test('直接传入手机号 — 匹配已有员工行', async () => {
    // 按 phone 查找已有行
    pg.query
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
    pg.query.mockResolvedValueOnce([{
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
        query: jest.fn()
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

  test('CloudID 方式正常解密手机号', async () => {
    pg.query
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
})
