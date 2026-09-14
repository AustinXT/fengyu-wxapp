import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { AuthSession } from './types'

// 端到端用例要真的跑一遍 withPermission（生产者侧），故按 with-permission.test.ts 的同款 mock 起环境。
const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { actionErrorMessage, actionErrorType } from './action-error'
import { ApiError } from './api-error'
import { withPermission } from './with-permission'

const require_ = createRequire(import.meta.url)
/** Next 真身：`next/dist/server/app-render/create-error-handler.js` 用它生成自动 digest。 */
const stringHash = require_('next/dist/compiled/string-hash') as (s: string) => number

/** Next 生产构建对 Server Action / RSC 错误 message 的脱敏话术（逐字取自 issue #133 现场）。 */
const NEXT_SANITIZED_MESSAGE =
  'An error occurred in the Server Components render. The specific message is omitted in ' +
  'production builds to avoid leaking sensitive details. A digest property is included on this ' +
  'error instance which may provide additional details about the nature of the error.'

type ClientError = Error & { digest?: string }

/**
 * 模拟 Next **生产构建**把服务端抛出的错误送到客户端后的形态：
 * message 换成脱敏话术，digest 原样转发；服务端没写 digest 的，由 Next 补自动编号。
 * issue #133 的两个复现场景都发生在这一形态下。
 */
function asProductionError(thrown: unknown): ClientError {
  const source = thrown as ClientError
  const client = new Error(NEXT_SANITIZED_MESSAGE) as ClientError
  client.digest = source.digest ?? stringHash(`${source.message}${source.stack ?? ''}`).toString()
  return client
}

/** 模拟**开发构建**：message 保留原文，digest 同样会被补上。 */
function asDevError(thrown: unknown): ClientError {
  const source = thrown as ClientError
  const client = new Error(source.message) as ClientError
  client.digest = source.digest ?? stringHash(`${source.message}${source.stack ?? ''}`).toString()
  return client
}

function makeSession(actions: string[]): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '测试用户',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: { actions, scopeStoreIds: [] },
  }
}

/** 跑一遍真实的 withPermission，返回它抛出的错误（服务端形态）。 */
async function throwFromAction(thrown: unknown): Promise<unknown> {
  mockGetSession.mockResolvedValue(makeSession(['inventory:create_doc']))
  const wrapped = withPermission('inventory:create_doc', async () => {
    throw thrown
  })
  try {
    await wrapped()
  } catch (e) {
    return e
  }
  throw new Error('期望 action 抛错，但它正常返回了')
}

function digestOf(digest: string): ClientError {
  const e = new Error(NEXT_SANITIZED_MESSAGE) as ClientError
  e.digest = digest
  return e
}

beforeEach(() => {
  mockRedirect.mockClear()
  mockGetSession.mockReset()
})

describe('issue #133 复现场景', () => {
  it('场景 A：库存期初门禁拦截，用户看到的是拦截理由而非英文脱敏话术', async () => {
    const thrown = await throwFromAction(
      new ApiError('INVALID_STATE', '库存期初尚未导入并核验完成，暂不可办理库存业务'),
    )

    // 前置：rethrowWithDigest 把可读 message 放进 digest，才有后面的穿透
    expect((thrown as ClientError).digest).toBe(
      'INVALID_STATE: 库存期初尚未导入并核验完成，暂不可办理库存业务',
    )

    expect(actionErrorMessage(asProductionError(thrown), '创建失败')).toBe(
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
    )
    // dev 构建同样正确（两端行为一致，避免只在一种构建下验过就放行）
    expect(actionErrorMessage(asDevError(thrown), '创建失败')).toBe(
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
    )
  })

  it('场景 B：非白名单错误退回业务兜底文案，绝不显示 digest 数字编号', async () => {
    // 员工购加载员工列表时的递归 CTE 别名错（issue #130），属非预期错误 → 不补 digest
    const thrown = await throwFromAction(
      new Error('column reference "employee_id" is ambiguous'),
    )
    expect((thrown as ClientError).digest).toBeUndefined()

    const clientError = asProductionError(thrown)
    // 复现前提：Next 补的自动 digest 确实是一串纯数字（issue 里显示的 1956068727 就是它）
    expect(clientError.digest).toMatch(/^\d+$/)

    const shown = actionErrorMessage(clientError, '加载市场员工失败')
    expect(shown).toBe('加载市场员工失败')
    expect(shown).not.toBe(clientError.digest)
    // 也不能把 SQL 细节漏给用户
    expect(shown).not.toContain('employee_id')
  })
})

