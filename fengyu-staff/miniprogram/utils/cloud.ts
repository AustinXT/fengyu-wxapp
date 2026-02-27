// utils/cloud.ts — staffApi 调用封装（含 Mock 拦截）
import { mockCallApi } from './mock-api'

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
    throw new Error(res.result?.message || '请求失败')
  }
  return res.result.data as T
}
