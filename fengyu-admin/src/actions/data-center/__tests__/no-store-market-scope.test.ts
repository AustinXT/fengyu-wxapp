/**
 * #399：只授权到无门店市场（hr@品项公司，scopeStoreIds 为空）的账号，以「市场」范围调用数据中心
 * 全部取数 action（4 板块 + 5 张经营明细报表页 + 导出）都能正常返回——不被 validateScope 拒、不因空门店集合抛错；
 * 人效板按锚定市场收录无门店员工（orgAnchorScopeSql 的 market 分支）。
 *
 * 用 pg-proxy 真 drizzle 截获 SQL，库返回空行（本文件只验「能走通 + 走对分支」，数值口径由各板块单测负责）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

const outcome = new Map<string, { error: string | null; sqls: Array<{ sql: string; params: unknown[] }> }>()

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T04:00:00Z'))
  mockGetSession.mockResolvedValue(HR_PX)
  for (const [file, name, args] of CALLS) {
    const mod = (await import(`../${file}`)) as Record<string, (...a: unknown[]) => Promise<unknown>>
    captured.length = 0
    let error: string | null = null
    try {
      await mod[name](...args)
    } catch (e) {
      error = (e as Error).message
    }
    outcome.set(`${file}:${name}`, { error, sqls: [...captured] })
  }
}, 60_000)

afterAll(() => {
  vi.useRealTimers()
})

describe('#399 无门店市场账号 · 市场范围取数', () => {
  it.each(CALLS.map(([file, name]) => `${file}:${name}`))('%s 正常返回（不被拒、不抛错）且确实取数', (key) => {
    const r = outcome.get(key)!
    expect(r.error).toBeNull()
    expect(r.sqls.length).toBeGreaterThan(0)
  })

  it('人效板按锚定市场收录无门店员工（anchor_market_id = 品项公司）', () => {
    const { sqls } = outcome.get('efficiency:getEfficiencyBoard')!
    const anchored = sqls.filter((q) => /anchor_market_id = \$\d+/.test(q.sql) && q.params.includes('PX'))
    expect(anchored.length).toBeGreaterThan(0)
  })

  it('门店维度统计对空授权门店集合恒为 FALSE（不会越权看到别的门店）', () => {
    // scopeFilterSql：非 admin 且 scopeStoreIds 为空 → FALSE；这里抽查销售板每条带门店列的 SQL 都含 FALSE 条件
    const { sqls } = outcome.get('sales:getSalesBoard')!
    const storeScoped = sqls.filter((q) => /store_id/.test(q.sql))
    expect(storeScoped.length).toBeGreaterThan(0)
    for (const q of storeScoped) expect(q.sql).toMatch(/\bfalse\b/i)
  })
})
