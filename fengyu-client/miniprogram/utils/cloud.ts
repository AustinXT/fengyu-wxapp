// utils/cloud.ts — clientApi 调用封装

/**
 * 过滤技术性错误信息，确保用户看到的是友好提示
 * 后端已做兜底（非业务错误返回"服务器内部错误"），此处为前端防御层
 */
export function sanitizeErrorMessage(msg: string, fallback: string = '请求失败'): string {
  if (!msg) return fallback
  const techPatterns = /\b(violates|constraint|relation|column|duplicate key|syntax error|ECONNREFUSED|ETIMEDOUT|TypeError|ReferenceError|Cannot read|undefined is not|null is not)\b/i
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
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any
  if (res.result?.code !== 0) {
    const err: ClientApiError = new Error(sanitizeErrorMessage(res.result?.message, '请求失败'))
    err.code = res.result?.code
    err.errorType = res.result?.errorType
    err.data = res.result?.data
    throw err
  }
  return res.result.data as T
}

interface BindPhoneResult {
  phone: string
  updatedOrdersCount: number
}

/**
 * CloudID 方式绑定手机号
 * 封装 loading → API 调用 → 错误处理 → localStorage 持久化 → hideLoading
 * 各页面只需处理成功后的 UI 回调
 */
export async function bindPhoneWithCloudID(cloudID: string): Promise<BindPhoneResult> {
  wx.showLoading({ title: '绑定中...', mask: true })
  try {
    const res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: {
        action: 'auth.bindPhone',
        payload: {},
        phoneData: wx.cloud.CloudID(cloudID)
      }
    }) as any

    if (res.result?.code !== 0) {
      throw new Error(sanitizeErrorMessage(res.result?.message, '绑定失败'))
    }

    const { phone, updatedOrdersCount = 0 } = res.result.data
    wx.setStorageSync('phone', phone)

    return { phone, updatedOrdersCount }
  } finally {
    wx.hideLoading()
  }
}
