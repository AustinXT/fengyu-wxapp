// CloudBase 单环境 + 影子函数：envId 恒为 prod，靠【云函数名】区分 dev/prod 数据库。
//
// 运行时映射：
//   - 开发者工具开发版（develop）→ clientApiDev → 101.34.242.103:5433（dev 库）
//   - 体验版（trial）             → clientApi    → 118.178.196.26:5433（prod 库）
//   - 正式版（release）           → clientApi    → prod 库
//
// 体验版为什么走 prod：dev 与 prod **共用同一套拉卡拉生产商户凭据**（两边 envs 里
// LAKALA_* 与 CLIENT_APPSECRET 逐字节相同）。体验版下单扣的是真钱，账若记进 dev 库
// 就会产生对账差异。让它留在 prod 库，扣真钱记真账才是一致的。
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

/** 走生产库的小程序版本白名单——只有这两个放行，其余（含判断不出来）一律落 Dev */
const PROD_ENV_VERSIONS = ['release', 'trial']

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

// 版本在一次小程序运行期内不会变，但 getAccountInfoSync 是同步 JSBridge 调用、
// 且偶发会抛。若每个请求都重算，一次抖动就等于**这一个请求**被路由到另一个库——
// 正式版用户的一笔订单会静默落进 dev 库，前端还显示成功。
// 因此解析一次后钉住，让路由在整个会话内恒定。
let cachedFnName: string | null = null

/** 要调用的云函数名——只有正式版/体验版走连生产库的那一套 */
export function getApiFnName(): string {
  if (cachedFnName === null) {
    const version = getEnvVersion()
    cachedFnName = version && PROD_ENV_VERSIONS.includes(version) ? API_FN : API_FN_DEV
  }
  return cachedFnName
}

/** 仅供测试重置 memoize 状态 */
export function __resetApiFnNameCache(): void {
  cachedFnName = null
}

// CloudBase COS 下载域名（静态资源：banner / 凤御馆长图等）。
// 单环境下只剩 prod 桶；桶前缀建桶时分配，不能从 envId 推算，故写死实测值。
const COS_BASE = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

export function getCosBase(): string {
  return COS_BASE
}
