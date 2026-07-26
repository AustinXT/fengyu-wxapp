// utils/cloud.ts — clientApi 调用封装
import { APP_VERSION } from './version'

/**
 * 自动附加小程序前端版本号 `_appVersion`，供云函数按前端版本做向后兼容分流
 * （上线版/测试版共用 CloudBase 环境，云函数部署即生效但前端上线有审批延迟，新旧版并存）。
 * 调用方已显式传入 `_appVersion` 时不覆盖。
 */
function withClientContext(payload: Record<string, any>): Record<string, any> {
  if (payload && payload._appVersion !== undefined) return payload
  return { ...payload, _appVersion: APP_VERSION }
}

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
      data: { action, payload: withClientContext(payload) }
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
    const errorType = res.result?.errorType
    // errorType 非空 = 命中 9 项白名单 = 后端已剥前缀的友好业务文案，原样透传；
    // errorType 为空 = 未知/系统错误，仍过 sanitize 兜底，避免泄露技术细节
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

/**
 * CloudID 方式绑定手机号（首次绑定）
 * 封装 loading → API 调用 → 错误处理 → localStorage 持久化 → hideLoading
 * 注：客户端不再提供自助换绑，已绑定用户如需修改手机号需联系门店由管理后台操作
 */
export async function bindPhoneWithCloudID(
  cloudID: string,
  payload: Record<string, any> = {}
): Promise<BindPhoneResult> {
  wx.showLoading({ title: '绑定中...', mask: true })
  try {
    const res = await wx.cloud.callFunction({
      name: 'clientApi',
      data: {
        action: 'auth.bindPhone',
        payload: withClientContext(payload),
        phoneData: wx.cloud.CloudID(cloudID)
      }
    }) as any

    if (res.result?.code !== 0) {
      const errorType = res.result?.errorType
      // 同 callClientApi：白名单业务错误原样透传，未知错误才 sanitize 兜底
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
