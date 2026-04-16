// utils/cloud.ts — clientApi 调用封装

/**
 * 过滤技术性错误信息，确保用户看到的是友好提示
 * 后端已做兜底（非业务错误返回"服务器内部错误"），此处为前端防御层
 */
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
      data: { action, payload }
    })
  } catch (sdkErr: any) {
    // 网络/SDK 层错误（超时、断网、函数不存在等）→ 友好提示
    const err: ClientApiError = new Error(
      sanitizeErrorMessage(sdkErr?.message || sdkErr?.errMsg, '网络异常，请稍后重试')
    )
    err.code = -1
    throw err
  }
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

interface RebindPhoneResult {
  phone: string
  oldPhone: string
  mergedAnonymousOrders: number
}

/**
 * CloudID 方式绑定手机号（首次绑定）
 * 封装 loading → API 调用 → 错误处理 → localStorage 持久化 → hideLoading
 * 已绑定手机号的用户应使用 rebindPhoneWithCloudID
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
      const err: ClientApiError = new Error(sanitizeErrorMessage(res.result?.message, '绑定失败'))
      err.code = res.result?.code
      err.errorType = res.result?.errorType
      throw err
    }

    const { phone, updatedOrdersCount = 0 } = res.result.data
    wx.setStorageSync('phone', phone)

    return { phone, updatedOrdersCount }
  } finally {
    wx.hideLoading()
  }
}

/**
 * CloudID 方式换绑手机号
 * 已绑定用户调用，仅 UPDATE client_wechat_users.phone 一列，积分/会员/历史订单全部保留
 * 业务错误 errorType：PHONE_BOUND_BY_OTHER_USER / PHONE_HAS_EXISTING_PROFILE / PHONE_REQUIRED
 */
export async function rebindPhoneWithCloudID(cloudID: string): Promise<RebindPhoneResult> {
  wx.showLoading({ title: '换绑中...', mask: true })
  try {
    const res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: {
        action: 'auth.rebindPhone',
        payload: {},
        phoneData: wx.cloud.CloudID(cloudID)
      }
    }) as any

    if (res.result?.code !== 0) {
      const err: ClientApiError = new Error(sanitizeErrorMessage(res.result?.message, '换绑失败'))
      err.code = res.result?.code
      err.errorType = res.result?.errorType
      throw err
    }

    const { phone, oldPhone, mergedAnonymousOrders = 0 } = res.result.data
    wx.setStorageSync('phone', phone)

    return { phone, oldPhone, mergedAnonymousOrders }
  } finally {
    wx.hideLoading()
  }
}
