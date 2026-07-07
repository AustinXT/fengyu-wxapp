
import { APP_VERSION } from './version'


function withClientContext(payload: Record<string, any>): Record<string, any> {
  if (payload && payload._appVersion !== undefined) return payload
  return { ...payload, _appVersion: APP_VERSION }
}


export function sanitizeErrorMessage(msg: string, fallback: string = '请求失败'): string {
  if (!msg) return fallback
  const techPatterns = /\b(violates|constraint|relation|column|duplicate key|syntax error|ECONNREFUSED|ETIMEDOUT|TypeError|ReferenceError|Cannot read|undefined is not|null is not)\b|cloud\.\w+:fail/i
  if (techPatterns.test(msg)) return fallback
  if (msg.length > 60) return fallback
  return msg
}

interface ClientApiError extends Error {
  code?: number
  errorType?: string
  data?: any
}

export async function callClientApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  let res: any
  try {
    res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: { action, payload: withClientContext(payload) }
    })
  } catch (sdkErr: any) {
    
    const err: ClientApiError = new Error(
      sanitizeErrorMessage(sdkErr?.message || sdkErr?.errMsg, '网络异常，请稍后重试')
    )
    err.code = -1
    throw err
  }
  if (res.result?.code !== 0) {
    const errorType = res.result?.errorType
    
    
    const message = errorType
      ? (res.result?.message || '请求失败')
      : sanitizeErrorMessage(res.result?.message, '请求失败')
    const err: ClientApiError = new Error(message)
    err.code = res.result?.code
    err.errorType = errorType
    err.data = res.result?.data
    throw err
  }
  return res.result.data as T
}

interface BindPhoneResult {
  phone: string
  updatedOrdersCount: number
}


export async function bindPhoneWithCloudID(cloudID: string): Promise<BindPhoneResult> {
  wx.showLoading({ title: '绑定中...', mask: true })
  try {
    const res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: {
        action: 'auth.bindPhone',
        payload: withClientContext({}),
        phoneData: wx.cloud.CloudID(cloudID)
      }
    }) as any

    if (res.result?.code !== 0) {
      const errorType = res.result?.errorType
      
      const message = errorType
        ? (res.result?.message || '绑定失败')
        : sanitizeErrorMessage(res.result?.message, '绑定失败')
      const err: ClientApiError = new Error(message)
      err.code = res.result?.code
      err.errorType = errorType
      throw err
    }

    const { phone, updatedOrdersCount = 0 } = res.result.data
    wx.setStorageSync('phone', phone)

    return { phone, updatedOrdersCount }
  } finally {
    wx.hideLoading()
  }
}
