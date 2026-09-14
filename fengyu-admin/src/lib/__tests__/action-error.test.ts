import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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

    it('无 digest 但 message 可读（dev 构建）：原样展示', () => {
      expect(actionErrorMessage(new Error('该顾客未绑定门店'), FALLBACK)).toBe('该顾客未绑定门店')
    })

    it('不误剥驼峰型前缀：TypeError 这类保持原样（dev 调试可读）', () => {
      expect(actionErrorMessage(new Error('TypeError: x is not a function'), FALLBACK)).toBe(
        'TypeError: x is not a function',
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

    it('11 位以上的数字串不是 Next digest（32 位无符号上限 4294967295），按文案处理', () => {
      expect(actionErrorMessage({ digest: '12345678901' }, FALLBACK)).toBe('12345678901')
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

  describe('脱敏 / 网络层文案回退', () => {
    it('脱敏话术且无 digest → 回退 fallback', () => {
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'An unexpected response was received from the server.',
      'read ECONNRESET',
      'ESOCKET',
      'ETIMEDOUT',
    ])('网络/框架层文案 %s → 回退 fallback（大小写不敏感）', (message) => {
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
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
    })

    it('非白名单系统错误：生产下回退 fallback，开发下保留原文便于排查', async () => {
      const thrown = await throwThroughWithPermission(() => {
        throw new Error('invalid reference to FROM-clause entry for table "parent"')
      })
      expect(actionErrorMessage(asProductionError(thrown), FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage(asDevError(thrown), FALLBACK)).toBe(
        'invalid reference to FROM-clause entry for table "parent"',
      )
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
      ' ￿',
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
