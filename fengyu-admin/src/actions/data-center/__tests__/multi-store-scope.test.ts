/**
 * #376：多店范围（scope=stores）调用数据中心全部取数 action（4 板块 + 5 张经营明细报表页 + 导出）：
 *   - 授权子集正常取数，且每一次门店维度过滤都按所选子集收窄（不静默退化成汇总范围）
 *   - 越权门店整单 PERMISSION_DENIED
 *   - 无门店员工（orgAnchorScopeSql）按「锚定市场下至少有一家所选门店」判定——提成日报（人均分母）与人效板各一条
 *   - 「1 市场 + 1 门店」混合账号跨两市场选店
 *
 * 用 pg-proxy 真 drizzle 截获 SQL，库返回空行（数值一致性由 dev 库对账脚本负责，见 PR 说明）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope } from '@/lib/data-center/types'

const { mockGetSession, scopeFilterCalls, anchorCalls } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  scopeFilterCalls: [] as Array<{ scope: unknown; fragment: unknown }>,
  anchorCalls: [] as Array<{ scope: unknown; fragment: unknown }>,
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandVisibleMarketIds: vi.fn(async () => ['MA', 'MB']),
  expandMarketVisibility: vi.fn(async () => ({ visible: ['MA', 'MB'], granted: ['MA'] })),
}))
vi.mock('@/lib/data-center/scope-sql', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/data-center/scope-sql')>()
  return {
    ...mod,
    scopeFilterSql: (...args: Parameters<typeof mod.scopeFilterSql>) => {
      const fragment = mod.scopeFilterSql(...args)
      scopeFilterCalls.push({ scope: args[1], fragment })
      return fragment
    },
    orgAnchorScopeSql: (...args: Parameters<typeof mod.orgAnchorScopeSql>) => {
      const fragment = mod.orgAnchorScopeSql(...args)
      anchorCalls.push({ scope: args[1], fragment })
      return fragment
    },
  }
})
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const db = drizzle(async () => ({ rows: [] }))
  return { db: Object.assign(db, { transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }) }
})

const ACTIONS = ['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission']

/** 市场 MA（A1/A2）+ 门店 B1（祖先市场 MB）：「1 市场 + 1 门店」混合账号 */
const MIXED: AuthSession = {
  employeeId: 'FY-MIXED', name: '混合账号', phone: '1',
  roles: [
    { role: 'manager', scopeId: 'MA', scopeType: '市场', actions: ACTIONS, scopeStoreIds: ['A1', 'A2'], scopeOrgNodeIds: ['MA', 'node-A1', 'node-A2'] },
    { role: 'manager', scopeId: 'node-B1', scopeType: '门店', actions: ACTIONS, scopeStoreIds: ['B1'], scopeOrgNodeIds: ['node-B1'] },
  ],
  permissions: { actions: ACTIONS, scopeStoreIds: ['A1', 'A2', 'B1'], scopeOrgNodeIds: ['MA', 'node-A1', 'node-A2', 'node-B1'] },
} as AuthSession

function calls(scope: DataCenterScope): Array<[file: string, name: string, args: unknown[]]> {
  const board = { scope, timeRange: { preset: 'month' }, withComparison: true }
  const raw = scope.type === 'stores' ? { scope: 'stores', scopeId: scope.ids.join(','), period: 'month' } : {}
  return [
    ['sales', 'getSalesBoard', [board]],
    ['customer', 'getCustomerBoard', [board]],
    ['efficiency', 'getEfficiencyBoard', [board]],
    ['product', 'getProductBoard', [board]],
    ['daily-overview', 'getDailyOverview', [raw]],
    ['operating-master', 'getOperatingMaster', [{ scope, month: '2026-08' }]],
    ['commission', 'getCommissionDaily', [{ ...raw, month: '2026-08' }]],
    ['commission', 'getCommissionDetail', [{ ...raw, month: '2026-08' }]],
    ['commission', 'exportCommissionDetail', [{ ...raw, month: '2026-08' }]],
    ['customer-frequency', 'getCustomerFrequencyReport', [raw]],
    ['customer-frequency', 'exportCustomerFrequencyReport', [raw]],
    ['remaining-cards', 'getRemainingCardsReport', [raw]],
    ['remaining-cards', 'exportRemainingCardsReport', [raw]],
  ]
}

