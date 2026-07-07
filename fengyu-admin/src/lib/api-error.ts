

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


export function parseErrorPrefix(
  message: string,
): { prefix: ErrorPrefix; displayMessage: string } | null {
  if (!message || typeof message !== 'string') return null
  const m = message.match(/^([A-Z_]+):\s*/)
  if (!m) return null
  if (!(ERROR_PREFIXES as readonly string[]).includes(m[1])) return null
  return { prefix: m[1] as ErrorPrefix, displayMessage: message.slice(m[0].length) }
}


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


export function withApiResponse<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: { name: string },
): (...args: TArgs) => Promise<ApiResponse<TResult>> {
  return (...args: TArgs) => runWithApiResponse(options.name, () => action(...args))
}
