// utils/cloud.ts — staffApi 调用封装（含 Mock 拦截）
import { mockCallApi } from './mock-api'

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

export async function callStaffApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  // Mock 拦截（MOCK_ENABLED = false 时零开销）
  const mockResult = await mockCallApi(action, payload)
  if (mockResult !== null) return mockResult as T

  const res = await wx.cloud.callFunction({
    name: 'staffApi',
    data: { action, payload }
  }) as any
  if (res.result?.code !== 0) {
    throw new Error(sanitizeErrorMessage(res.result?.message, '请求失败'))
  }
  return res.result.data as T
}
