/**
 * 认证路由测试
 * 覆盖：login（新/老用户）、bindPhone（CloudID/直传/已绑定拒绝/历史补全）、bindStore（有效/无效门店）
 */

vi.mock('../../db/pg', () => require('../mocks/pg'))
vi.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const cloud = require('wx-server-sdk')
const pg = require('../../db/pg')
const { createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/auth')
})

describe('auth.login', () => {
  test('新用户：创建记录，返回 isNewUser=true', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-openid' })
    // 查询用户不存在
    pg.query.mockResolvedValueOnce([])
    // INSERT
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(true)
    expect(ctx.result.userId).toBeTruthy()
    expect(ctx.result.phone).toBeNull()
    // 验证 INSERT 调用
    expect(pg.query).toHaveBeenCalledTimes(2)
    expect(pg.query.mock.calls[1][0]).toContain('INSERT INTO client_wechat_users')
  })

  test('老用户：更新登录时间，返回 isNewUser=false', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'existing-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-001',
      phone: '13800001111',
      bound_store_id: 'store-001',
      bound_store_name: '凤御测试店',
      bound_market_name: '华东市场',
    }])
    // UPDATE last_login_at
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(false)
    expect(ctx.result.userId).toBe('user-001')
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.boundStoreId).toBe('store-001')
    expect(pg.query.mock.calls[1][0]).toContain('UPDATE client_wechat_users')
  })
})

describe('auth.bindPhone', () => {
  test('直接传入手机号绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    // 检查手机号未被占用
    pg.query.mockResolvedValueOnce([])
    // UPDATE phone
    pg.query.mockResolvedValueOnce([])
    // 补全历史订单
    pg.query.mockResolvedValueOnce({ rowCount: 2 })

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.updatedOrdersCount).toBe(2)
  })

  test('CloudID 方式绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    // 检查手机号未被占用
    pg.query.mockResolvedValueOnce([])
    // UPDATE phone
    pg.query.mockResolvedValueOnce([])
    // 补全历史订单
    pg.query.mockResolvedValueOnce({ rowCount: 0 })

    const ctx = createCtx({
      payload: {},
      event: {
        phoneData: { data: { purePhoneNumber: '13900009999' } },
      },
    })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13900009999')
  })

  test('手机号已被其他用户绑定 → 拒绝', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    // 手机号已被占用
    pg.query.mockResolvedValueOnce([{ user_id: 'user-other' }])

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已被其他用户绑定/)
  })

  test('缺少 phoneData 和 phoneNumber → 报错', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])

    const ctx = createCtx({ payload: {} })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*phoneData.*phoneNumber/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { phoneNumber: '138' } })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/UNAUTHORIZED/)
  })

  test('CloudID 解密失败 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })

    const ctx = createCtx({
      payload: {},
      event: {
        phoneData: { errCode: -1, errMsg: '解密失败' },
      },
    })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*解密失败/)
  })
})

describe('auth.bindStore', () => {
  test('有效门店绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    // 验证门店存在
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    // UPDATE 绑定
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await routes.bindStore(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.boundStoreId).toBe('store-001')
    expect(ctx.result.boundStoreName).toBe('凤御测试店')
  })

  test('无效门店 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    // 查询用户
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    // 门店不存在
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'invalid-store' } })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*门店不存在/)
  })

  test('缺少 storeId → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })

    const ctx = createCtx({ payload: {} })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*storeId/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await expect(routes.bindStore(ctx))
      .rejects.toThrow(/UNAUTHORIZED/)
  })
})
