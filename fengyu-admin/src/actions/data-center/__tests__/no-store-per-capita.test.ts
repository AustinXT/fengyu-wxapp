/**
 * #423：无门店范围下人均类 KPI 显示「--」（口径拍板方案 A）。
 *
 * 症状：品项公司这类无门店市场范围下，人均分子走门店口径恒 0，分母却经 orgAnchorScopeSql 收进直挂技师，
 * `0 / N` 显示 0.00，与同页员工榜（员工分配额，品项老师有真实数字）对不上。
 * 修法：范围内没有在营门店（门店骨架为空）→ 人效板 5 项技师人均、按市场明细无门店市场行的技师人均、
 * 提成日报人均提成一律 null；只要范围内有门店就照常计算。
 *
 * 场景：总部选品项公司市场 / hr@品项公司 默认范围 / 多店范围。
 * 用 pg-proxy 真 drizzle 截获 SQL（同 no-store-market-scope.test.ts），按 SQL 特征喂夹具；
 * `has_store` 由夹具骨架是否为空推出，另对判定 SQL 本身断言走对了 scope 分支，避免只测夹具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'

type Row = Record<string, unknown>
type Fixture = {
  skeleton: Row[]
  techCount: number
  techByStore: Row[]
  techDirect: Row[]
  revenueTotal: number
  staffRevenue: Row[]
  commission: Row
}

const { captured, mockGetSession, fixture } = vi.hoisted(() => ({
  captured: [] as Array<{ sql: string; params: unknown[] }>,
  mockGetSession: vi.fn(),
  fixture: { current: null as unknown as Fixture },
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandVisibleMarketIds: vi.fn(async () => ['PX', 'M1']),
  expandMarketVisibility: vi.fn(async () => ({ visible: ['PX', 'M1'], granted: ['PX', 'M1'] })),
}))
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params })
    const f = fixture.current
    // 顺序有讲究：has_store 包着骨架 SQL，必须先于骨架匹配
    if (/AS has_store/.test(sql)) return { rows: [{ has_store: f.skeleton.length > 0 }] }
    if (/^\s*SELECT s\.store_id, s\.store_name, o_mkt\.id AS market_id/.test(sql)) return { rows: f.skeleton }
    if (/SELECT COUNT\(\*\)::int AS v FROM technician_scoped/.test(sql)) return { rows: [{ v: f.techCount }] }
    if (/FROM technician_scoped ts\s+WHERE store_id IS NOT NULL/.test(sql)) return { rows: f.techByStore }
    if (/WHERE store_id IS NULL AND anchor_market_id IS NOT NULL/.test(sql)) return { rows: f.techDirect }
    if (/SELECT COALESCE\(SUM\(spe\.amount::numeric\), 0\) AS v\s+FROM sale_order_performance_events spe/.test(sql)) {
      return { rows: [{ v: String(f.revenueTotal) }] }
    }
    if (/FROM producer_employees pe\s+LEFT JOIN revenue_by_emp r/.test(sql)) return { rows: f.staffRevenue }
    if (/earning_employees/.test(sql)) return { rows: [f.commission] }
    return { rows: [] }
  })
  return { db: Object.assign(db, { transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }) }
})

import { getEfficiencyBoard } from '../efficiency'
import { getCommissionDaily } from '../commission'
import { defaultScopeParams } from '@/lib/data-center/entry'
import { scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { PgDialect } from 'drizzle-orm/pg-core'

const ACTIONS = ['data_center:dashboard', 'data_center:staff_commission']

const HQ_ADMIN: AuthSession = {
  employeeId: 'ADMIN', name: '总部', phone: '1',
  roles: [{ role: 'admin', isSuperAdmin: true, scopeId: 'HQ', scopeType: '总部', actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['HQ'] }],
  permissions: { actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['HQ'] },
} as AuthSession

const HR_PX: AuthSession = {
  employeeId: 'FY-260522002', name: '品项 HR', phone: '1',
  roles: [{ role: 'hr', scopeId: 'PX', scopeType: '市场', actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['PX'] }],
  permissions: { actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['PX'] },
} as AuthSession

const MULTI_STORE_MANAGER: AuthSession = {
  employeeId: 'MGR', name: '市场经理', phone: '1',
  roles: [{ role: 'manager', scopeId: 'M1', scopeType: '市场', actions: ACTIONS, scopeStoreIds: ['S1', 'S2'], scopeOrgNodeIds: ['M1'] }],
  permissions: { actions: ACTIONS, scopeStoreIds: ['S1', 'S2'], scopeOrgNodeIds: ['M1'] },
} as AuthSession

/** 品项公司：无门店，1 名直挂品项老师；门店口径 0，员工榜有她 4 万+ 分配额 */
const PX_ONLY: Fixture = {
  skeleton: [],
  techCount: 1,
  techByStore: [],
  techDirect: [{ market_id: 'PX', market_name: '品项公司', v: 1 }],
  revenueTotal: 0,
  staffRevenue: [{ employee_id: 'FY-PX-01', employee_name: '王润', store_id: null, store_name: '品项公司', market_name: '品项公司', value: '42624.00' }],
  commission: { sale: '0', service: '0', orders: 0, earning_employees: 0, employees: 0 },
}

