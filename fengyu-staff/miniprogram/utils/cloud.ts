// utils/cloud.ts — staffApi 调用封装（含 Mock 拦截 + 自动附加登录层级参数）
import { mockCallApi } from './mock-api'

/**
 * 业务 API 错误对象 —— 与 client 端 callClientApi 对称。
 * 调用方按 `err.errorType` 路由不同 UI 分支（推荐），
 * 而不是按 `err.message` 字符串 indexOf 匹配（旧写法，errorType 改名时易脆）。
 *
 * 9 项官方 errorType 见 staffApi/utils/error-codes.js 的 ERROR_PREFIXES。
 */
export interface StaffApiError extends Error {
  code?: number
  errorType?: string
  data?: unknown
}

/**
 * 过滤技术性错误信息，确保用户看到的是友好提示
 * 后端已做兜底（非业务错误返回"服务器内部错误"），此处为前端防御层
 */
export function sanitizeErrorMessage(msg: string, fallback: string = '请求失败'): string {
  if (!msg) return fallback
  // 检测技术性错误特征（SQL、数据库、堆栈等）
  const techPatterns = /\b(violates|constraint|relation|column|duplicate key|syntax error|ECONNREFUSED|ETIMEDOUT|TypeError|ReferenceError|Cannot read|undefined is not|null is not)\b/i
  if (techPatterns.test(msg)) return fallback
  // 消息过长（>60字符）通常是技术性内容
  if (msg.length > 60) return fallback
  return msg
}

/**
 * 自动附加当前登录层级 / 当前门店到 payload，供云函数中间件校验 + 过滤
 */
function withAuthContext(payload: Record<string, any>): Record<string, any> {
  try {
    const g = getApp<IAppOption>()?.globalData
    if (!g) return payload
    const next: Record<string, any> = { ...payload }
    if (g.loginLevel && next._loginLevel === undefined) {
      next._loginLevel = g.loginLevel
    }
    if (g.currentStoreId && next._currentStoreId === undefined) {
      next._currentStoreId = g.currentStoreId
    }
    return next
  } catch {
    return payload
  }
}

export async function callStaffApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  const enriched = withAuthContext(payload)
  // Mock 拦截（MOCK_ENABLED = false 时零开销）
  const mockResult = await mockCallApi(action, enriched)
  if (mockResult !== null) return mockResult as T

  const res = await wx.cloud.callFunction({
    name: 'staffApi',
    data: { action, payload: enriched }
  }) as any
  if (res.result?.code !== 0) {
    // 与 callClientApi 对称：把 code/errorType/data 挂到 Error 实例，
    // 调用方按 err.errorType 路由不同 UI 分支（如 PERMISSION_DENIED 走"返回上一页"）
    const err: StaffApiError = new Error(sanitizeErrorMessage(res.result?.message, '请求失败'))
    err.code = res.result?.code
    err.errorType = res.result?.errorType
    err.data = res.result?.data
    throw err
  }
  return res.result.data as T
}
