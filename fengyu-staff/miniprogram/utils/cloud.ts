// utils/cloud.ts — staffApi 调用封装（含 Mock 拦截 + 自动附加登录层级参数）
import { mockCallApi } from './mock-api'
import { getCosBase } from './cloud-env'
import { APP_VERSION } from './version'

/**
 * 将 cloud:// 协议的 fileID 转换为 HTTPS CDN URL（兼容历史 fileID 兜底；
 * 新链路头像已由云函数 getTempFileURL 入库为 HTTPS，对其原样返回，不依赖此转换）。
 * 桶 base 随 env 切换（staff dev/prod），由 getCosBase() 提供。
 *
 * 标准格式: cloud://envId.bucketSuffix/path → base/path（第一段含 . 则为 envId，跳过）
 * 简化格式: cloud://staff-avatars/xxx.jpg  → base/staff-avatars/xxx.jpg
 * HTTPS / 空：原样返回
 */
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
 * 自动附加请求上下文到 payload：
 *   - `_appVersion`：小程序前端版本号，供云函数按前端版本做向后兼容分流
 *     （上线版/测试版共用 CloudBase 环境，云函数部署即生效但前端上线有审批延迟，新旧版并存）
 *   - `_loginLevel` / `_currentStoreId`：登录层级 / 当前门店，供云函数中间件校验 + 过滤
 * 开发期：localStorage `__devTestOpenid` 存在则注入 `_testOpenid`，便于切换测试员工身份
 *        （远端云函数需 ALLOW_TEST_OPENID=true 才生效；生产关闭后自动失效）
 */
function withAuthContext(payload: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...payload }
  // 版本号注入不依赖 getApp，故置于 try 之外，确保 getApp 异常时仍带上 _appVersion
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
    const errorType = res.result?.errorType
    // errorType 非空 = 命中 9 项白名单 = 后端已剥前缀的友好业务文案，原样透传；
    // errorType 为空 = 未知/系统错误，仍过 sanitize 兜底，避免泄露技术细节
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
