// CloudBase 单环境 + 影子函数：envId 恒为 prod，靠【云函数名】区分 dev/prod 数据库。
// 设计同 fengyu-client/miniprogram/utils/cloud-env.ts。
//
//   - 开发者工具开发版（develop）→ staffApiDev → dev 库
//   - 体验版（trial）             → staffApi    → prod 库
//   - 正式版（release）           → staffApi    → prod 库
//
// 体验版走 prod：dev 与 prod 共用同一套拉卡拉生产商户凭据，体验版下单扣的是真钱，
// 账记进 dev 库会产生对账差异。
//
// 兜底方向：取不到 envVersion 时走 Dev 函数，不碰生产数据。

const STAFF_ENV = 'fengyu-staff-prod-d4dtv6052992e9'

const API_FN = 'staffApi'
const API_FN_DEV = 'staffApiDev'

/** 走生产库的小程序版本白名单——只有这两个放行，其余（含判断不出来）一律落 Dev */
const PROD_ENV_VERSIONS = ['release', 'trial']

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

// CloudBase COS 下载域名（员工头像 cloud:// fileID 兜底渲染）。
// 单环境下只剩 prod 桶；桶前缀建桶时分配，不能从 envId 推算，故写死实测值。
const COS_BASE = 'https://6665-fengyu-staff-prod-d4dtv6052992e9-1406760129.tcb.qcloud.la'

export function getCosBase(): string {
  return COS_BASE
}