/** 两家门店（M1）+ 品项公司直挂 1 人 */
const MULTI_STORE: Fixture = {
  skeleton: [
    { store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' },
    { store_id: 'S2', store_name: '门店二', market_id: 'M1', market_name: '市场甲' },
  ],
  techCount: 5,
  techByStore: [{ store_id: 'S1', v: 2 }, { store_id: 'S2', v: 2 }],
  techDirect: [{ market_id: 'PX', market_name: '品项公司', v: 1 }],
  revenueTotal: 5000,
  staffRevenue: [],
  commission: { sale: '600', service: '400', orders: 10, earning_employees: 4, employees: 4 },
}

const PER_TECH_KPIS = ['empAvgRevenue', 'empAvgConsume', 'empAvgIncome', 'empAvgMembers', 'empAvgProjects'] as const
const PER_TECH_MARKET = ['techAvgRevenue', 'techAvgConsume', 'techAvgShengmeiConsume', 'techAvgIncome', 'techAvgMembers', 'techAvgProjects'] as const

function hasStoreSql() {
  const q = captured.filter((c) => /AS has_store/.test(c.sql))
  expect(q, '提成日报必须跑一次范围内门店判定').toHaveLength(1)
  return q[0]
}

async function efficiency(session: AuthSession, scope: Parameters<typeof getEfficiencyBoard>[0]['scope']) {
  mockGetSession.mockResolvedValue(session)
  return getEfficiencyBoard({ scope, timeRange: { preset: 'month' }, withComparison: false })
}

async function commission(session: AuthSession, query: Record<string, string>) {
  mockGetSession.mockResolvedValue(session)
  captured.length = 0
  return getCommissionDaily({ month: '2026-09', ...query })
}

beforeEach(() => {
  captured.length = 0
})

// 每组必须自己设夹具：漏写 beforeEach 时直接炸，而不是静默沿用上一组的
afterEach(() => {
  fixture.current = null as unknown as Fixture
})

describe('#423 总部选品项公司市场', () => {
  beforeEach(() => { fixture.current = PX_ONLY })

  it('人效板：顶部 5 项技师人均为 null（不是 0），noStoreScope=true；员工榜照常有品项老师', async () => {
    const res = await efficiency(HQ_ADMIN, { type: 'market', id: 'PX' })
    expect(res.noStoreScope).toBe(true)
    for (const key of PER_TECH_KPIS) expect(res.kpis[key].value, key).toBeNull()
    expect(res.staffRankings.revenue).toEqual([expect.objectContaining({ id: 'FY-PX-01', value: 42624 })])
  })

  it('人效板按市场明细：品项公司行技师人数照计，技师人均全为 null，并列入 noStoreMarkets', async () => {
    const res = await efficiency(HQ_ADMIN, { type: 'market', id: 'PX' })
    const px = res.byMarket.find((r) => r.groupId === 'PX')!
    expect(px.metrics.technicianCount).toBe(1)
    for (const key of PER_TECH_MARKET) expect(px.metrics[key], key).toBeNull()
    expect(res.noStoreMarkets).toEqual(['品项公司'])
  })

  it('提成日报：人均提成为 null、noStoreScope=true，技师数照常下发；判定 SQL 按所选市场展开门店', async () => {
    const res = await commission(HQ_ADMIN, { scope: 'market', scopeId: 'PX' })
    expect(res.kpis.noStoreScope).toBe(true)
    expect(res.kpis.perTechnician).toBeNull()
    expect(res.kpis.technicianCount).toBe(1)
    const q = hasStoreSql()
    // 判定必须逐字包住人效板用的同一份门店骨架：只改其中一处（如 #376 多店 scope）时这里变红
    const skeleton = new PgDialect().sqlToQuery(scopeStoreSkeletonSql(HQ_ADMIN, { type: 'market', id: 'PX' })).sql
    const bare = (text: string) => text.replace(/\s+/g, '')
    expect(bare(q.sql)).toBe(bare(`SELECT EXISTS (${skeleton}) AS has_store`))
    expect(q.params).toContain('PX')
  })
})

describe('#423 hr@品项公司 默认范围', () => {
  beforeEach(() => { fixture.current = PX_ONLY })

  // 默认范围走页面真实推导（#399），不手写
  const pxOptions: DataCenterScopeOptions = {
    topLevel: 'market', inactiveStores: [],
    markets: [{ id: 'PX', name: '品项公司', stores: [], granted: true }],
  }
  const defaults = defaultScopeParams(pxOptions)!

  it('默认范围即品项公司市场', () => {
    expect(defaults).toEqual({ scope: 'market', scopeId: 'PX' })
  })

  it('人效板：技师人均全为 null，员工榜照常有品项老师（员工归属口径，#423 决策 2 接受）', async () => {
    const res = await efficiency(HR_PX, { type: 'market', id: defaults.scopeId })
    expect(res.noStoreScope).toBe(true)
    for (const key of PER_TECH_KPIS) expect(res.kpis[key].value, key).toBeNull()
    for (const key of PER_TECH_MARKET) expect(res.byMarket.find((r) => r.groupId === 'PX')!.metrics[key], key).toBeNull()
    expect(res.staffRankings.revenue).toEqual([expect.objectContaining({ id: 'FY-PX-01', value: 42624 })])
  })

  it('提成日报：人均提成为 null；零授权门店账号的门店判定是字面 FALSE', async () => {
    const res = await commission(HR_PX, defaults)
    expect(res.kpis.noStoreScope).toBe(true)
    expect(res.kpis.perTechnician).toBeNull()
    expect(hasStoreSql().sql).toMatch(/WHERE FALSE\s*\)\s*AS has_store/)
  })
})

