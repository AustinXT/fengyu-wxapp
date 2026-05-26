/**
 * Admin 端错误码/错误前缀白名单 + ApiError class + withApiResponse HOF
 *
 * 9 项官方白名单与三端云函数 error-codes.js（staffApi/clientApi/payNotify）字节同义。
 * 跨端一致性由以下 snapshot 测试守护，任一端漂移立即报错：
 *   - fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js
 *   - fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts
 *
 * code 映射注意：
 *   - PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403 → 前端按 errorType 区分
 *   - INVALID_PARAMS / INSUFFICIENT_BALANCE / INVALID_STATE / CLIENT_NOT_REGISTERED
 *     共用 -400 → 同理按 errorType 区分
 *
 * 二级前缀语法（CAS-guard / payNotify feature flag 等场景）：
 *   throw new ApiError('INVALID_STATE', 'STATE_TRANSITION_BLOCKED: 订单状态已被其他操作变更')
 *   parseErrorPrefix 仅解析一级前缀，子标签随 displayMessage 透出。
 *
 * Server Action 用法（推荐）：
 *   export async function fooAction(...): Promise<ApiResponse<...>> {
 *     return runWithApiResponse('fooAction', async () => {
 *       if (!input.id) throw new ApiError('INVALID_PARAMS', 'id 必填')
 *       ...
 *     })
 *   }
 *
 * 注：Next.js 15 Server Action 要求顶层 `export async function` 声明；
 * 因此提供 runWithApiResponse 直接调用形式而非 wrapper 形式，避免
 * "server action must be async function declaration" 编译错误。
 */

export const ERROR_PREFIXES = Object.freeze([
  'UNAUTHORIZED',
  'PHONE_REQUIRED',
  'INVALID_PARAMS',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'CONFLICT',
  'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
] as const)

export type ErrorPrefix = (typeof ERROR_PREFIXES)[number]

export const CODE_MAP: Readonly<Record<ErrorPrefix, number>> = Object.freeze({
  UNAUTHORIZED: -401,
  PHONE_REQUIRED: -403,
  PERMISSION_DENIED: -403,
  INVALID_PARAMS: -400,
  INSUFFICIENT_BALANCE: -400,
  INVALID_STATE: -400,
  CLIENT_NOT_REGISTERED: -400,
  NOT_FOUND: -404,
  CONFLICT: -409,
})

export class ApiError extends Error {
  readonly prefix: ErrorPrefix
  readonly data?: unknown
  constructor(prefix: ErrorPrefix, message: string, data?: unknown) {
    super(`${prefix}: ${message}`)
    this.name = 'ApiError'
    this.prefix = prefix
    this.data = data
  }
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | {
      success: false
      code: number
      errorType: ErrorPrefix | null
      message: string
      data?: unknown
    }

/**
 * 解析 message 中的一级错误前缀（与云函数三端 parseErrorPrefix 同义）。
 */
export function parseErrorPrefix(
  message: string,
): { prefix: ErrorPrefix; displayMessage: string } | null {
  if (!message || typeof message !== 'string') return null
  const m = message.match(/^([A-Z_]+):\s*/)
  if (!m) return null
  if (!(ERROR_PREFIXES as readonly string[]).includes(m[1])) return null
  return { prefix: m[1] as ErrorPrefix, displayMessage: message.slice(m[0].length) }
}

/**
 * 把任意 throw（ApiError / 含前缀的 Error / 中文裸抛 / DB 错误）
 * 收敛为 ApiResponse<T>。
 *
 * 非白名单前缀的 message 会被降级为 {code:-1, message:'服务器内部错误', errorType:null}，
 * 原始 message 走 console.error 打印（便于线上排查，不暴露给前端）。
 *
 * 用法示例：
 *   export async function createOrder(input): Promise<ApiResponse<Order>> {
 *     return runWithApiResponse('createOrder', async () => {
 *       if (!input.skuId) throw new ApiError('INVALID_PARAMS', 'skuId 必填')
 *       ...
 *       return order
 *     })
 *   }
 */
export async function runWithApiResponse<T>(
  name: string,
  action: () => Promise<T>,
): Promise<ApiResponse<T>> {
  try {
    const data = await action()
    return { success: true, data }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    const message = error.message || '服务器内部错误'
    const parsed = parseErrorPrefix(message)
    const dataAttached =
      err instanceof ApiError
        ? err.data
        : (err as { data?: unknown } | null)?.data
    if (parsed) {
      return {
        success: false,
        code: CODE_MAP[parsed.prefix] ?? -1,
        errorType: parsed.prefix,
        message: parsed.displayMessage,
        data: dataAttached,
      }
    }
    console.error(`[withApiResponse:${name}] non-whitelisted error:`, message)
    return {
      success: false,
      code: -1,
      errorType: null,
      message: '服务器内部错误',
    }
  }
}

/**
 * 高阶函数形式（不能直接装饰 Server Action，仅用于非 'use server' 模块如 lib/* 内部 helper）。
 *
 * 注意：Next.js 15 SWC 会拒绝以下用法（被识别为"非 async function declaration"）：
 *   export const fooAction = withApiResponse(async (...) => {...}, { name: 'fooAction' })
 *
 * Server Action 文件请使用 runWithApiResponse 直接调用形式（见上）。
 */
export function withApiResponse<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: { name: string },
): (...args: TArgs) => Promise<ApiResponse<TResult>> {
  return (...args: TArgs) => runWithApiResponse(options.name, () => action(...args))
}
