/**
 * runtime-guard 单测（员工端 prod envId 硬闸）
 *
 * 核心安全断言：测试旁路（_testOpenid / phoneNumber 直传）只在「env 开启 且 非生产运行时」
 * 允许；生产运行时（cloud.getWXContext().ENV 命中 prod 白名单）强制禁用，无视 env 开关。
 * 即使 prod 函数 env 滞留 ALLOW_TEST_OPENID=true（本仓库 2026-05 曾发生）也不放行。
 */

const cloud = globalThis.__mocks__.cloud

function loadGuard() {
  delete require.cache[require.resolve('../../utils/runtime-guard')]
  return require('../../utils/runtime-guard')
}

describe('runtime-guard（员工端 prod envId 硬闸）', () => {
  const PROD_ENV = 'fengyu-staff-prod-d4dtv6052992e9'
  let guard
  const orig = {}

  beforeEach(() => {
    vi.clearAllMocks()
    guard = loadGuard()
    orig.testOpenid = process.env.ALLOW_TEST_OPENID
    orig.directPhone = process.env.ALLOW_DIRECT_PHONE
    delete process.env.ALLOW_TEST_OPENID
    delete process.env.ALLOW_DIRECT_PHONE
  })

  afterEach(() => {
    if (orig.testOpenid === undefined) delete process.env.ALLOW_TEST_OPENID
    else process.env.ALLOW_TEST_OPENID = orig.testOpenid
    if (orig.directPhone === undefined) delete process.env.ALLOW_DIRECT_PHONE
    else process.env.ALLOW_DIRECT_PHONE = orig.directPhone
  })

  test('非生产运行时 + env=true → 旁路允许', () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'x', ENV: 'test-env' })
    process.env.ALLOW_TEST_OPENID = 'true'
    process.env.ALLOW_DIRECT_PHONE = 'true'
    expect(guard.isProdRuntime()).toBe(false)
    expect(guard.testBypassAllowed('ALLOW_TEST_OPENID')).toBe(true)
    expect(guard.testBypassAllowed('ALLOW_DIRECT_PHONE')).toBe(true)
  })

  test('生产运行时 + env=true → 硬闸强制禁用（核心安全断言，防 staffApi 提权）', () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'x', ENV: PROD_ENV })
    process.env.ALLOW_TEST_OPENID = 'true'
    process.env.ALLOW_DIRECT_PHONE = 'true'
    expect(guard.isProdRuntime()).toBe(true)
    expect(guard.testBypassAllowed('ALLOW_TEST_OPENID')).toBe(false)
    expect(guard.testBypassAllowed('ALLOW_DIRECT_PHONE')).toBe(false)
  })

  test('非生产 + env 未设 → 旁路关闭（directPhone 默认全关）', () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'x', ENV: 'test-env' })
    expect(guard.testBypassAllowed('ALLOW_TEST_OPENID')).toBe(false)
    expect(guard.testBypassAllowed('ALLOW_DIRECT_PHONE')).toBe(false)
  })

  test('getWXContext 抛错 → isProdRuntime 安全降级为 false', () => {
    cloud.getWXContext.mockImplementation(() => { throw new Error('no ctx') })
    process.env.ALLOW_TEST_OPENID = 'true'
    expect(guard.isProdRuntime()).toBe(false)
    expect(guard.testBypassAllowed('ALLOW_TEST_OPENID')).toBe(true)
  })
})