describe('digest 通道 fail-closed：非白名单形态一律不展示', () => {
  // 每一项都是「Next 会真实塞进 digest 的东西」，全部必须回退兜底
  it.each([
    ['纯数字自动编号', '1956068727'],
    // Next 15.5 lib/error-telemetry-utils.js：带 __NEXT_ERROR_CODE 的错误会拼 `@E<码>`
    ['带错误码后缀的自动编号', '1956068727@E394'],
    ['重定向信号', 'NEXT_REDIRECT;replace;/login?expired=1;307;'],
    ['HTTP 兜底信号', 'NEXT_HTTP_ERROR_FALLBACK;404'],
    ['动态渲染信号', 'DYNAMIC_SERVER_USAGE'],
    ['非白名单业务前缀', 'FOO_BAR: 内部说明不该给用户看'],
    ['只有前缀没有正文', 'CONFLICT:'],
    ['空串', '   '],
  ])('%s → 回退兜底', (_label, digest) => {
    expect(actionErrorMessage(digestOf(digest), '加载失败')).toBe('加载失败')
  })

  it('digest 不是字符串（对象/数字）时按无 digest 处理', () => {
    const e1 = new Error(NEXT_SANITIZED_MESSAGE) as Error & { digest?: unknown }
    e1.digest = 12345
    expect(actionErrorMessage(e1, '加载失败')).toBe('加载失败')

    const e2 = new Error(NEXT_SANITIZED_MESSAGE) as Error & { digest?: unknown }
    e2.digest = { toString: () => 'CONFLICT: 伪造的可读文案' }
    expect(actionErrorMessage(e2, '加载失败')).toBe('加载失败')
  })
})

describe('业务文案提取', () => {
  it('剥掉一级白名单前缀', () => {
    expect(actionErrorMessage(digestOf('CONFLICT: 订单已被审核，请刷新后重试'), '兜底')).toBe(
      '订单已被审核，请刷新后重试',
    )
  })

  it('二级子标签只进日志，不展示给用户', () => {
    expect(
      actionErrorMessage(digestOf('INVALID_STATE: CARD_EXHAUSTED: 储值卡剩余次数为 0'), '兜底'),
    ).toBe('储值卡剩余次数为 0')
  })

  it('裸 token 换成中文说法，不把内部枚举端给用户', () => {
    // lib/permissions.ts 的 PermissionError：digest 是给 error.tsx 判 403 用的信号量
    expect(actionErrorMessage(digestOf('PERMISSION_DENIED'), '兜底')).toBe('无权执行该操作')
    expect(actionErrorMessage(digestOf('UNAUTHORIZED'), '兜底')).toBe('登录已过期，请重新登录')
  })

  it('9 项白名单前缀全部认得', () => {
    const cases: Array<[string, string]> = [
      ['UNAUTHORIZED: 登录态失效', '登录态失效'],
      ['PHONE_REQUIRED: 请先绑定手机号', '请先绑定手机号'],
      ['INVALID_PARAMS: id 必填', 'id 必填'],
      ['PERMISSION_DENIED: 无权执行 employee:update', '无权执行 employee:update'],
      ['NOT_FOUND: 订单不存在', '订单不存在'],
      ['INSUFFICIENT_BALANCE: 储值卡余额不足', '储值卡余额不足'],
      ['CONFLICT: 数据已被修改', '数据已被修改'],
      ['INVALID_STATE: 订单状态不允许该操作', '订单状态不允许该操作'],
      ['CLIENT_NOT_REGISTERED: 顾客未绑定门店', '顾客未绑定门店'],
    ]
    for (const [digest, expected] of cases) {
      expect(actionErrorMessage(digestOf(digest), '兜底')).toBe(expected)
    }
  })
})

