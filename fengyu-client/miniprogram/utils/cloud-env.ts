// CloudBase env 自适应：运行时根据小程序版本（release/trial/develop）选 envId。
//
// 设计目的：
//   - 开发者工具开发版（develop）→ dev envId → 47.113.202.7:5433/fengyu_wxapp（开发/测试库）
//   - 体验版（trial）→ prod envId → 118.178.196.26:5433/fengyu_wxapp（运营自测改在 prod 数据）
//   - 正式版（release，已发布）→ prod envId → 118.178.196.26:5433/fengyu_wxapp
//
// 这样：
//   1. 一次代码改动 + 一次发版即可双环境分离
//   2. 切换 envs/.active 不会影响小程序代码
//   3. 取不到 envVersion（异常兜底）走 dev，避免误判进 prod 5433
//   4. trial/release 包均切到 prod，仅 DevTools 开发版留在 dev

const CLIENT_PROD = 'fengyu-client-prod-d1cga6909c0ba'
const CLIENT_DEV = 'cloud1-3gpht4b01ff88838'

export function getCloudEnv(): string {
  try {
    const info = wx.getAccountInfoSync()
    const envVersion = info?.miniProgram?.envVersion
    return envVersion === 'release' || envVersion === 'trial' ? CLIENT_PROD : CLIENT_DEV
  } catch {
    return CLIENT_DEV
  }
}

// CloudBase COS 下载域名（静态资源：banner / 凤御馆长图等），随 env 切换。
// 各 env 桶前缀不同（建桶时分配，不能从 envId 推算），故写死实测值。
const COS_BASE_DEV = 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la'
const COS_BASE_PROD = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

export function getCosBase(): string {
  return getCloudEnv() === CLIENT_PROD ? COS_BASE_PROD : COS_BASE_DEV
}
