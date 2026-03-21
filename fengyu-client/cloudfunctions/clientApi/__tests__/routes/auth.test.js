/**
 * 认证路由测试
 * 覆盖：login（新/老用户）、bindPhone（CloudID/直传/已绑定拒绝/历史补全）、bindStore（有效/无效门店）、updateProfile（昵称/头像更新+字段截断）
 */

const pg = globalThis.__mocks__.pg
const cloud = globalThis.__mocks__.cloud
const { createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  // 清除路由和 auth 模块缓存
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/auth') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/auth')
})

describe('auth.login', () => {
  test('新用户：创建记录，返回 isNewUser=true', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-openid' })
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(true)
    expect(ctx.result.userId).toBeTruthy()
    expect(ctx.result.phone).toBeNull()
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
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx()
    await routes.login(ctx)

    expect(ctx.result.isNewUser).toBe(false)
    expect(ctx.result.userId).toBe('user-001')
    expect(ctx.result.phone).toBe('13800001111')
    expect(pg.query.mock.calls[1][0]).toContain('UPDATE client_wechat_users')
  })
})

describe('auth.bindPhone', () => {
  test('直接传入手机号绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce({ rowCount: 2 })

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await routes.bindPhone(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.updatedOrdersCount).toBe(2)
  })

  test('CloudID 方式绑定成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
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
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])
    pg.query.mockResolvedValueOnce([{ user_id: 'user-other' }])

    const ctx = createCtx({ payload: { phoneNumber: '13800001111' } })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已被其他用户绑定/)
  })

  test('缺少 phoneData 和 phoneNumber → 报错', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: null }])

    const ctx = createCtx({ payload: {} })
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*phoneData.*phoneNumber/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    // bindPhone 内部先查 users，返回空
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { phoneNumber: '138' } })
    // bindPhone 在 routes/auth.js 内部调用 cloud.getWXContext
    await expect(routes.bindPhone(ctx))
      .rejects.toThrow(/UNAUTHORIZED.*用户不存在/)
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
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
    pg.query.mockResolvedValueOnce([{
      store_id: 'store-001',
      store_name: '凤御测试店',
      market_name: '华东市场',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await routes.bindStore(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.boundStoreId).toBe('store-001')
    expect(ctx.result.boundStoreName).toBe('凤御测试店')
  })

  test('无效门店 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'store-bind-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001', phone: '138' }])
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

describe('auth.updateProfile', () => {
  test('更新昵称成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])  // SELECT
    pg.query.mockResolvedValueOnce([])                          // UPDATE

    const ctx = createCtx({ payload: { name: '张小美' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.name).toBe('张小美')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('name = $')
    expect(updateSql).not.toContain('avatar_url')
  })

  test('更新头像 URL 成功', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { avatarUrl: 'https://cdn.example.com/avatar.jpg' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.avatarUrl).toBe('https://cdn.example.com/avatar.jpg')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('avatar_url = $')
    expect(updateSql).not.toContain('name = $')
  })

  test('同时更新昵称和头像', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { name: '李小红', avatarUrl: 'https://cdn.example.com/img.png' } })
    await routes.updateProfile(ctx)

    expect(ctx.result.success).toBe(true)
    expect(ctx.result.name).toBe('李小红')
    expect(ctx.result.avatarUrl).toBe('https://cdn.example.com/img.png')
    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).toContain('name = $')
    expect(updateSql).toContain('avatar_url = $')
  })

  test('name 超过 50 字截断', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const longName = 'A'.repeat(80)
    const ctx = createCtx({ payload: { name: longName } })
    await routes.updateProfile(ctx)

    expect(ctx.result.name).toHaveLength(50)
  })

  test('avatarUrl 超过 500 字截断', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const longUrl = 'https://cdn.example.com/' + 'x'.repeat(480)
    const ctx = createCtx({ payload: { avatarUrl: longUrl } })
    await routes.updateProfile(ctx)

    expect(ctx.result.avatarUrl).toHaveLength(500)
  })

  test('name 为空白字符串时不更新 name', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })
    pg.query.mockResolvedValueOnce([{ user_id: 'user-001' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { name: '   ', avatarUrl: 'https://cdn.example.com/a.jpg' } })
    await routes.updateProfile(ctx)

    const updateSql = pg.query.mock.calls[1][0]
    expect(updateSql).not.toContain('name = $')
    expect(updateSql).toContain('avatar_url = $')
  })

  test('name 和 avatarUrl 都未提供 → INVALID_PARAMS', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' })

    const ctx = createCtx({ payload: {} })
    await expect(routes.updateProfile(ctx)).rejects.toThrow(/INVALID_PARAMS.*name.*avatarUrl/)
  })

  test('用户不存在 → UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'unknown-openid' })
    pg.query.mockResolvedValueOnce([])  // SELECT 返回空

    const ctx = createCtx({ payload: { name: '测试' } })
    await expect(routes.updateProfile(ctx)).rejects.toThrow(/UNAUTHORIZED.*用户不存在/)
  })
})