describe('message 通道 fail-open：本地 throw 的可读文案不被误伤', () => {
  it('前端本地 throw 的带前缀错误（lib/recharge-tier.ts matchTier）剥前缀后展示', () => {
    expect(actionErrorMessage(new Error('INVALID_PARAMS: 最低充值金额 ¥100'), '金额无效')).toBe(
      '最低充值金额 ¥100',
    )
  })

  it('前端本地 throw 的无前缀中文原样展示', () => {
    expect(actionErrorMessage(new Error('该组合福利没有完整的单品替代方案'), '兜底')).toBe(
      '该组合福利没有完整的单品替代方案',
    )
  })

  it('脱敏话术 / 网络层错误回退兜底', () => {
    const unreadable = [
      NEXT_SANITIZED_MESSAGE,
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'An unexpected response was received from the server.',
      'read ECONNRESET',
      'Error: ESOCKET',
      'connect ETIMEDOUT 10.0.0.1:1433',
    ]
    for (const message of unreadable) {
      expect(actionErrorMessage(new Error(message), '加载失败')).toBe('加载失败')
    }
  })

  it('非 Error / 空 message / null 一律兜底', () => {
    expect(actionErrorMessage('boom', '兜底')).toBe('兜底')
    expect(actionErrorMessage(null, '兜底')).toBe('兜底')
    expect(actionErrorMessage(undefined, '兜底')).toBe('兜底')
    expect(actionErrorMessage(new Error(''), '兜底')).toBe('兜底')
    expect(actionErrorMessage({ digest: 'CONFLICT: 无 Error 外壳也认' }, '兜底')).toBe(
      '无 Error 外壳也认',
    )
  })
})

describe('actionErrorType：按业务类型分支渲染', () => {
  it('生产形态下仍能判出 PERMISSION_DENIED（employees/[id] 重置密码文案依赖它）', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:list'])) // 无 employee:reset_password
    const wrapped = withPermission('employee:reset_password', async () => 'unreachable')
    let thrown: unknown
    try {
      await wrapped()
    } catch (e) {
      thrown = e
    }

    // PermissionError 自带裸 token digest；生产下 message 已脱敏，判 message 前缀会恒不成立
    const clientError = asProductionError(thrown)
    expect(clientError.message.startsWith('PERMISSION_DENIED:')).toBe(false)
    expect(actionErrorType(clientError)).toBe('PERMISSION_DENIED')
  })

  it('digest 带前缀 / message 带前缀 / 都没有', () => {
    expect(actionErrorType(digestOf('INVALID_STATE: CARD_EXHAUSTED: 卡已用完'))).toBe('INVALID_STATE')
    expect(actionErrorType(new Error('NOT_FOUND: 订单不存在'))).toBe('NOT_FOUND')
    expect(actionErrorType(digestOf('1956068727'))).toBeNull()
    expect(actionErrorType(new Error('普通崩溃'))).toBeNull()
    expect(actionErrorType(null)).toBeNull()
  })
})

describe('Next 内部实现漂移守护', () => {
  it('自动 digest 仍由 string-hash 生成，且恒为无符号 32 位十进制串', () => {
    const samples = ['', 'a', 'column reference "x" is ambiguous', '中文错误信息', 'x'.repeat(5000)]
    for (const s of samples) {
      const hash = stringHash(s)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
      expect(hash.toString()).toMatch(/^\d{1,10}$/)
    }
  })

  it('create-error-handler 仍在「服务端未设 digest」时才自动补编号', () => {
    // 这是整条穿透链路的前提：我们写的 digest 不会被 Next 覆盖。
    // Next 升级后若此断言失败 → 先重新核对 rethrowWithDigest 是否还成立，再改本用例。
    const source = readFileSync(
      require_.resolve('next/dist/server/app-render/create-error-handler.js'),
      'utf8',
    )
    expect(source).toMatch(/if\s*\(!err\.digest\)/)
    expect(source).toContain('_stringhash.default')
  })
})
