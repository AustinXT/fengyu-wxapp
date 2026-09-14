import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
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
import { ApiError, ERROR_PREFIXES } from './api-error'
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
 * 模拟 Next 把服务端抛出的错误送到客户端后的形态：digest 原样转发，服务端没写的由 Next 补自动编号；
 * message 在**生产构建**下换成脱敏话术（默认），在**开发构建**下保留原文（传 `source.message`）。
 * issue #133 的两个复现场景都发生在生产形态下。
 */
function asClientError(thrown: unknown, message = NEXT_SANITIZED_MESSAGE): ClientError {
  const source = thrown as ClientError
  const client = new Error(message) as ClientError
  client.digest = source.digest ?? stringHash(`${source.message}${source.stack ?? ''}`).toString()
  return client
}

const asProductionError = (thrown: unknown) => asClientError(thrown)
const asDevError = (thrown: unknown) => asClientError(thrown, (thrown as ClientError).message)

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
async function throwFromAction(thrown: unknown, action = 'inventory:create_doc'): Promise<unknown> {
  mockGetSession.mockResolvedValue(makeSession(['inventory:create_doc']))
  const wrapped = withPermission(action, async () => {
    throw thrown
  })
  try {
    await wrapped()
  } catch (e) {
    return e
  }
  throw new Error('期望 action 抛错，但它正常返回了')
}

/** 造一个「生产形态 + 指定 digest」的客户端错误。（与生产文件的 pick 无关，勿混） */
function withDigest(digest: string): ClientError {
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
    // dev 构建下 message 是 SQL 原文，同样不能端给用户
    expect(actionErrorMessage(asDevError(thrown), '加载市场员工失败')).toBe('加载市场员工失败')
  })
})

describe('闸门一 · 来源：digest 必须带白名单前缀（fail-closed）', () => {
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
    expect(actionErrorMessage(withDigest(digest), '加载失败')).toBe('加载失败')
  })

  it('digest 不是字符串（数字 / 带 toString 的对象）时按无 digest 处理', () => {
    const e1 = new Error(NEXT_SANITIZED_MESSAGE) as Error & { digest?: unknown }
    e1.digest = 12345
    expect(actionErrorMessage(e1, '加载失败')).toBe('加载失败')

    const e2 = new Error(NEXT_SANITIZED_MESSAGE) as Error & { digest?: unknown }
    e2.digest = { toString: () => 'CONFLICT: 伪造的可读文案' }
    expect(actionErrorMessage(e2, '加载失败')).toBe('加载失败')
  })

  // 裸 token 查表曾用对象字面量，`digest='toString'` 会命中 Object.prototype 返回函数，
  // 下游 `加载失败：{error}` 收到函数/对象 → React 抛「Objects are not valid as a React child」。
  it.each(['toString', 'valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__'])(
    '原型链键名 %s 不会被当成文案',
    (key) => {
      const shown = actionErrorMessage(withDigest(key), '加载失败')
      expect(typeof shown).toBe('string')
      expect(shown).toBe('加载失败')
    },
  )
})

