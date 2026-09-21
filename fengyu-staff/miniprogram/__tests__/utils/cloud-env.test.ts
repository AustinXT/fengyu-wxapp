/**
 * cloud-env.ts —— 单 CloudBase 环境下的 dev/prod 分流守卫
 *
 * CloudBase 只剩一个 prod 环境后，数据库隔离改由【云函数名】承担：
 * staffApi 连生产库、staffApiDev 连 dev 库，同住一个 env。
 * 选错函数名 = 开发版/体验版直接读写生产数据，且没有任何报错提示。
 * 这里是这条判断在前端的唯一落点。
 */

import { getApiFnName, getCloudEnv, getEnvVersion } from '../../utils/cloud-env'

function setEnvVersion(version: string | undefined): void {
  const wx = (globalThis as any).wx
  if (version === undefined) {
    delete wx.getAccountInfoSync
    return
  }
  wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: version } })
}

afterEach(() => {
  delete (globalThis as any).wx.getAccountInfoSync
})

describe('getApiFnName', () => {
  test('正式版走连生产库的 staffApi', () => {
    setEnvVersion('release')
    expect(getApiFnName()).toBe('staffApi')
  })

  test('体验版走 staffApiDev —— 运营自测不落生产数据', () => {
    setEnvVersion('trial')
    expect(getApiFnName()).toBe('staffApiDev')
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
    expect(getApiFnName()).toBe('staffApiDev')
  })

  test('未知版本字符串不得落到生产函数', () => {
    // 只有精确等于 'release' 才放行——白名单而非黑名单，新增版本态默认走 Dev
    setEnvVersion('some-future-version')
    expect(getApiFnName()).toBe('staffApiDev')
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
