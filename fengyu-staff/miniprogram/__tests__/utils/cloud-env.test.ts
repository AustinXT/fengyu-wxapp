/**
 * cloud-env.ts —— 单 CloudBase 环境下的 dev/prod 分流守卫
 *
 * CloudBase 只剩一个 prod 环境后，数据库隔离改由【云函数名】承担：
 * staffApi 连生产库、staffApiDev 连 dev 库，同住一个 env。
 * 选错函数名 = 读写了另一个库，且没有任何报错提示。
 *
 * 体验版（trial）走生产库是刻意的：dev 与 prod 共用同一套拉卡拉生产商户凭据，
 * 体验版下单扣的是真钱，账必须记在 prod 库才对得上。
 */

import { getApiFnName, getCloudEnv, getEnvVersion, __resetApiFnNameCache } from '../../utils/cloud-env'

function setEnvVersion(version: string | undefined): void {
  const wx = (globalThis as any).wx
  if (version === undefined) {
    delete wx.getAccountInfoSync
  } else {
    wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: version } })
  }
  // 函数名是 memoize 的（见实现注释：避免热路径抖动导致单次跨库），测试间必须重置
  __resetApiFnNameCache()
}

afterEach(() => {
  delete (globalThis as any).wx.getAccountInfoSync
  __resetApiFnNameCache()
})

describe('getApiFnName', () => {
  test('正式版走连生产库的 staffApi', () => {
    setEnvVersion('release')
    expect(getApiFnName()).toBe('staffApi')
  })

  test('体验版同样走 staffApi —— 扣真钱就得记真账', () => {
    setEnvVersion('trial')
    expect(getApiFnName()).toBe('staffApi')
  })

  test('开发者工具开发版走 staffApiDev', () => {
    setEnvVersion('develop')
    expect(getApiFnName()).toBe('staffApiDev')
  })

  test('取不到版本时兜底到 Dev，不碰生产库', () => {
    setEnvVersion(undefined)
    expect(getApiFnName()).toBe('staffApiDev')
  })

  test('getAccountInfoSync 抛错时同样兜底到 Dev', () => {
    ;(globalThis as any).wx.getAccountInfoSync = () => {
      throw new Error('getAccountInfoSync unavailable')
    }
    __resetApiFnNameCache()
    expect(getApiFnName()).toBe('staffApiDev')
  })

  test('未知版本字符串不得落到生产函数', () => {
    // 白名单而非黑名单：新增版本态默认走 Dev
    setEnvVersion('some-future-version')
    expect(getApiFnName()).toBe('staffApiDev')
  })

  test('结果在会话内钉住，不随后续调用重算', () => {
    // 每个请求都重算的话，一次 getAccountInfoSync 抖动就等于这一个请求跨库——
    // 正式版用户的订单会静默落进 dev 库，前端还显示成功。
    setEnvVersion('release')
    expect(getApiFnName()).toBe('staffApi')
    // 模拟运行中 API 抖动
    ;(globalThis as any).wx.getAccountInfoSync = () => {
      throw new Error('transient failure')
    }
    expect(getApiFnName()).toBe('staffApi')
  })
})

describe('getEnvVersion', () => {
  test('返回当前小程序版本', () => {
    setEnvVersion('trial')
    expect(getEnvVersion()).toBe('trial')
  })

  test('取不到时返回 undefined 而非抛错', () => {
    setEnvVersion(undefined)
    expect(getEnvVersion()).toBeUndefined()
  })
})

describe('getCloudEnv', () => {
  test('envId 恒为 prod，不再随版本切换', () => {
    setEnvVersion('develop')
    const onDevelop = getCloudEnv()
    setEnvVersion('release')
    expect(getCloudEnv()).toBe(onDevelop)
    expect(onDevelop).toBe('fengyu-staff-prod-d4dtv6052992e9')
  })
})
