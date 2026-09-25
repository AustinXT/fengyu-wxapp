/**
 * #399：只授权到无门店市场（hr@品项公司，scopeStoreIds 为空）的账号，以「市场」范围调用数据中心
 * 全部取数 action（4 板块 + 5 张经营明细报表页 + 导出）都能正常返回——不被 validateScope 拒、不因空门店集合抛错；
 * 人效板按锚定市场收录无门店员工（orgAnchorScopeSql 的 market 分支）。
 *
 * 用 pg-proxy 真 drizzle 截获 SQL，库返回空行（本文件只验「能走通 + 走对分支」，数值口径由各板块单测负责）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { AuthSession } from '@/lib/types'

const { captured, mockGetSession } = vi.hoisted(() => ({ captured: [] as Array<{ sql: string; params: unknown[] }>, mockGetSession: vi.fn() }))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandVisibleMarketIds: vi.fn(async () => ['PX']),
  expandMarketVisibility: vi.fn(async () => ({ visible: ['PX'], granted: ['PX'] })),
}))
// 截获每次 scopeFilterSql 的返回值：零授权门店时每一次都必须是字面 FALSE（门店维度无从越权）
const { scopeFilterResults } = vi.hoisted(() => ({ scopeFilterResults: [] as unknown[] }))
vi.mock('@/lib/data-center/scope-sql', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/data-center/scope-sql')>()
  return {
    ...mod,
    scopeFilterSql: (...args: Parameters<typeof mod.scopeFilterSql>) => {
      const fragment = mod.scopeFilterSql(...args)
      scopeFilterResults.push(fragment)
      return fragment
    },
  }
})
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params })
    return { rows: [] }
  })
  return { db: Object.assign(db, { transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }) }
})

const ACTIONS = ['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission']
const HR_PX: AuthSession = {
  employeeId: 'FY-260522002', name: '品项 HR', phone: '1',
  roles: [{ role: 'hr', scopeId: 'PX', scopeType: '市场', actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['PX'] }],
  permissions: { actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['PX'] },
} as AuthSession

const MARKET = { type: 'market' as const, id: 'PX' }
const board = { scope: MARKET, timeRange: { preset: 'month' }, withComparison: true }
const raw = { scope: 'market', scopeId: 'PX', period: 'month' }
const CALLS: Array<[file: string, name: string, args: unknown[]]> = [
  ['sales', 'getSalesBoard', [board]],
  ['customer', 'getCustomerBoard', [board]],
  ['efficiency', 'getEfficiencyBoard', [board]],
  ['product', 'getProductBoard', [board]],
  ['daily-overview', 'getDailyOverview', [raw]],
  ['operating-master', 'getOperatingMaster', [{ scope: MARKET, month: '2026-09' }]],
  ['commission', 'getCommissionDaily', [raw]],
  ['commission', 'getCommissionDetail', [raw]],
  ['commission', 'exportCommissionDetail', [raw]],
  ['customer-frequency', 'getCustomerFrequencyReport', [raw]],
  ['customer-frequency', 'exportCustomerFrequencyReport', [raw]],
  ['remaining-cards', 'getRemainingCardsReport', [raw]],
  ['remaining-cards', 'exportRemainingCardsReport', [raw]],
]

const outcome = new Map<string, { error: string | null; sqls: Array<{ sql: string; params: unknown[] }>; filters: unknown[] }>()

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T04:00:00Z'))
  mockGetSession.mockResolvedValue(HR_PX)
  for (const [file, name, args] of CALLS) {
    const mod = (await import(`../${file}`)) as Record<string, (...a: unknown[]) => Promise<unknown>>
    captured.length = 0
    scopeFilterResults.length = 0
    let error: string | null = null
    try {
      await mod[name](...args)
    } catch (e) {
      error = (e as Error).message
    }
    outcome.set(`${file}:${name}`, { error, sqls: [...captured], filters: [...scopeFilterResults] })
  }
}, 60_000)

afterAll(() => {
  vi.useRealTimers()
})

describe('#399 无门店市场账号 · 市场范围取数', () => {
  it.each(CALLS.map(([file, name]) => `${file}:${name}`))('%s 正常返回（不被拒、不抛错）且确实跑了统计 SQL', (key) => {
    const r = outcome.get(key)!
    expect(r.error).toBeNull()
    // 展示名 / 配置 / 字典查询不算：至少一条带门店或锚定维度的统计 SQL（防 action 提前 return 恒绿）
    expect(r.sqls.some((q) => /store_id|anchor_market_id/.test(q.sql))).toBe(true)
  })

  it('人效板按锚定市场收录无门店员工（anchor_market_id = 品项公司）', () => {
    const { sqls } = outcome.get('efficiency:getEfficiencyBoard')!
    const anchored = sqls.filter((q) => /anchor_market_id = \$\d+/.test(q.sql) && q.params.includes('PX'))
    expect(anchored.length).toBeGreaterThan(0)
  })

  // 逐 action 记录（闸门 2 codex round-1 P2：按全局集合聚合时，删掉某一个 action 的过滤仍会因别的 action 凑够数而全绿）
  it.each(CALLS.map(([file, name]) => `${file}:${name}`))('%s：门店维度过滤（scopeFilterSql）至少调用一次，且每一次都是字面 FALSE', (key) => {
    const { filters } = outcome.get(key)!
    expect(filters.length, '该 action 没有经过 scopeFilterSql').toBeGreaterThan(0)
    const dialect = new PgDialect()
    const rendered = new Set(filters.map((f) => dialect.sqlToQuery(f as never).sql.trim().toUpperCase()))
    expect([...rendered]).toEqual(['FALSE'])
  })
})