type Outcome = { error: string | null; filters: typeof scopeFilterCalls; anchors: typeof anchorCalls }

async function runAll(session: AuthSession, scope: DataCenterScope): Promise<Map<string, Outcome>> {
  mockGetSession.mockResolvedValue(session)
  const out = new Map<string, Outcome>()
  for (const [file, name, args] of calls(scope)) {
    const mod = (await import(`../${file}`)) as Record<string, (...a: unknown[]) => Promise<unknown>>
    scopeFilterCalls.length = 0
    anchorCalls.length = 0
    let error: string | null = null
    try {
      await mod[name](...args)
    } catch (e) {
      error = (e as Error).message
    }
    out.set(`${file}:${name}`, { error, filters: [...scopeFilterCalls], anchors: [...anchorCalls] })
  }
  return out
}

const dialect = new PgDialect()
const renderSql = (f: unknown) => dialect.sqlToQuery(f as never)
const SELECTED: DataCenterScope = { type: 'stores', ids: ['A1', 'B1'] }
const KEYS = calls(SELECTED).map(([file, name]) => `${file}:${name}`)

let allowed: Map<string, Outcome>
let denied: Map<string, Outcome>

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T04:00:00Z'))
  allowed = await runAll(MIXED, SELECTED)
  denied = await runAll(MIXED, { type: 'stores', ids: ['A1', 'Z9'] })
}, 60_000)

afterAll(() => {
  vi.useRealTimers()
})

describe('#376 多店范围 · 混合账号跨两市场选店（A1 + 祖先市场 B 的 B1）', () => {
  it.each(KEYS)('%s 正常返回', (key) => {
    expect(allowed.get(key)!.error).toBeNull()
  })

  // 逐 action：每一次门店维度过滤都以「所选 IN」收尾，参数末两位恰为所选门店（防某个 action 把 stores 当成汇总）
  it.each(KEYS)('%s：每次 scopeFilterSql 都按所选子集收窄', (key) => {
    const { filters } = allowed.get(key)!
    expect(filters.length, '该 action 没有经过 scopeFilterSql').toBeGreaterThan(0)
    for (const f of filters) {
      const q = renderSql(f.fragment)
      expect(q.sql.replace(/\s+/g, ' ').trim()).toMatch(/ IN \(\$\d+, \$\d+\)$/)
      expect(q.params.slice(-2)).toEqual(['A1', 'B1'])
    }
  })
})

describe('#376 无门店员工可见性（orgAnchorScopeSql）', () => {
  function expectAnchorOnSelected(key: string) {
    const { anchors } = allowed.get(key)!
    expect(anchors.length, `${key} 没有经过 orgAnchorScopeSql`).toBeGreaterThan(0)
    for (const a of anchors) {
      const q = renderSql(a.fragment)
      // 锚定市场下有所选在营门店：EXISTS + 在营 + 按锚定市场 + 门店集合 = 所选（∩ 授权）
      expect(q.sql).toContain('EXISTS (')
      expect(q.sql).toContain('vn.is_active = TRUE')
      expect(q.sql).toContain('vn.parent_id = ')
      expect(q.params).toEqual(['A1', 'B1'])
    }
  }

  it('提成日报：人均提成分母（产能技师数）按所选门店判无门店员工', () => {
    expectAnchorOnSelected('commission:getCommissionDaily')
  })

  it('人效板：产能员工池 / 技师分母按所选门店判无门店员工', () => {
    expectAnchorOnSelected('efficiency:getEfficiencyBoard')
  })
})

describe('#376 越权门店', () => {
  it.each(KEYS)('%s：所选含授权外门店 → PERMISSION_DENIED，且未发出任何取数', (key) => {
    const r = denied.get(key)!
    expect(r.error).toMatch(/PERMISSION_DENIED/)
    expect(r.filters).toEqual([])
  })
})