describe('#423 多店范围：范围内有门店 → 人均照常计算', () => {
  beforeEach(() => { fixture.current = MULTI_STORE })

  it('总部全部范围：顶部人均 = 门店口径业绩 ÷ 全部产能技师（含直挂品项老师）；只有品项公司行是 null', async () => {
    const res = await efficiency(HQ_ADMIN, { type: 'all' })
    expect(res.noStoreScope).toBe(false)
    expect(res.kpis.empAvgRevenue.value).toBe(1000) // 5000 / 5
    for (const key of PER_TECH_KPIS) expect(res.kpis[key].value, key).not.toBeNull()

    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!
    expect(m1.metrics.technicianCount).toBe(4)
    for (const key of PER_TECH_MARKET) expect(m1.metrics[key], key).toBe(0) // 有门店：0 业绩就是 0，不是 --
    const px = res.byMarket.find((r) => r.groupId === 'PX')!
    for (const key of PER_TECH_MARKET) expect(px.metrics[key], key).toBeNull()
    expect(res.noStoreMarkets).toEqual(['品项公司'])
  })

  it('多店账号授权范围：人均照常，门店判定带上全部授权门店', async () => {
    const eff = await efficiency(MULTI_STORE_MANAGER, { type: 'authorized' })
    expect(eff.noStoreScope).toBe(false)
    expect(eff.kpis.empAvgRevenue.value).toBe(1000)

    const res = await commission(MULTI_STORE_MANAGER, { scope: 'authorized' })
    expect(res.kpis.noStoreScope).toBe(false)
    expect(res.kpis.perTechnician).toBe(200) // (600 + 400) / 5
    const q = hasStoreSql()
    expect(q.params).toEqual(expect.arrayContaining(['S1', 'S2']))
  })
})
