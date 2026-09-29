/**
 * #308：自定义时间区间的服务端复检——4 个看板 action + 看板导出。
 *
 * action 直接收客户端传来的 timeRange 对象、不经过 parseTimeRange；导出参数在 worker 端解析。
 * 两条路都必须对非法日期报 INVALID_PARAMS（拍板：不回落），且报错前不发出任何 SQL（用总部账号：
 * validateScope 不查库；市场账号会先查一次可见市场，那条 SQL 不带日期）。
 * 合法区间（含年份上下界 1900 / 2100）照常取数，送进 SQL 的参数里不得出现 NaN 或倒挂区间。
 *
 * 用 pg-proxy 真 drizzle 截获 SQL，库返回空行（同 multi-store-scope.test）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

const { mockGetSession, queries } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params })
    return { rows: [] }
  })
  return { db: Object.assign(db, { transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }) }
})

import { getSalesBoard } from '../sales'
import { getCustomerBoard } from '../customer'
import { getEfficiencyBoard } from '../efficiency'
import { getProductBoard } from '../product'
import { createExportContent } from '@/export-worker/registry'
import type { BoardParams } from '@/lib/data-center/types'
import { toCustomRange } from '@/lib/data-center/params'

const HQ: AuthSession = {
  employeeId: 'FY-ADMIN', name: '管理员', phone: '1',
  roles: [{ role: 'manager', scopeId: 'HQ', scopeType: '总部', actions: ['data_center:dashboard'], scopeStoreIds: [], scopeOrgNodeIds: [] }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [], scopeOrgNodeIds: [] },
} as unknown as AuthSession

const BOARDS: Array<[name: string, fn: (p: BoardParams) => Promise<unknown>, exportView: string]> = [
  ['getSalesBoard', getSalesBoard, 'sales-market'],
  ['getCustomerBoard', getCustomerBoard, 'customer-market-reg'],
  ['getEfficiencyBoard', getEfficiencyBoard, 'efficiency-market'],
  ['getProductBoard', getProductBoard, 'product-market'],
]

/** A 类：位数对、日历不对；B 类：年份越界 / 不足 4 位；C 类：倒挂 */
const INVALID_RANGES: Array<[label: string, start: string, end: string]> = [
  ['A 2 月 30 日', '2026-02-30', '2026-03-01'],
  ['A 13 月', '2026-13-01', '2026-12-31'],
  ['A 0 月', '2026-00-01', '2026-01-31'],
  ['A 32 日', '2026-01-01', '2026-01-32'],
  ['B 0001 年', '0001-01-01', '0001-01-02'],
  ['B 0000 年', '0000-01-01', '2026-01-01'],
  ['B 1899 年', '1899-12-31', '1900-01-05'],
  ['B 2101 年', '2100-12-30', '2101-01-01'],
  ['C 倒挂', '2026-02-01', '2026-01-01'],
]

const VALID_RANGES: Array<[label: string, start: string, end: string]> = [
  ['普通月', '2026-08-01', '2026-08-31'],
  ['闰日', '2028-02-29', '2028-03-01'],
  ['年份下界', '1900-01-01', '1900-01-31'],
  ['年份上界', '2100-12-01', '2100-12-31'],
  ['单日', '2026-09-01', '2026-09-01'],
]

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const DATE_LIKE = /^-?\d+-\d+-\d+$/

/** 送进 SQL 的参数：不得出现 NaN；成对出现的日期参数（YYYY-MM-DD）必须都是 4 位年份的合法串 */
function expectSaneParams() {
  expect(queries.length, '合法区间应当发出取数').toBeGreaterThan(0)
  for (const q of queries) {
    for (const p of q.params) {
      const s = String(p)
      expect(s).not.toMatch(/NaN|Invalid Date/)
      if (DATE_LIKE.test(s)) expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T04:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  mockGetSession.mockResolvedValue(HQ)
  queries.length = 0
})

describe('#308 看板 action：非法 timeRange → INVALID_PARAMS，且未发出任何 SQL', () => {
  const cases = BOARDS.flatMap(([name, fn]) =>
    INVALID_RANGES.map(([label, start, end]) => [`${name} · ${label}`, fn, start, end] as const),
  )
  it.each(cases)('%s', async (_, fn, start, end) => {
    const err = await errorOf(() =>
      fn({ scope: { type: 'all' }, timeRange: { preset: 'custom', start, end } as never, withComparison: true }),
    )
    expect(err).toMatch(/^INVALID_PARAMS: /)
    expect(queries).toEqual([])
  })

  it.each(BOARDS.map(([name, fn]) => [name, fn] as const))('%s · 预设不在白名单 / 缺起止 / 缺 timeRange', async (_, fn) => {
    const bad = [
      { preset: 'decade' },
      { preset: 'custom' },
      { preset: 'custom', start: '2026-01-01' },
      { preset: 'custom', start: 20260101, end: 20260131 },
      undefined,
      null,
    ]
    for (const timeRange of bad) {
      const err = await errorOf(() =>
        fn({ scope: { type: 'all' }, timeRange: timeRange as never, withComparison: true }),
      )
      expect(err, JSON.stringify(timeRange)).toMatch(/^INVALID_PARAMS: /)
    }
    expect(queries).toEqual([])
  })
})

describe('#308 看板 action：合法区间照常取数，SQL 参数无 NaN / 非 4 位年份', () => {
  const cases = BOARDS.flatMap(([name, fn]) =>
    VALID_RANGES.map(([label, start, end]) => [`${name} · ${label}`, fn, start, end] as const),
  )
  it.each(cases)('%s', async (_, fn, start, end) => {
    const err = await errorOf(() =>
      fn({ scope: { type: 'all' }, timeRange: toCustomRange(start, end)!, withComparison: true }),
    )
    expect(err).toBeNull()
    expectSaneParams()
    // 本期区间原样送进 SQL（不被静默改写成本月）
    expect(queries.some((q) => q.params.includes(start) && q.params.includes(end))).toBe(true)
  })
})

describe('#308 看板导出：非法自定义区间 → INVALID_PARAMS（不回落本月），且未发出任何 SQL', () => {
  const cases = BOARDS.flatMap(([name, , view]) =>
    INVALID_RANGES.map(([label, start, end]) => [`${name} 导出 · ${label}`, view, start, end] as const),
  )
  it.each(cases)('%s', async (_, view, start, end) => {
    const err = await errorOf(() =>
      createExportContent('data-center', { view, params: { preset: 'custom', start, end } } as never),
    )
    expect(err).toMatch(/^INVALID_PARAMS: /)
    expect(queries).toEqual([])
  })

  it.each(BOARDS.map(([name, , view]) => [name, view] as const))('%s 导出 · 合法区间照常取数', async (_, view) => {
    const err = await errorOf(() =>
      createExportContent('data-center', {
        view,
        params: { preset: 'custom', start: '1900-01-01', end: '1900-01-31' },
      } as never),
    )
    expect(err).toBeNull()
    expectSaneParams()
    // 导出的是请求的区间，不是被静默改写的本月
    expect(queries.some((q) => q.params.includes('1900-01-01') && q.params.includes('1900-01-31'))).toBe(true)
  })
})