describe('闸门二 · 内容：前缀合法 ≠ 正文能给人看', () => {
  it.each([
    // system-diagnostics.ts:169,170 的真实代码：剥完子标签只剩 HTTP 码
    ['HTTP 状态码', 'INVALID_STATE: ANALYST_UNAUTHORIZED: 401'],
    ['HTTP 状态码（模板）', 'INVALID_STATE: ANALYST_UNAVAILABLE: 503'],
    // lakala-client.ts / system-diagnostics.ts 的真实代码：正文是内部枚举或英文
    ['内部枚举', 'INVALID_STATE: LAKALA_NOT_CONFIGURED'],
    ['内部枚举（退款）', 'INVALID_PARAMS: REFUND_NEEDS_ORIGIN_REFERENCE'],
    ['英文技术说明', 'INVALID_STATE: CLIENT_SECRET is not configured'],
    ['英文技术说明（网关）', 'INVALID_STATE: gateway unavailable'],
    // 前缀合法但正文夹带内网地址 —— 黑名单必须在白名单之后仍然生效
    ['内网地址', 'INVALID_STATE: 同步失败 connect ETIMEDOUT 10.0.0.1:1433'],
    ['连接被拒', 'INVALID_STATE: 同步失败 ECONNREFUSED'],
    ['管道断开', 'INVALID_STATE: 写入失败 write EPIPE'],
  ])('%s → 回退兜底', (_label, digest) => {
    expect(actionErrorMessage(withDigest(digest), '操作失败')).toBe('操作失败')
  })

  it('多行错误只取首行，SQL / 堆栈不跟着出去', () => {
    const shown = actionErrorMessage(
      withDigest(
        'NOT_FOUND: 订单不存在\nSQL: select * from sale_orders where id=$1\n  at query (/app/node_modules/pg/lib/client.js:526:17)',
      ),
      '兜底',
    )
    expect(shown).toBe('订单不存在')
    expect(shown).not.toContain('select')
    expect(shown).not.toContain('node_modules')
  })

  it('超长文案截断，不把 toast / 内联红字撑爆', () => {
    const shown = actionErrorMessage(withDigest(`CONFLICT: ${'这是一条很长的业务错误文案'.repeat(500)}`), '兜底')
    expect(shown.length).toBeLessThanOrEqual(121)
    expect(shown.endsWith('…')).toBe(true)
  })

  it('正文是内部枚举时，类型判定不受影响（类型可知 ≠ 正文可读）', () => {
    expect(actionErrorType(withDigest('INVALID_STATE: LAKALA_NOT_CONFIGURED'))).toBe('INVALID_STATE')
  })
})

describe('业务文案提取', () => {
  it('剥掉一级白名单前缀', () => {
    expect(actionErrorMessage(withDigest('CONFLICT: 订单已被审核，请刷新后重试'), '兜底')).toBe(
      '订单已被审核，请刷新后重试',
    )
  })

  it('二级子标签只进日志，不展示给用户', () => {
    expect(
      actionErrorMessage(withDigest('INVALID_STATE: CARD_EXHAUSTED: 储值卡剩余次数为 0'), '兜底'),
    ).toBe('储值卡剩余次数为 0')
    // 仓内真实形态：NO_CARD 子标签（actions/orders.ts:756）
    expect(
      actionErrorMessage(withDigest('INSUFFICIENT_BALANCE: NO_CARD: 顾客无储值卡账户'), '兜底'),
    ).toBe('顾客无储值卡账户')
  })

  it('「看着像子标签、其实是正文」的不剥（子标签必须含下划线）', () => {
    expect(actionErrorMessage(withDigest('NOT_FOUND: ID: 123 的订单不存在'), '兜底')).toBe(
      'ID: 123 的订单不存在',
    )
    expect(actionErrorMessage(withDigest('INVALID_PARAMS: SKU: 缺货'), '兜底')).toBe('SKU: 缺货')
  })

  it('裸 token 换成中文说法，不把内部枚举端给用户', () => {
    // lib/permissions.ts 的 PermissionError：digest 是给 error.tsx 判 403 用的信号量
    expect(actionErrorMessage(withDigest('PERMISSION_DENIED'), '兜底')).toBe('无权执行该操作')
    expect(actionErrorMessage(withDigest('UNAUTHORIZED'), '兜底')).toBe('登录已过期，请重新登录')
  })

  it.each([...ERROR_PREFIXES])('白名单前缀 %s 走得通（遍历而非写死，加第 10 项会报警）', (prefix) => {
    const shown = actionErrorMessage(withDigest(`${prefix}: 这是一条业务提示`), '兜底')
    expect(shown).toBe('这是一条业务提示')
    expect(actionErrorType(withDigest(`${prefix}: 这是一条业务提示`))).toBe(prefix)
  })
})

