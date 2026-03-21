/**
 * 认证中间件测试
 * 覆盖：auth / requirePhone / invalidateAuthCache / 缓存 TTL / 缓存淘汰
 */

const pg = globalThis.__mocks__.pg
const cloud = globalThis.__mocks__.cloud

// 每次重新加载 auth 模块以清除内部缓存
function loadAuth() {
  delete require.cache[require.resolve('../../middleware/auth')]
  return require('../../middleware/auth')
}

describe('auth 中间件', () => {
  let auth, requirePhone, invalidateAuthCache

  beforeEach(() => {
    vi.clearAllMocks()
    const mod = loadAuth()
    auth = mod.auth
    requirePhone = mod.requirePhone
    invalidateAuthCache = mod.invalidateAuthCache
  })

  test('有效 openid 填充 ctx.auth（已注册用户）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'test-openid-001' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-001',
      phone: '13800001111',
      bound_store_id: 'store-001',
      bound_store_name: '凤御测试店',
      bound_market_name: '华东市场',
    }])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    let called = false
    await auth(ctx, async () => { called = true })

    expect(called).toBe(true)
    expect(ctx.auth.userId).toBe('user-001')
    expect(ctx.auth.phone).toBe('13800001111')
    expect(ctx.auth.boundStoreId).toBe('store-001')
    expect(ctx.auth.boundStoreName).toBe('凤御测试店')
    expect(ctx.auth.boundMarketName).toBe('华东市场')
    expect(ctx.auth.isOpenid).toBe(true)
  })

  test('未注册 openid 返回空 auth（新用户）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-user-openid' })
    pg.query.mockResolvedValueOnce([])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    let called = false
    await auth(ctx, async () => { called = true })

    expect(called).toBe(true)
    expect(ctx.auth.userId).toBeNull()
    expect(ctx.auth.phone).toBeNull()
    expect(ctx.auth.boundStoreId).toBeNull()
    expect(ctx.auth.isOpenid).toBe(true)
  })

  test('无 OPENID 抛出 UNAUTHORIZED', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' })
    const ctx = { event: {}, context: {}, auth: {}, result: null }

    await expect(auth(ctx, async () => {}))
      .rejects.toThrow(/UNAUTHORIZED/)
  })

  test('_testOpenid 覆盖真实 OPENID', async () => {
    const origEnv = process.env.ALLOW_TEST_OPENID
    process.env.ALLOW_TEST_OPENID = 'true'

    // 重新加载 auth 模块以读取新的环境变量
    const freshAuth = loadAuth().auth

    cloud.getWXContext.mockReturnValue({ OPENID: 'real-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-test',
      phone: '13800002222',
      bound_store_id: 'store-001',
      bound_store_name: '测试店',
      bound_market_name: '测试市场',
    }])

    const ctx = {
      event: { payload: { _testOpenid: 'test-override-openid' } },
      context: {},
      auth: {},
      result: null,
    }
    await freshAuth(ctx, async () => {})

    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE u.openid = $1'),
      ['test-override-openid']
    )

    // 还原环境变量
    if (origEnv === undefined) {
      delete process.env.ALLOW_TEST_OPENID
    } else {
      process.env.ALLOW_TEST_OPENID = origEnv
    }
  })

  test('缓存命中时不查询数据库', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'cached-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-cached',
      phone: '138',
      bound_store_id: 's1',
      bound_store_name: 'S1',
      bound_market_name: 'M1',
    }])

    const ctx1 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx1, async () => {})
    expect(pg.query).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()

    const ctx2 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx2, async () => {})
    expect(pg.query).not.toHaveBeenCalled()
    expect(ctx2.auth.userId).toBe('user-cached')
  })

  test('缓存淘汰：超过 200 条清理最早一半', async () => {
    for (let i = 0; i < 201; i++) {
      cloud.getWXContext.mockReturnValue({ OPENID: `flood-${i}` })
      pg.query.mockResolvedValueOnce([{
        user_id: `u-${i}`, phone: null,
        bound_store_id: null, bound_store_name: null, bound_market_name: null,
      }])
      const ctx = { event: {}, context: {}, auth: {}, result: null }
      await auth(ctx, async () => {})
    }

    vi.clearAllMocks()
    cloud.getWXContext.mockReturnValue({ OPENID: 'flood-0' })
    pg.query.mockResolvedValueOnce([])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})
    expect(pg.query).toHaveBeenCalled()
  })
})

describe('requirePhone', () => {
  let requirePhone
  beforeEach(() => {
    requirePhone = loadAuth().requirePhone
  })

  test('有手机号通过', async () => {
    const ctx = { auth: { phone: '13800001111' } }
    let called = false
    await requirePhone()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('无手机号抛出 PHONE_REQUIRED', async () => {
    const ctx = { auth: { phone: null } }
    await expect(requirePhone()(ctx, async () => {}))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })
})

describe('invalidateAuthCache', () => {
  test('清除缓存后重新查询数据库', async () => {
    const { auth, invalidateAuthCache } = loadAuth()

    cloud.getWXContext.mockReturnValue({ OPENID: 'cache-test' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'u-c', phone: '138',
      bound_store_id: 's1', bound_store_name: 'S1', bound_market_name: 'M1',
    }])

    const ctx1 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx1, async () => {})

    vi.clearAllMocks()
    invalidateAuthCache('cache-test')

    pg.query.mockResolvedValueOnce([{
      user_id: 'u-c', phone: '13900009999',
      bound_store_id: 's1', bound_store_name: 'S1', bound_market_name: 'M1',
    }])

    const ctx2 = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx2, async () => {})

    expect(pg.query).toHaveBeenCalled()
    expect(ctx2.auth.phone).toBe('13900009999')
  })
})
