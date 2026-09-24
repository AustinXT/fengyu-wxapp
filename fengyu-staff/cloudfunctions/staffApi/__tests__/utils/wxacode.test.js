/**
 * wxacode 版本判定 —— 防止影子函数覆写生产小程序码的承重逻辑
 *
 * staffApi 与 staffApiDev 同住一个 CloudBase env，也就是**同一个 COS 桶**。
 * release 码刻意不带路径后缀（保持生产既有路径），所以只要影子函数有任何一条路径
 * 能算出 'release'，它就会把 develop 码写进 `wxacode/order/<id>.png` —— 与生产同 key，
 * 直接覆盖，真实顾客扫码付不了款。
 *
 * 两条触发路径都真实存在：
 *   ① 调用方 _envVersion 缺失（正是 getAccountInfoSync 抛错兜底的必然产物）
 *   ② 任意已绑定员工伪造 _envVersion:'release'（qrcode 只过 requireStaffBound）
 *
 * 所以版本必须由「函数自己是谁」决定。本文件锁死这条不变量。
 */

const path = require('node:path')

const WXACODE_PATH = require.resolve('../../utils/wxacode')

/** 绕过 setup.js 注入的 mock，按指定部署身份加载真实模块 */
function loadWxacode(selfEnvVersion) {
  const prev = process.env.WXACODE_ENV_VERSION
  if (selfEnvVersion === undefined) delete process.env.WXACODE_ENV_VERSION
  else process.env.WXACODE_ENV_VERSION = selfEnvVersion
  delete require.cache[WXACODE_PATH]
  const mod = require(WXACODE_PATH)
  if (prev === undefined) delete process.env.WXACODE_ENV_VERSION
  else process.env.WXACODE_ENV_VERSION = prev
  return mod
}

describe('effectiveEnvVersion · 正式函数（self=release）', () => {
  test('按调用方自报区分 trial 与 release', () => {
    const { effectiveEnvVersion } = loadWxacode('release')
    expect(effectiveEnvVersion('trial')).toBe('trial')
    expect(effectiveEnvVersion('release')).toBe('release')
  })

  test('缺失或非法值回落到自身部署默认值', () => {
    const { effectiveEnvVersion } = loadWxacode('release')
    for (const bad of [undefined, null, '', 'Release', 'whatever', 42, {}, []]) {
      expect(effectiveEnvVersion(bad)).toBe('release')
    }
  })
})

describe('effectiveEnvVersion · 影子函数（self=develop）', () => {
  test('恒用自身版本，忽略调用方自报值', () => {
    const { effectiveEnvVersion } = loadWxacode('develop')
    expect(effectiveEnvVersion('develop')).toBe('develop')
    expect(effectiveEnvVersion(undefined)).toBe('develop')
    expect(effectiveEnvVersion('trial')).toBe('develop')
  })

  test('伪造 release 也不得生成 release 码 —— 否则会覆写生产 COS key', () => {
    const { effectiveEnvVersion } = loadWxacode('develop')
    expect(effectiveEnvVersion('release')).toBe('develop')
  })

  test('任意注入字符串都被吞掉，不会流入路径', () => {
    const { effectiveEnvVersion } = loadWxacode('develop')
    for (const evil of ['../../etc/passwd', 'a/b/c', 'x'.repeat(500), 'release ']) {
      expect(effectiveEnvVersion(evil)).toBe('develop')
    }
  })
})

describe('versionPathSuffix', () => {
  test('release 无后缀 —— 保持生产既有的 wxacode/order/<id>.png', () => {
    const { versionPathSuffix } = loadWxacode('release')
    expect(versionPathSuffix('release')).toBe('')
  })

  test('非 release 一律带后缀，与生产路径分开', () => {
    const { versionPathSuffix } = loadWxacode('release')
    expect(versionPathSuffix('develop')).toBe('-develop')
    expect(versionPathSuffix('trial')).toBe('-trial')
  })

  test('影子函数算出的路径恒与生产不同', () => {
    const { effectiveEnvVersion, versionPathSuffix } = loadWxacode('develop')
    // 穷举调用方可能传来的任何值，影子函数的后缀都不得为空
    for (const requested of [undefined, null, '', 'release', 'trial', 'develop', 'evil']) {
      expect(versionPathSuffix(effectiveEnvVersion(requested))).not.toBe('')
    }
  })
})

describe('getSelfEnvVersion', () => {
  test('反映本实例的部署身份', () => {
    expect(loadWxacode('develop').getSelfEnvVersion()).toBe('develop')
    expect(loadWxacode('release').getSelfEnvVersion()).toBe('release')
  })

  test('环境变量缺失时按正式函数处理', () => {
    expect(loadWxacode(undefined).getSelfEnvVersion()).toBe('release')
  })
})
