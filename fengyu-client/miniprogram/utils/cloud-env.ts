// CloudBase env 自适应：运行时根据小程序版本（release/trial/develop）选 envId。
//
// 设计目的：
//   - 开发者工具开发版 → dev envId → 47.113.202.7:5434/fengyu
//   - 体验版（trial）→ dev envId（运营自测仍在 dev 数据）
//   - 正式版（release，已发布）→ prod envId → 5433/fengyu_wxapp
//
// 这样：
//   1. 一次代码改动 + 一次发版即可双环境分离
//   2. 切换 envs/.active 不会影响小程序代码
//   3. 审核期老正式版无 env 参数走账号默认（dev），不会误写入 prod 5433
//   4. release 包通过审核 + 发布后才完整切到 prod

const CLIENT_PROD = 'fengyu-client-prod-d1cga6909c0ba'
const CLIENT_DEV = 'cloud1-3gpht4b01ff88838'

export function getCloudEnv(): string {
  try {
    const info = wx.getAccountInfoSync()
    const envVersion = info?.miniProgram?.envVersion
    return envVersion === 'release' ? CLIENT_PROD : CLIENT_DEV
  } catch {
    return CLIENT_DEV
  }
}