describe('message 通道 fail-open：本地 throw 的可读中文不被误伤', () => {
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

  it.each([
    ['纯数字编号', '1956068727'],
    ['JS 运行时错', "Cannot read properties of undefined (reading 'map')"],
    ['SQL 报错', 'column reference "employee_id" is ambiguous'],
    ['带堆栈', 'TypeError: x is not a function\n    at Board (/app/.next/static/chunks/main.js:1:2)'],
    ['内部枚举', 'LAKALA_TIMEOUT_8000ms'],
    ['脱敏话术', NEXT_SANITIZED_MESSAGE],
    ['fetch 失败', 'Failed to fetch'],
    ['NetworkError', 'NetworkError when attempting to fetch resource.'],
    ['RSC 响应异常', 'An unexpected response was received from the server.'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['ESOCKET', 'Error: ESOCKET'],
    ['ETIMEDOUT + 内网地址', 'connect ETIMEDOUT 10.0.0.1:1433'],
  ])('%s → 回退兜底', (_label, message) => {
    expect(actionErrorMessage(new Error(message), '加载失败')).toBe('加载失败')
  })

  it('全角冒号写错时也不把前缀 token 漏给用户', () => {
    expect(actionErrorMessage(new Error('PERMISSION_DENIED：无权执行该操作'), '兜底')).toBe(
      '无权执行该操作',
    )
  })

  it('非 Error / 空 message / null 一律兜底', () => {
    expect(actionErrorMessage('boom', '兜底')).toBe('兜底')
    expect(actionErrorMessage(null, '兜底')).toBe('兜底')
    expect(actionErrorMessage(undefined, '兜底')).toBe('兜底')
    expect(actionErrorMessage(42, '兜底')).toBe('兜底')
    expect(actionErrorMessage(new Error(''), '兜底')).toBe('兜底')
    expect(actionErrorMessage(Object.create(null), '兜底')).toBe('兜底')
    expect(actionErrorMessage({ digest: 'CONFLICT: 无 Error 外壳也认' }, '兜底')).toBe(
      '无 Error 外壳也认',
    )
    // 跨 RSC 边界的错误可能只是普通对象，message 通道也不要求 instanceof Error
    expect(actionErrorMessage({ message: 'CONFLICT: 普通对象的 message' }, '兜底')).toBe(
      '普通对象的 message',
    )
  })

  it('自己绝不抛：digest / message 是会抛的 getter 或 Proxy 时也返回兜底', () => {
    const boobyTrapped = new Error('m')
    Object.defineProperty(boobyTrapped, 'digest', {
      get() {
        throw new Error('boom-getter')
      },
    })
    expect(actionErrorMessage(boobyTrapped, '兜底')).toBe('兜底')
    expect(actionErrorType(boobyTrapped)).toBeNull()

    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy-boom')
        },
      },
    )
    expect(actionErrorMessage(proxy, '兜底')).toBe('兜底')
    expect(actionErrorType(proxy)).toBeNull()
  })
})

describe('actionErrorType：按业务类型分支渲染', () => {
  it('生产形态下仍能判出 PERMISSION_DENIED（重置密码 / 组织删除的专属文案依赖它）', async () => {
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

  it('可达面与 actionErrorMessage 一致：只认实际会产出的那两个裸 token', () => {
    expect(actionErrorType(withDigest('PERMISSION_DENIED'))).toBe('PERMISSION_DENIED')
    expect(actionErrorType(withDigest('UNAUTHORIZED'))).toBe('UNAUTHORIZED')
    // 其余 7 项不会以裸形态产出；放行会造成「类型判得出、文案判不出」的不一致
    expect(actionErrorType(withDigest('NOT_FOUND'))).toBeNull()
    expect(actionErrorType(withDigest('CONFLICT'))).toBeNull()
  })

  it('digest 带前缀 / message 带前缀 / 都没有', () => {
    expect(actionErrorType(withDigest('INVALID_STATE: CARD_EXHAUSTED: 卡已用完'))).toBe('INVALID_STATE')
    expect(actionErrorType(new Error('NOT_FOUND: 订单不存在'))).toBe('NOT_FOUND')
    expect(actionErrorType(withDigest('1956068727'))).toBeNull()
    expect(actionErrorType(new Error('普通崩溃'))).toBeNull()
    expect(actionErrorType(null)).toBeNull()
  })
})

describe('Next 行为漂移守护', () => {
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

  it('rethrowWithDigest 写的 digest 不被 Next 覆盖（整条穿透链路的前提）', async () => {
    // 行为守护而非源码 tripwire：Next 内部文件路径/标识符重命名不该让本用例假红，
    // 真正要盯的是「我们写进 digest 的业务文案还在不在」。
    const thrown = (await throwFromAction(
      new ApiError('CONFLICT', '订单已被审核，请刷新后重试'),
    )) as ClientError
    expect(thrown.digest).toBe('CONFLICT: 订单已被审核，请刷新后重试')
    expect(actionErrorMessage(asProductionError(thrown), '兜底')).toBe('订单已被审核，请刷新后重试')
  })
})
