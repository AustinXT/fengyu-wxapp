import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorPage, { DIGEST_PATTERN } from './error'

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

  it('其它业务错误（非 401/403）→ 500，展示业务理由而非通用话术', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: 'CONFLICT: 数据已被修改' })} reset={vi.fn()} />)
    expect(screen.getByText('500')).toBeTruthy()
    expect(screen.getByText('数据已被修改')).toBeTruthy()
    // 业务文案型 digest 绝不能再被当成「错误编号」原样渲染（评审 round 1 的 P1）
    expect(screen.queryByText(/错误编号/)).toBeNull()
  })

  it('技术细节型 digest 既不当编号展示、也不当业务理由展示', () => {
    render(
      <ErrorPage
        error={errorWith({ message: SANITIZED, digest: 'INVALID_STATE: CLIENT_SECRET is not configured' })}
        reset={vi.fn()}
      />,
    )
    expect(screen.getByText('500')).toBeTruthy()
    expect(screen.queryByText(/CLIENT_SECRET/)).toBeNull()
    expect(screen.queryByText(/错误编号/)).toBeNull()
    expect(screen.getByText('抱歉，页面加载出现问题，请稍后重试')).toBeTruthy()
  })

  it('带 @E 错误码后缀的 Next 自动编号也认', () => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: '1956068727@E394' })} reset={vi.fn()} />)
    expect(screen.getByText('错误编号: 1956068727@E394')).toBeTruthy()
  })
})

/**
 * digest 白名单的跨端一致性（#316）。
 *
 * 这条正则在 `fengyu-analyst/src/components/analyst-error-state.tsx` 有一份**刻意的副本**
 * （跨端共享目录已 veto）。#316 之前两边都写成 `@[A-Za-z][\w-]*`，`[\w-]` 含 `_` 与 `-`，
 * 于是任何 snake_case / kebab-case 技术串都整串放行——"过滤"掉的只是标点，不是语义。
 * analyst 侧先收紧，本文件同步；两侧各留一条字面量锚定，任一边漂移两边都红。
 */
describe('(main)/error.tsx digest 白名单（跨端副本，与 analyst 同步）', () => {
  it('正则含 flags 的字面量锚定——与 analyst 那份逐字一致', () => {
    // ⚠️ 真正的跨端比对（读本文件源码 vs analyst 实际正则）在 analyst 侧的
    //    src/lib/__tests__/digest-whitelist-cross-end.test.ts。这里钉本端形态，两条合起来才够：
    //    只比「本端导出 vs 本端硬编码」，两边一起改就双绿（闸门 2 codex 指出）。
    // 比 toString() 而不是 .source：后者不含 flags，同时误加 m 会放行多行串。
    expect(DIGEST_PATTERN.toString()).toBe('/^\\d{1,10}(?:@E\\d{1,9})?$/')
  })

  it('⚠️ 没有 m flag——多行 digest 不得被当成错误编号', () => {
    render(
      <ErrorPage
        error={errorWith({ message: SANITIZED, digest: '123\npostgresql_fengyu_fengyu123' })}
        reset={vi.fn()}
      />,
    )
    expect(screen.queryByText(/错误编号/)).toBeNull()
  })

  it.each([
    ['snake_case 的底层错误', '1@ECONNREFUSED_127-0-0-1_5432'],
    ['snake_case 的连接串（含口令）', '0@postgresql_fengyu_fengyu123_localhost_5432'],
    ['snake_case 的业务串', '1@INVALID_STATE_CLIENT_SECRET_not_configured'],
    ['无上界的长后缀（会撑破卡片）', `1@${'a'.repeat(60)}`],
  ])('⚠️ %s 不得被当成错误编号渲染（收紧前整串放行）', (_label, leaky) => {
    render(<ErrorPage error={errorWith({ message: SANITIZED, digest: leaky })} reset={vi.fn()} />)
    expect(screen.queryByText(/错误编号/)).toBeNull()
    expect(screen.queryByText(new RegExp(leaky.slice(0, 12)))).toBeNull()
  })
})
