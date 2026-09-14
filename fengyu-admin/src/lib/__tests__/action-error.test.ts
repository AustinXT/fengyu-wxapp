import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthSession } from '../types'

// withPermission 的依赖：仅为「服务端抛 → 客户端显示」整链路用例服务。
const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { actionErrorMessage } from '../action-error'
import { ApiError, ERROR_PREFIXES } from '../api-error'
import { withPermission } from '../with-permission'

const FALLBACK = '加载市场员工失败'

/** Next 生产构建对 Server Action / Server Component 错误 message 的脱敏话术。 */
const NEXT_SANITIZED_MESSAGE =
  'An error occurred in the Server Components render. The specific message is omitted in ' +
  'production builds to avoid leaking sensitive details. A digest property is included on this ' +
  'error instance which may provide additional details about the nature of the error.'

/**
 * `next/dist/compiled/string-hash` 的本地副本 —— 只用于「造出与线上同形的自动 digest」。
 * 与 Next 真实实现的一致性由本文件末尾的漂移守护用例盯着（不一致立即报错）。
 */
function stringHash(str: string): number {
  let hash = 5381
  let i = str.length
  while (i) hash = (hash * 33) ^ str.charCodeAt(--i)
  return hash >>> 0
}

type ClientError = Error & { digest?: string }

/**
 * 模拟 Next **生产构建**把服务端抛出的错误送到客户端后的形态：
 * message 被换成脱敏话术；digest 原样转发，原本没有 digest 的补一个自动编号。
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

/** 跑一次真实的 withPermission，把它抛出来的错误原样交回。 */
async function throwThroughWithPermission(thrower: () => never): Promise<unknown> {
  mockGetSession.mockResolvedValue(makeSession(['employee:update']))
  const wrapped = withPermission('employee:update', async () => thrower())
  try {
    await wrapped()
  } catch (e) {
    return e
  }
  throw new Error('期望抛错但没有抛')
}

