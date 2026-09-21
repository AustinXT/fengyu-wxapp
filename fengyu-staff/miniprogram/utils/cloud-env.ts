// CloudBase 单环境 + 影子函数：envId 恒为 prod，靠【云函数名】区分 dev/prod 数据库。
// 设计同 fengyu-client/miniprogram/utils/cloud-env.ts。
//
//   - 开发者工具开发版（develop）→ staffApiDev → dev 库
//   - 体验版（trial）             → staffApiDev → dev 库
//   - 正式版（release）           → staffApi    → prod 库
//
// 兜底方向：取不到 envVersion 时走 Dev 函数，不碰生产数据。

const STAFF_ENV = 'fengyu-staff-prod-d4dtv6052992e9'

const API_FN = 'staffApi'
const API_FN_DEV = 'staffApiDev'

export function getCloudEnv(): string {
  return STAFF_ENV
}

/** 当前小程序版本（develop / trial / release）；取不到返回 undefined */
export function getEnvVersion(): string | undefined {
  try {
    const info = wx.getAccountInfoSync()
    return info?.miniProgram?.envVersion
  } catch {
    return undefined
  }
}

/** 要调用的云函数名——只有正式版走连生产库的那一套 */
export function getApiFnName(): string {
  return getEnvVersion() === 'release' ? API_FN : API_FN_DEV
}

// CloudBase COS 下载域名（员工头像 cloud:// fileID 兜底渲染）。
// 单环境下只剩 prod 桶；桶前缀建桶时分配，不能从 envId 推算，故写死实测值。
const COS_BASE = 'https://6665-fengyu-staff-prod-d4dtv6052992e9-1406760129.tcb.qcloud.la'

export function getCosBase(): string {
  return COS_BASE
}
