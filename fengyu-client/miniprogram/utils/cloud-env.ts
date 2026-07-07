












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



const COS_BASE_DEV = 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la'
const COS_BASE_PROD = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

export function getCosBase(): string {
  return getCloudEnv() === CLIENT_PROD ? COS_BASE_PROD : COS_BASE_DEV
}
