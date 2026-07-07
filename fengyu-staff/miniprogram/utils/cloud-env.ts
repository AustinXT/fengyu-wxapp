


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




const COS_BASE_DEV = 'https://636c-cloud1-9g3ydpg512eecc99-1406760129.tcb.qcloud.la'
const COS_BASE_PROD = 'https://6665-fengyu-staff-prod-d4dtv6052992e9-1406760129.tcb.qcloud.la'

export function getCosBase(): string {
  return getCloudEnv() === STAFF_PROD ? COS_BASE_PROD : COS_BASE_DEV
}
