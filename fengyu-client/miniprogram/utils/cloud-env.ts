// CloudBase 单环境 + 影子函数：envId 恒为 prod，靠【云函数名】区分 dev/prod 数据库。
//
// 运行时映射：
//   - 开发者工具开发版（develop）→ clientApiDev → 101.34.242.103:5433（dev 库）
//   - 体验版（trial）             → clientApiDev → dev 库（运营自测不落生产数据）
//   - 正式版（release）           → clientApi    → 118.178.196.26:5433（prod 库）
//
// 为什么不再按 envId 分流：dev 侧的 CloudBase 环境已不可用——staff 的 dev env 不在任何
// 密钥账号下，client 的 dev env 2026-10-03 到期——实际只剩 prod 一个环境。
// 于是改为在同一个 env 内并存两套函数，各自的 PG_CONNECTION_STRING 指向不同的库。
//
// 兜底方向：取不到 envVersion 时走 Dev 函数。宁可开发环境调不通，也不能让一个
// 版本判断不出来的客户端去写生产库。

const CLIENT_ENV = 'fengyu-client-prod-d1cga6909c0ba'

const API_FN = 'clientApi'
const API_FN_DEV = 'clientApiDev'

export function getCloudEnv(): string {
  return CLIENT_ENV
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

// CloudBase COS 下载域名（静态资源：banner / 凤御馆长图等）。
// 单环境下只剩 prod 桶；桶前缀建桶时分配，不能从 envId 推算，故写死实测值。
const COS_BASE = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

export function getCosBase(): string {
  return COS_BASE
}
