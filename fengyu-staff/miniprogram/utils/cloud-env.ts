// CloudBase env 自适应：运行时根据小程序版本（release/trial/develop）选 envId。
// 设计同 fengyu-client/miniprogram/utils/cloud-env.ts。

const STAFF_PROD = 'fengyu-staff-prod-d4dtv6052992e9'
const STAFF_DEV = 'cloud1-9g3ydpg512eecc99'

export function getCloudEnv(): string {
  try {
    const info = wx.getAccountInfoSync()
    const envVersion = info?.miniProgram?.envVersion
    return envVersion === 'release' ? STAFF_PROD : STAFF_DEV
  } catch {
    return STAFF_DEV
  }
}