describe('actionErrorMessage', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  describe('业务文案透出', () => {
    it('digest 带白名单前缀：剥前缀后原样展示', () => {
      const err = { digest: 'INVALID_STATE: 库存期初尚未导入并核验完成，暂不可办理库存业务' }
      expect(actionErrorMessage(err, FALLBACK)).toBe(
        '库存期初尚未导入并核验完成，暂不可办理库存业务',
      )
    })

    it('二级前缀：一级前缀与子标签都剥掉（子标签按约定仅供日志归类）', () => {
      const err = { digest: 'INVALID_STATE: REFERENCE_EXISTS: 该分类下还有 3 个 SKU，无法删除；请先停用' }
      expect(actionErrorMessage(err, FALLBACK)).toBe('该分类下还有 3 个 SKU，无法删除；请先停用')
    })

    // 仓内真实**抛出形态**（orders.ts:7030/7043/7047/7456 等）：子标签后面挂着无空格载荷，
    // 以「冒号+空格」收尾。必须整段剥掉，只剥到第一个冒号会把载荷剩在句首。
    // 注：OVERPAY 族那几条在 recordPayment 里被服务端预解析收敛成返回值，走不到 toast；
    // 此处测的是剥壳逻辑本身。真正客户端可达的是下面 confirmOfflinePayment 的数字族。
    it.each([
      [
        'CONFLICT: OVERPAY:123.45: 本次回款金额超过订单欠款',
        '本次回款金额超过订单欠款',
      ],
      [
        'INVALID_PARAMS: OVERPAY_ITEM:SI-8801:NOT_FOUND: 回款明细行不存在于该订单',
        '回款明细行不存在于该订单',
      ],
      [
        'CONFLICT: OVERPAY_ITEM:SI-8801:12.00: 该明细行回款金额超过可回款额',
        '该明细行回款金额超过可回款额',
      ],
      // 一级前缀后面不带空格（orders.ts:700 的真实写法）
      ['INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户', '顾客无储值卡账户'],
      // 子标签首段是**纯数字**的同族写法（orders.ts:3496，confirmOfflinePayment 直抛、
      // 无服务端预解析 → 客户端真能看到）。大写族修了、数字族漏了就是修了一半。
      [
        'INSUFFICIENT_BALANCE:123.45: 顾客储值卡余额不足，期望扣 150，实际 123.45',
        '顾客储值卡余额不足，期望扣 150，实际 123.45',
      ],
      ['INSUFFICIENT_BALANCE:0: 顾客储值卡余额不足', '顾客储值卡余额不足'],
    ])('带载荷的子标签整段剥掉：%s', (digest, expected) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it.each([
      ['SKU: FY-001 库存不足', 'SKU: FY-001 库存不足'],
      ['ID: 123 的订单不存在', 'ID: 123 的订单不存在'],
      ['URL: https://example.com/a 打不开', 'URL: https://example.com/a 打不开'],
    ])('非白名单的业务语义标签不剥（%s）', (message, expected) => {
      // 一级前缀走 9 项白名单精确匹配，不做形状匹配 —— 否则 ID/URL/SKU 这类标签会被误吃
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(expected)
    })

    it.each(['ID: 123', 'URL: https://example.com/a'])(
      '但整串没有一个中文字的，一律不是给用户看的文案（%s）',
      (message) => {
        expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
      },
    )

    it.each([
      ['NOT_FOUND: SKU: S-001 不存在', 'SKU: S-001 不存在'],
      ['INVALID_PARAMS: ID: 123 不合法', 'ID: 123 不合法'],
      ['NOT_FOUND: URL: https://example.com 打不开', 'URL: https://example.com 打不开'],
    ])('短标签（≤3 字符）不当子标签剥：%s', (digest, expected) => {
      // 仓内真实子标签最短 7 字符（NO_CARD / OVERPAY），用长度把它们与 ID/SKU/URL 分开
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it('无 digest 但 message 可读（dev 构建）：原样展示', () => {
      expect(actionErrorMessage(new Error('该顾客未绑定门店'), FALLBACK)).toBe('该顾客未绑定门店')
    })

    it('业务里裸抛的中文 message 不带 Error 头，不会被内建错误名规则误伤', () => {
      expect(actionErrorMessage(new Error('该顾客未绑定门店，无法开单'), FALLBACK)).toBe(
        '该顾客未绑定门店，无法开单',
      )
    })

    it('不误剥含连字符的业务标识', () => {
      const err = { digest: 'CONFLICT: FY-XSD-WX-2609140001 已存在' }
      expect(actionErrorMessage(err, FALLBACK)).toBe('FY-XSD-WX-2609140001 已存在')
    })

    it('剥前缀后首尾空白被清掉', () => {
      expect(actionErrorMessage({ digest: '  NOT_FOUND:   订单不存在  ' }, FALLBACK)).toBe(
        '订单不存在',
      )
    })
  })

  describe('#133 场景 B：Next 自动生成的 digest 不得当成文案', () => {
    it('纯数字 digest + 脱敏 message → 回退调用方 fallback', () => {
      // 线上实际观测到的那一串：办理台员工购加载失败时 toast 显示 1956068727
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: '1956068727' })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it.each(['0', '5', '42', '4294967295'])(
      '纯数字 digest %s 一律判为编号而非文案',
      (digest) => {
        const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
        expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
      },
    )

    it('纯数字 digest + 可读 message（dev 构建）：落到 message，不回退', () => {
      const err = Object.assign(new Error('该分院不在你的管辖范围内'), { digest: '1956068727' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('该分院不在你的管辖范围内')
    })

    it('纯数字串一律不是文案：超出 Next digest 上限的长数字同样回退', () => {
      // 早先的期望是「11 位以上按文案处理」。评审指出这自相矛盾：`ANALYST_UNAUTHORIZED: 401`
      // 剥完剩的 401 要挡，凭什么整串 12345678901 就能端给用户？一串裸数字对用户零信息量。
      expect(actionErrorMessage({ digest: '12345678901' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: '12.50' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: '1200:300' }, FALLBACK)).toBe(FALLBACK)
    })

    // Next 把带 __NEXT_ERROR_CODE 的内部错误 digest 拼成 `<hash>@E<code>`
    // （createDigestWithErrorCode，error-telemetry-utils.js）。admin 19 个 action 模块大量
    // 调 revalidatePath，这条支路是真的会走到的。
    it.each(['1956068727@E263', '0@E1', '4294967295@E999'])(
      '带 Next 错误码后缀的自动 digest %s 也判为编号',
      (digest) => {
        const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
        expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
      },
    )
  })

  describe('客户端自抛的异常不经 Next 脱敏，同样不能端给用户', () => {
    // ⚠️ 真实的原生异常 message **不含错误名**（`new TypeError('x').message === 'x'`），
    // 所以「拿 new Error('TypeError: …') 当 fixture」是假的 —— 它只覆盖了被 String() 过的形态。
    // 下面这组是真抛出来的。
    it('真实 TypeError：属性名不会被端给用户', () => {
      let caught: unknown
      try {
        ;(undefined as unknown as { id: string }).id
      } catch (e) {
        caught = e
      }
      expect((caught as Error).message).toContain('Cannot read properties of undefined')
      expect(actionErrorMessage(caught, FALLBACK)).toBe(FALLBACK)
    })

    it('真实 RangeError：Invalid time value 不会被端给用户', () => {
      let caught: unknown
      try {
        new Date('x').toISOString()
      } catch (e) {
        caught = e
      }
      expect(actionErrorMessage(caught, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      new TypeError('x is not a function'),
      new ReferenceError('x is not defined'),
      new SyntaxError('Unexpected token <'),
      new RangeError('Invalid array length'),
      Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' }),
      Object.assign(new Error("Failed to execute 'fetch'"), { name: 'DOMException' }),
    ])('内建异常 $name → 回退 fallback', (err) => {
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('项目自己的错误类不受影响（name 不在内建集合里）', () => {
      const permissionLike = Object.assign(new Error('NOT_FOUND: 该分院不存在'), {
        name: 'PermissionError',
      })
      expect(actionErrorMessage(permissionLike, FALLBACK)).toBe('该分院不存在')
      // ApiError 没改 name，仍是 'Error'
      expect(new ApiError('NOT_FOUND', 'x').name).toBe('ApiError')
    })

    it.each([
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'Error: boom',
      "DOMException: Failed to execute 'fetch' on 'Window'",
    ])('被字符串化过的形态 %s 也回退', (message) => {
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('技术 token 不得端给用户', () => {
    it('digest = PERMISSION_DENIED（PermissionError 的裸 token）→ 给标准中文说法', () => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: 'PERMISSION_DENIED' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('无权执行该操作')
    })

    it('digest = UNAUTHORIZED → 给标准中文说法', () => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: 'UNAUTHORIZED' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('登录已过期，请重新登录')
    })

    it.each([
      'DYNAMIC_SERVER_USAGE',
      'BAILOUT_TO_CLIENT_SIDE_RENDERING',
      'NEXT_NOT_FOUND',
      'NEXT_HTTP_ERROR_FALLBACK;404',
      'NEXT_REDIRECT;replace;/login?expired=1;307;',
    ])('Next 内部信号 %s → 回退 fallback', (digest) => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('整串只有前缀没有正文 → 回退 fallback', () => {
      expect(actionErrorMessage({ digest: 'CONFLICT:' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: 'INVALID_STATE: REFERENCE_EXISTS:' }, FALLBACK)).toBe(
        FALLBACK,
      )
    })
  })

  describe('剥完前缀后必须再判一次（否则技术串从后门溜出去）', () => {
    it.each([
      // orders.ts:7079 —— 只有前缀 + 裸子标签，没有人话
      ['INSUFFICIENT_BALANCE:NO_CARD', '剥完剩裸 token NO_CARD'],
      // system-diagnostics.ts:169/170 —— 子标签后面挂的是 HTTP 状态码
      ['INVALID_STATE: ANALYST_UNAUTHORIZED: 401', '剥完剩纯数字 401'],
      ['INVALID_STATE: ANALYST_UNAVAILABLE: 500', '剥完剩纯数字 500'],
      // lakala-onboarding.ts:1590/1637 把网关的 errorMessage 直通进前缀，可能是纯码
      ['INVALID_STATE: SYSTEM_ERROR', '剥完剩裸 token SYSTEM_ERROR'],
      ['INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH', '剥完剩裸 token'],
      // 整串从头到尾都是标签、没有正文
      ['INSUFFICIENT_BALANCE:12.50', '剥完剩纯金额 12.50'],
      ['CONFLICT: OVERPAY:123', '剥完剩标签串 OVERPAY:123'],
      ['CONFLICT: OVERPAY_ITEM:SI-8801:12.00', '剥完剩标签串（无正文）'],
    ])('%s（%s）→ 回退 fallback', (digest) => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('残串是裸 token 时不套用中文说法表（语义会张冠李戴）', () => {
      // 「并发冲突」不等于「无权限」——不能因为剥完剩 PERMISSION_DENIED 就翻译成「无权执行该操作」
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), {
        digest: 'CONFLICT: PERMISSION_DENIED',
      })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('脱敏 / 网络层文案回退', () => {
    it('脱敏话术且无 digest → 回退 fallback', () => {
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), FALLBACK)).toBe(FALLBACK)
    })

    // ⚠️ fixture 必须用「带小写/空格的真实文案」，不能用裸的 ESOCKET / ETIMEDOUT ——
    // 那种形态会先被「裸技术 token」规则短路，`UNREADABLE_FRAGMENTS` 里对应的片段
    // 其实一行没跑到（删掉这三条片段测试照样全绿）。下面这批才真的守着片段表。
    it.each([
      ['failed to fetch', 'Failed to fetch'],
      ['network request failed', 'Network request failed'],
      ['networkerror', 'NetworkError when attempting to fetch resource.'],
      ['unexpected response', 'An unexpected response was received from the server.'],
      ['econnreset', 'read ECONNRESET'],
      ['esocket', 'Error: connect ESOCKET 10.0.0.1:1433'],
      ['etimedout', 'connect ETIMEDOUT 10.0.0.1:1433'],
    ])('片段 %s（实测文案「%s」）→ 回退 fallback（大小写不敏感）', (_fragment, message) => {
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
    })

    it('片段表逐条都有真红检守着（改坏任一条都会有用例转红）', () => {
      const src = readFileSync(resolve(process.cwd(), 'src/lib/action-error.ts'), 'utf8')
      const block = src.match(/const UNREADABLE_FRAGMENTS = \[([\s\S]*?)\] as const/)?.[1]
      expect(block, '找不到 UNREADABLE_FRAGMENTS').toBeTruthy()
      const fragments = [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1])
      const covered = [
        'server components render',
        'omitted in production',
        'unexpected response',
        'failed to fetch',
        'network request failed',
        'networkerror',
        'econnreset',
        'esocket',
        'etimedout',
        'econnrefused',
        'enotfound',
        'ehostunreach',
        'eai_again',
        'epipe',
        'the network connection was lost',
        'connection appears to be offline',
      ]
      expect(fragments, '片段表变了但本文件的实测文案没跟上').toEqual(covered)
    })

    // 拉卡拉链路会把 Node errno 原文拼进白名单前缀 message（lakala-client.ts:222），
    // 剥完子标签后剩下的就是这些串 —— 内网 IP / 端口 / 内部域名，绝不能端给用户。
    it.each([
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: connect ECONNREFUSED 10.0.0.5:443', 'econnrefused'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo ENOTFOUND api.example.com', 'enotfound'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: connect EHOSTUNREACH 10.0.0.5:443', 'ehostunreach'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo EAI_AGAIN api.example.com', 'eai_again'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: write EPIPE', 'epipe'],
      ['The network connection was lost.', 'the network connection was lost'],
      ['The Internet connection appears to be offline.', 'connection appears to be offline'],
    ])('errno / 浏览器网络文案不泄露内网信息：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    // errno 种类枚举不完（lakala-client.ts:222 把 err.message 原文拼进白名单前缀），
    // 所以按结构认：`connect|getaddrinfo|read|write + E大写码`。下面这批**不在**片段表里。
    it.each([
      'INVALID_STATE: LAKALA_REQUEST_FAILED: connect ENETUNREACH 10.0.0.5:443',
      'INVALID_STATE: LAKALA_REQUEST_FAILED: read ECONNABORTED',
      'INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo ENODATA api.example.com',
    ])('未列入片段表的 errno 也被结构规则挡住：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // 无空白无中文 → 不是人话
      'INVALID_STATE: LAKALA_TIMEOUT_30000ms',
      'INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH',
      'INVALID_STATE: SYSTEM_ERROR',
      // 解析错误的英文技术句
      'INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: Unexpected token < at position 0',
    ])('内部标识与解析细节不外泄：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('入参防御', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['字符串', 'boom'],
      ['数字', 500],
      ['空对象', {}],
    ])('非 Error 入参（%s）→ 回退 fallback', (_label, input) => {
      expect(actionErrorMessage(input, FALLBACK)).toBe(FALLBACK)
    })

    it('digest 为空串 / 空白串 → 落到 message', () => {
      expect(actionErrorMessage(Object.assign(new Error('余额不足'), { digest: '' }), FALLBACK)).toBe(
        '余额不足',
      )
      expect(
        actionErrorMessage(Object.assign(new Error('余额不足'), { digest: '   ' }), FALLBACK),
      ).toBe('余额不足')
    })

    it('digest 非字符串（防御 Next 改类型）→ 落到 message', () => {
      const err = Object.assign(new Error('余额不足'), { digest: 1956068727 })
      expect(actionErrorMessage(err, FALLBACK)).toBe('余额不足')
    })

    it('message 为空且无 digest → 回退 fallback', () => {
      expect(actionErrorMessage(new Error(''), FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      ['空数组', [] as unknown],
      ['无原型对象', Object.create(null) as unknown],
      ['Symbol', Symbol('x') as unknown],
    ])('异形入参（%s）→ 回退 fallback，且不抛', (_label, input) => {
      expect(() => actionErrorMessage(input, FALLBACK)).not.toThrow()
      expect(actionErrorMessage(input, FALLBACK)).toBe(FALLBACK)
    })

    it('digest 是会抛异常的 getter → 吞掉并回退，绝不把原始错误顶掉', () => {
      const err = new Error('余额不足')
      Object.defineProperty(err, 'digest', {
        get() {
          throw new TypeError('digest trap')
        },
      })
      expect(() => actionErrorMessage(err, FALLBACK)).not.toThrow()
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('原型链上的键不算映射命中', () => {
      // OPAQUE_TOKEN_MESSAGES 用 Object.hasOwn 判定，constructor / toString 这类不会误命中
      expect(actionErrorMessage({ digest: 'CONSTRUCTOR' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: 'TOSTRING' }, FALLBACK)).toBe(FALLBACK)
    })

    it('fallback 本身为空 / 全空白 → 给通用兜底文案，不弹空白 toast', () => {
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), '')).toBe('操作失败')
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), '   ')).toBe('操作失败')
    })
  })

  describe('9 项错误前缀白名单整链路透出（服务端 throw → 生产脱敏 → 客户端展示）', () => {
    // 前缀清单从 api-error.ts 直接取，不在此处硬编码副本：白名单增删会自动带进本用例。
    it.each([...ERROR_PREFIXES])('%s：生产构建下文案仍原样到达用户', async (prefix) => {
      const copy = `${prefix} 的业务文案`
      const thrown = await throwThroughWithPermission(() => {
        throw new ApiError(prefix, copy)
      })
      expect(actionErrorMessage(asProductionError(thrown), FALLBACK)).toBe(copy)
      expect(actionErrorMessage(asDevError(thrown), FALLBACK)).toBe(copy)
      // 上面两条走的都是 digest 格（dev 下 Next 同样会挂 digest）。这条才真的走 message 格：
      // 模拟「digest 通道没了」（比如错误没经 rethrowWithDigest）时仍能从 message 取到文案。
      expect(actionErrorMessage(new Error(`${prefix}: ${copy}`), FALLBACK)).toBe(copy)
    })

    it('非白名单系统错误：prod 与 dev 都回退 fallback，技术原文只留给控制台', async () => {
      // 取舍：早先让 dev 透出英文原文「便于排查」，评审指出这条在 prod 同样生效
      //（客户端自抛的异常不经 Next 脱敏），等于把 SQL 约束名之类的细节端给用户。
      // 现在统一按「无中文即非用户文案」回退 —— 开发排查走浏览器控制台与 Next 错误浮层，
      // 那两处拿到的是完整原文，信息并没有丢。
      const thrown = await throwThroughWithPermission(() => {
        throw new Error('invalid reference to FROM-clause entry for table "parent"')
      })
      expect(actionErrorMessage(asProductionError(thrown), FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage(asDevError(thrown), FALLBACK)).toBe(FALLBACK)
    })

    it('#133 场景 A：期初门禁的 ApiError 在生产构建下原样到达用户', async () => {
      const gate = '库存期初尚未导入并核验完成，暂不可办理库存业务'
      const thrown = await throwThroughWithPermission(() => {
        throw new ApiError('INVALID_STATE', gate)
      })
      expect(actionErrorMessage(asProductionError(thrown), '创建单据失败')).toBe(gate)
    })
  })
})

describe('Next digest 形态漂移守护（#133）', () => {
  const require_ = createRequire(import.meta.url)
  const nextRoot = require_.resolve('next/package.json').replace(/package\.json$/, '')

  it('create-error-handler 仍以 stringHash(...).toString() 生成 digest，且尊重已有 digest', () => {
    const src = readFileSync(`${nextRoot}dist/server/app-render/create-error-handler.js`, 'utf8')
    // 「已有 digest 不覆盖」是业务文案能穿透脱敏的前提，与 rethrowWithDigest 配对
    expect(src).toContain('if (!err.digest)')
    expect(src).toMatch(/err\.digest = \(0, _stringhash\.default\)\([\s\S]{0,120}?\)\.toString\(\)/)
    // 送到客户端的是被 createDigestWithErrorCode 包过一层的值，不是 err.digest 本身
    expect(src).toContain('createDigestWithErrorCode')
  })

  it('Next 的错误码后缀用真实实现造一遍，仍被判为不可读', () => {
    const { createDigestWithErrorCode } = require_(`${nextRoot}dist/lib/error-telemetry-utils`) as {
      createDigestWithErrorCode: (thrownValue: unknown, originalDigest: string) => string
    }
    const base = stringHash('boom').toString()
    const thrown = Object.assign(new Error('boom'), { __NEXT_ERROR_CODE: 'E263' })
    const digest = createDigestWithErrorCode(thrown, base)
    expect(digest, 'Next 的错误码拼接形态变了').toBe(`${base}@E263`)
    const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
    expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)

    // 没打错误码的错误不加后缀 —— 我们自己补的业务 digest 走的正是这一支
    expect(createDigestWithErrorCode(new Error('boom'), 'CONFLICT: 单据已被他人处理')).toBe(
      'CONFLICT: 单据已被他人处理',
    )
  })

  it('全仓的裸 token digest 生产者都在中文说法表里（真扫描，不是列清单）', () => {
    // 之前这条只是把 ERROR_PREFIXES 过滤后跟一个硬编码数组比 —— 新增一个
    // `class PhoneRequiredError { readonly digest = 'PHONE_REQUIRED' }` 它照样全绿。
    // 现在真去扫源码里的 digest 字面量。
    const srcRoot = resolve(process.cwd(), 'src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full)
      }
    }
    walk(srcRoot)
    expect(files.length).toBeGreaterThan(100)

    const bareTokens = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bdigest\s*[=:]\s*['"`]([^'"`]+)['"`]/g)) {
        if (/^[A-Z][A-Z0-9_]*$/.test(m[1])) bareTokens.add(m[1])
      }
    }
    // 今天只有 permissions.ts 的 PermissionError 这一个生产者
    expect([...bareTokens].sort()).toEqual(['PERMISSION_DENIED'])

    const src = readFileSync(resolve(process.cwd(), 'src/lib/action-error.ts'), 'utf8')
    const mapped = [
      ...(src.match(/const OPAQUE_TOKEN_MESSAGES[\s\S]*?\}\)/)?.[0] ?? '').matchAll(
        /^\s{2}([A-Z][A-Z0-9_]*):/gm,
      ),
    ].map((m) => m[1])
    for (const token of bareTokens) {
      expect(mapped, `裸 token digest ${token} 没有对应的中文说法，用户会拿到通用兜底文案`).toContain(
        token,
      )
    }
  })

  it('仓内真实二级子标签都 ≥5 字符（长度启发式的前提，破了就要改判定）', () => {
    // LEVEL2_SUBTAG_RE 用「标签 ≥5 字符」把日志子标签与 ID:/SKU:/URL: 这类展示标签分开。
    // 这是启发式不是协议 —— 语法上二者没法区分。所以把前提本身钉住：一旦有人写出
    // `CONFLICT: LOCK: …` 这种短子标签，这条立刻红，逼着重新决定判定方式。
    const actionsRoot = resolve(process.cwd(), 'src')
    const found = new Map<string, string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        // 跳过本模块自身：它的注释里举了 `NOT_FOUND: SKU: …` 这种反例，那是文档不是抛点
        else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          !full.endsWith('/lib/action-error.ts')
        ) {
          const text = readFileSync(full, 'utf8')
          const prefixes = (ERROR_PREFIXES as readonly string[]).join('|')
          const re = new RegExp(`(?:${prefixes})['"\`]?\\s*[,:]\\s*['"\`]?\\s*([A-Z][A-Z0-9_]*):`, 'g')
          for (const m of text.matchAll(re)) found.set(m[1], full)
        }
      }
    }
    walk(actionsRoot)
    expect(found.size).toBeGreaterThan(5)
    const tooShort = [...found].filter(([tag]) => tag.length < 5)
    expect(
      tooShort,
      `这些二级子标签短于 5 字符，会被 LEVEL2_SUBTAG_RE 漏剥：${JSON.stringify(tooShort)}`,
    ).toEqual([])
  })

  it('Next 的内部错误码形态仍是 E+数字（@E 正则的前提）', () => {
    const dist = `${nextRoot}dist`
    const samples: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || samples.length > 40) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (samples.length > 40) return
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (entry.name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8')
          for (const m of text.matchAll(/__NEXT_ERROR_CODE[\s\S]{0,80}?value:\s*"([^"]+)"/g)) {
            samples.push(m[1])
          }
        }
      }
    }
    walk(`${dist}/server`, 0)
    expect(samples.length, '没在 next/dist 里找到 __NEXT_ERROR_CODE 样本').toBeGreaterThan(0)
    for (const code of samples) {
      expect(code, `Next 错误码形态变了：${code}，NEXT_AUTO_DIGEST_RE 的 @E\\d+ 需要跟着改`).toMatch(
        /^E\d+$/,
      )
    }
  })

  it('9 项白名单里每个前缀，要么有裸 token 中文说法，要么确认不会以裸 token 出现', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/action-error.ts'), 'utf8')
    const mapped = [
      ...(src.match(/const OPAQUE_TOKEN_MESSAGES[\s\S]*?\}\)/)?.[0] ?? '').matchAll(
        /^\s{2}([A-Z][A-Z0-9_]*):/gm,
      ),
    ].map((m) => m[1])
    expect(mapped).toEqual(['PERMISSION_DENIED', 'UNAUTHORIZED'])

    // 全仓只有 permissions.ts 的 PermissionError 会写裸 token digest（= 'PERMISSION_DENIED'）；
    // with-permission.ts 的 rethrowWithDigest 写的是带前缀的完整 message。
    // 将来若有人照着加 `PhoneRequiredError { digest = 'PHONE_REQUIRED' }`，用户会静默拿到
    // 通用兜底文案而不知道要去绑手机号 —— 那时下面这份「确认不会裸出现」的名单就该更新。
    const knownNotBare = ERROR_PREFIXES.filter((p) => !mapped.includes(p))
    expect(knownNotBare).toEqual([
      'PHONE_REQUIRED',
      'INVALID_PARAMS',
      'NOT_FOUND',
      'INSUFFICIENT_BALANCE',
      'CONFLICT',
      'INVALID_STATE',
      'CLIENT_NOT_REGISTERED',
    ])
    const permissionsSrc = readFileSync(resolve(process.cwd(), 'src/lib/permissions.ts'), 'utf8')
    expect(permissionsSrc).toContain("readonly digest = 'PERMISSION_DENIED'")
  })

  it('error.tsx 判 401/403 用的裸 token 与本模块的说法表同源', () => {
    const errorPageSrc = readFileSync(resolve(process.cwd(), 'src/app/(main)/error.tsx'), 'utf8')
    // 它靠 `digest === "PERMISSION_DENIED"` / `=== "UNAUTHORIZED"` 渲染 403/401 页；
    // 本模块把同样这两个裸 token 翻成中文。两处漂移会让同一个 digest 在页面级与 toast 级判定不一致。
    expect(errorPageSrc).toContain('error.digest === "PERMISSION_DENIED"')
    expect(errorPageSrc).toContain('error.digest === "UNAUTHORIZED"')
  })

  it('本地 stringHash 副本与 Next 编译内置实现逐样本一致', () => {
    const nextStringHash = require_(`${nextRoot}dist/compiled/string-hash`) as (s: string) => number
    const samples = [
      '',
      'a',
      'invalid reference to FROM-clause entry for table "parent"',
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
      'Error: boom\n    at foo (/app/.next/server/chunks/1.js:1:1)',
      'x'.repeat(5000),
    ]
    for (const s of samples) {
      expect(nextStringHash(s)).toBe(stringHash(s))
    }
  })

  it('自动 digest 恒为 1~10 位纯数字，且一律被判为不可读', () => {
    const samples = [
      '',
      'boom',
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
      'x'.repeat(10000),
      '\u0000\uFFFF',
    ]
    for (const s of samples) {
      const digest = stringHash(s).toString()
      expect(digest).toMatch(/^\d{1,10}$/)
      expect(Number(digest)).toBeLessThanOrEqual(4294967295)
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    }
  })
})
