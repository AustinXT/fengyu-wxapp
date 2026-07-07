
import { mockCallApi } from './mock-api'
import { getCosBase } from './cloud-env'
import { APP_VERSION } from './version'


export function toHttpUrl(url: string): string {
  if (!url || !url.startsWith('cloud://')) return url
  const base = getCosBase()
  const withoutProtocol = url.slice('cloud://'.length)
  const slashIndex = withoutProtocol.indexOf('/')
  if (slashIndex === -1) return url
  const firstSegment = withoutProtocol.slice(0, slashIndex)
  if (firstSegment.includes('.')) {
    return `${base}/${withoutProtocol.slice(slashIndex + 1)}`
  }
  return `${base}/${withoutProtocol}`
}


export interface StaffApiError extends Error {
  code?: number
  errorType?: string
  data?: unknown
}


export function sanitizeErrorMessage(msg: string, fallback: string = '请求失败'): string {
  if (!msg) return fallback
  
  const techPatterns = /\b(violates|constraint|relation|column|duplicate key|syntax error|ECONNREFUSED|ETIMEDOUT|TypeError|ReferenceError|Cannot read|undefined is not|null is not)\b/i
  if (techPatterns.test(msg)) return fallback
  
  if (msg.length > 60) return fallback
  return msg
}


function withAuthContext(payload: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...payload }
  
  if (next._appVersion === undefined) {
    next._appVersion = APP_VERSION
  }
  try {
    const g = getApp<IAppOption>()?.globalData
    if (g?.loginLevel && next._loginLevel === undefined) {
      next._loginLevel = g.loginLevel
    }
    if (g?.currentStoreId && next._currentStoreId === undefined) {
      next._currentStoreId = g.currentStoreId
    }
    if (next._testOpenid === undefined) {
      const devOpenid = wx.getStorageSync('__devTestOpenid')
      if (devOpenid) next._testOpenid = devOpenid
    }
    return next
  } catch {
    return next
  }
}

export async function callStaffApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  const enriched = withAuthContext(payload)
  
  const mockResult = await mockCallApi(action, enriched)
  if (mockResult !== null) return mockResult as T

  const res = await wx.cloud.callFunction({
    name: 'staffApi',
    data: { action, payload: enriched }
  }) as any
  if (res.result?.code !== 0) {
    
    
    const errorType = res.result?.errorType
    
    
    const message = errorType
      ? (res.result?.message || '请求失败')
      : sanitizeErrorMessage(res.result?.message, '请求失败')
    const err: StaffApiError = new Error(message)
    err.code = res.result?.code
    err.errorType = errorType
    err.data = res.result?.data
    throw err
  }
  return res.result.data as T
}
