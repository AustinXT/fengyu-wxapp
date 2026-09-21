/**
 * 云函数入口测试
 * 覆盖：路由分发、缺少 action、未知 action、错误码映射（-401/-403/-400/-1）
 */

const path = require('path')
const crypto = require('crypto')
const pg = globalThis.__mocks__.pg
const cloud = globalThis.__mocks__.cloud

const clientApiDir = path.resolve(__dirname, '..')

function healthPayload(service) {
  const timestamp = String(Date.now())
  const nonce = '12345678-1234-1234-1234-123456789abc'
  return {
    service,
    timestamp,
    nonce,
    signature: crypto.createHmac('sha256', process.env.CLIENT_SECRET)
      .update(`${service}\n${timestamp}\n${nonce}`)
      .digest('hex'),
  }
}

/** 仅清除 routes/middleware/index 缓存，保留 db/pg 和 node_modules 的 mock */
function clearClientApiCache() {
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(clientApiDir) && !key.includes('node_modules') && !key.includes('__tests__') && !key.includes('/db/')) {
      delete require.cache[key]
    }
  })
}

// ===== 双谱系评审 round-5：HTTP-only action 的来源伪造防线 =====
// 路由函数靠断言 event._fromHttp && event._hmacVerified 确认来源，而 ctx.event 就是
// 调用方传进来的 event —— 任何已登录顾客都能用 wx.cloud.callFunction 在 data 里塞这两个
// 字段把断言骗过去，等于完全绕开 HMAC。来源证明不能放在调用方可控的数据里。
describe('HTTP-only action 不可经 cloud.callFunction 调用', () => {
  // 从 index.js 反向读出 allowlist 来驱动用例，而不是再抄一份常量：
  // 抄一份的话，新增第三个 HTTP-only action 时伪造用例不会自动覆盖到它
  // （源码扫描能保住安全性质，保不住行为覆盖）——双谱系评审 round-7。
  const HTTP_ONLY = (() => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8')
    const m = src.match(/HTTP_ACTION_ALLOWLIST = new Set\(\[([^\]]*)\]\)/)
    return m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  })()

  test.each(HTTP_ONLY)('%s：伪造 _fromHttp/_hmacVerified 仍被拒绝', async (action) => {
    const { main } = require('../index')
    const res = await main({
      action,
      _fromHttp: true,
      _hmacVerified: true,
      payload: { saleOrderId: 'FY-001', expectedOutTradeNo: 'FY-001_1' },
    }, {})

    expect(res.code).not.toBe(0)
    expect(res.errorType).toBe('PERMISSION_DENIED')
  })

  test.each(HTTP_ONLY)('%s：不带伪造标记同样被拒绝', async (action) => {
    const { main } = require('../index')
    const res = await main({ action, payload: {} }, {})
    expect(res.code).not.toBe(0)
    expect(res.errorType).toBe('PERMISSION_DENIED')
  })

  // 闸门的全部效力押在 HTTP_ACTION_ALLOWLIST 上，两个方向都会出事：
  //   漏项 → 新增的 HTTP-only action 仍可被 cloud.callFunction 伪造来源调用；
  //   多项 → 误把普通 action 放进去，会直接打断 admin 经 node-sdk 的现有集成
  //          （如 config.invalidateConfig）。
  test('allowlist 与 routes 里的 _fromHttp 断言一一对应', () => {
    const fs = require('fs')
    const path = require('path')

    const indexSrc = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8')
    const listMatch = indexSrc.match(/HTTP_ACTION_ALLOWLIST = new Set\(\[([^\]]*)\]\)/)
    expect(listMatch).toBeTruthy()
    const allowlist = listMatch[1]
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)

    const routesDir = path.resolve(__dirname, '../routes')
    let assertionCount = 0
    for (const f of fs.readdirSync(routesDir)) {
      if (!f.endsWith('.js')) continue
      const src = fs.readFileSync(path.join(routesDir, f), 'utf8')
      assertionCount += (src.match(/if \(!ctx\.event\._fromHttp \|\| ctx\.event\._hmacVerified !== true\)/g) || []).length
    }

    expect(assertionCount).toBe(allowlist.length)
    // admin 经 CloudBase node-sdk（callFunction 路径）调用的 action 绝不能进 allowlist
    expect(allowlist).not.toContain('config.invalidateConfig')
    expect(allowlist).not.toContain('system.health')
  })
})

describe('clientApi 入口', () => {
  let main

  beforeEach(() => {
    process.env.CLIENT_SECRET = 'health-test-secret'
    vi.clearAllMocks()
    clearClientApiCache()
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

  test('system.health 使用 HMAC 签名并跳过 OPENID 鉴权', async () => {
    vi.clearAllMocks()
    const result = await main({ action: 'system.health', payload: healthPayload('clientApi') }, {})
    expect(result.code).toBe(0)
    expect(result.data.ok).toBe(true)
    expect(pg.query).toHaveBeenCalledWith('SELECT 1 AS ok')
    expect(cloud.getWXContext).not.toHaveBeenCalled()
  })

  test('system.health 拒绝无效签名', async () => {
    const result = await main({
      action: 'system.health',
      payload: { ...healthPayload('clientApi'), signature: '0'.repeat(64) },
    }, {})
    expect(result.code).toBe(-401)
    expect(result.errorType).toBe('UNAUTHORIZED')
  })

  test('成功路由返回 code: 0 + data', async () => {
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

    clearClientApiCache()
    const mainFresh = require('../index').main

    const result = await mainFresh({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(-401)
    expect(result.errorType).toBe('UNAUTHORIZED')
  })

  test('INVALID_PARAMS 错误映射为 code: -400', async () => {
    const result = await main({
      action: 'product.skuDetail',
      payload: {},
    }, {})

    expect(result.code).toBe(-400)
    expect(result.errorType).toBe('INVALID_PARAMS')
  })

  test('PHONE_REQUIRED 错误映射为 code: -403', async () => {
    // 覆盖 auth 返回：用户存在但未绑定手机号
    // beforeEach 已消费第一个 mockResolvedValueOnce（返回有手机号的用户）
    // 需要清缓存+重设 mock 让 auth 中间件获得无手机号的用户
    pg.query.mockReset().mockResolvedValue([])
    cloud.getWXContext.mockReturnValue({ OPENID: 'new-user-openid' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'user-new',
      phone: null,
      bound_store_id: null,
      bound_store_name: null,
      bound_market_name: null,
    }])

    clearClientApiCache()
    const mainFresh = require('../index').main

    const result = await mainFresh({
      action: 'order.create',
      payload: { storeId: 's1', items: [{ skuId: 'sku1' }], paymentMethod: 'wechat' },
    }, {})

    expect(result.code).toBe(-403)
    expect(result.errorType).toBe('PHONE_REQUIRED')
  })

  test('PERMISSION_DENIED 错误映射为 code: -403', async () => {
    // auth middleware 已在 beforeEach 中设好 mock
    // cancelUnbindRequest 内部: 查 request → user_id 不匹配
    pg.query.mockResolvedValueOnce([{
      user_id: 'other-user',
      status: 'pending',
    }])

    const result = await main({
      action: 'store.cancelUnbindRequest',
      payload: { requestId: 'req-001' },
    }, {})

    expect(result.code).toBe(-403)
    expect(result.errorType).toBe('PERMISSION_DENIED')
  })
})
