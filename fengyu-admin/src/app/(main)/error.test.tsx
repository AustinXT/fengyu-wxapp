import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorPage from './error'

/**
 * 页面级 error boundary 的 401/403/500 判定守护。
 *
 * 此前这里靠 `error.digest === "PERMISSION_DENIED"` 字面量，是同一套约定的第二份硬编码，
 * 与 `lib/action-error.ts` 的 `OPAQUE_TOKEN_MESSAGES` 各改各的会漂移，且仓内无任何测试守护
 * （issue #133 的 pr-ready 审查发现）。现在统一走 `actionErrorType`，本文件锁住行为。
 */
type BoundaryError = Error & { digest?: string }

function errorWith(opts: { message?: string; digest?: string }): BoundaryError {
  const e = new Error(opts.message ?? 'boom') as BoundaryError
  if (opts.digest !== undefined) e.digest = opts.digest
  return e
}

/** Next 生产构建对 Server Component 错误 message 的脱敏话术。 */
const SANITIZED =
  'An error occurred in the Server Components render. The specific message is omitted in ' +
  'production builds to avoid leaking sensitive details.'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('(main)/error.tsx 错误分级', () => {
  it('PermissionError 的裸 token digest → 403（生产形态：message 已脱敏）', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: 'PERMISSION_DENIED' })} reset={vi.fn()} />)
    expect(screen.getByText('403')).toBeTruthy()
    expect(screen.getByText('无权访问此页面')).toBeTruthy()
  })

  it('dev 形态：digest 缺失但 message 带前缀 → 403', () => {
    render(<ErrorPage error={errorWith({ message: 'PERMISSION_DENIED: 无权执行 store:update' })} reset={vi.fn()} />)
    expect(screen.getByText('403')).toBeTruthy()
  })

  it('UNAUTHORIZED → 401', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: 'UNAUTHORIZED' })} reset={vi.fn()} />)
    expect(screen.getByText('401')).toBeTruthy()
    expect(screen.getByText('登录已过期')).toBeTruthy()
  })

  it('Next 自动 digest（纯数字编号）→ 500，并把编号展示出来供客服定位', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: '1956068727' })} reset={vi.fn()} />)
    expect(screen.getByText('500')).toBeTruthy()
    // 页面级兜底页是全仓唯一允许展示错误编号的地方（toast / 内联提示一律不展示）
    expect(screen.getByText('错误编号: 1956068727')).toBeTruthy()
  })

  it('其它业务错误（非 401/403）→ 500，不误判', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: 'CONFLICT: 数据已被修改' })} reset={vi.fn()} />)
    expect(screen.getByText('500')).toBeTruthy()
  })
})
