// CloudBase env 自适应：运行时根据小程序版本（release/trial/develop）选 envId。
// 设计同 fengyu-client/miniprogram/utils/cloud-env.ts。

const STAFF_PROD = 'fengyu-staff-prod-d4dtv6052992e9'
const STAFF_DEV = 'cloud1-9g3ydpg512eecc99'

export function getCloudEnv(): string {
  try {
    const info = wx.getAccountInfoSync()
    const envVersion = info?.miniProgram?.envVersion
    return envVersion === 'release' || envVersion === 'trial' ? STAFF_PROD : STAFF_DEV
  } catch {
    return STAFF_DEV
  }
}

// CloudBase COS 下载域名（员工头像 cloud:// fileID 兜底渲染），随 env 切换。
// 指向 staff 自己的 env 桶（旧代码误指 client dev 桶 → 跨端 + dev 锁死）。
// 各 env 桶前缀不同（建桶时分配，不能从 envId 推算），故写死实测值。
const COS_BASE_DEV = 'https://636c-cloud1-9g3ydpg512eecc99-1406760129.tcb.qcloud.la'
const COS_BASE_PROD = 'https://6665-fengyu-staff-prod-d4dtv6052992e9-1406760129.tcb.qcloud.la'

export function getCosBase(): string {
  return getCloudEnv() === STAFF_PROD ? COS_BASE_PROD : COS_BASE_DEV
}
