/**
 * 品项板块 getProductBoard 装配单测
 *
 * 策略：mock @/db.execute（按 SQL 文本路由 canned 行）+ mock prepareBoardContext（固定 ctx）
 *   + mock getMemberThreshold + mock auth/permissions（让 withPermission 闸门放行）。
 * 不验证 SQL 正确性（那是 e2e / consistency 的活），只验证装配：
 *   - filterOptions 结构（一级 kind + 其下二级 categories）
 *   - kpis 键齐全（10 项）+ unit 正确
 *   - byMarket/byStore 结构（groupId/groupName/marketName/metrics 含持卡/体验/新增/复购列）
 *   - selected 透传一级/二级筛选
 *   - 派生（客单价/占比/复购率）防除零 → null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * mock @/db.execute —— 按 SQL 文本内容路由：
 *   - filterOptions（含 'DISTINCT pc.product_kind' 特征）→ filterRows
 *   - 骨架（含 o_store + market_id，无 CTE）→ skeletonRows
 *   - 持卡 / 会员 / cycle 的市场、门店直出聚合（WITH skel）→ 对应 rows
 *   - 持卡总量（含 paid_sessions > 0，无 GROUP BY store）→ scalarCard
 *   - 会员总量（含 became_member_at，无 GROUP BY）→ scalarMember
 *   - cycle 标量（含 WITH daily_agg + cohort）→ scalarCycle
 */
const responder: {
  filterRows: Array<Record<string, unknown>>
  skeletonRows: Array<Record<string, unknown>>
  cardByStoreRows: Array<Record<string, unknown>>
  cardByMarketRows: Array<Record<string, unknown>>
  memberByStoreRows: Array<Record<string, unknown>>
  memberByMarketRows: Array<Record<string, unknown>>
  cycleByStoreRows: Array<Record<string, unknown>>
  cycleByMarketRows: Array<Record<string, unknown>>
  scalarCard: Record<string, unknown>
  scalarMember: Record<string, unknown>
  scalarCycle: Record<string, unknown>
} = {
  filterRows: [],
  skeletonRows: [],
  cardByStoreRows: [],
  cardByMarketRows: [],
  memberByStoreRows: [],
  memberByMarketRows: [],
  cycleByStoreRows: [],
  cycleByMarketRows: [],
  scalarCard: { v: 0 },
  scalarMember: { v: 0 },
  scalarCycle: { count: 0, revenue: 0 },
}

// 明细查询固定按：持卡/会员/cycle 的门店组，再持卡/会员/cycle 的市场组触发。
// Drizzle 的 sql.raw 动态列不会出现在这个简化 SQL 文本中，因此这里不从文本猜 market_id。
let breakdownQueryIndex = 0

/** 从 drizzle sql 对象重建粗略 SQL 文本（仅用于路由判断） */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? []
  return chunks
    .map((c) => {
      const v = c?.value
      if (Array.isArray(v)) return v.join(' ')
      if (typeof v === 'string') return v
      return ''
    })
    .join(' ')
}

vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(async (q: unknown) => {
      const t = sqlText(q)
      // filterOptions
      if (/DISTINCT pc\.product_kind/.test(t) && /category_name AS category/.test(t)) {
        return responder.filterRows
      }
      // 明细聚合（WITH skel）：市场、门店查询分别返回已按目标维度去重的数据。
      if (/WITH skel/.test(t) && /daily_agg/.test(t)) {
        const isMarketGroup = breakdownQueryIndex++ >= 3
        return isMarketGroup ? responder.cycleByMarketRows : responder.cycleByStoreRows
      }
      if (/WITH skel/.test(t) && /paid_sessions/.test(t)) {
        const isMarketGroup = breakdownQueryIndex++ >= 3
        return isMarketGroup ? responder.cardByMarketRows : responder.cardByStoreRows
      }
      if (/WITH skel/.test(t) && /became_member_at/.test(t)) {
        const isMarketGroup = breakdownQueryIndex++ >= 3
        return isMarketGroup ? responder.memberByMarketRows : responder.memberByStoreRows
      }
      // 骨架（o_store + market_id，无 CTE）
      if (/o_store/.test(t) && /market_id/.test(t)) {
        return responder.skeletonRows
      }
      // cycle 标量（WITH daily_agg + cohort）
      if (/WITH daily_agg/.test(t) && /cohort/.test(t)) {
        return [responder.scalarCycle]
      }
      // 持卡总量（paid_sessions > 0，无 GROUP BY store）
      if (/paid_sessions/.test(t)) {
        return [responder.scalarCard]
      }
      // 会员总量
      if (/became_member_at/.test(t)) {
        return [responder.scalarMember]
      }
      return [{ v: 0 }]
    }),
  },
}))

// ── mock 会员门槛 ─────────────────────────────────────────────
vi.mock('@/lib/member-threshold', () => ({
  getMemberThreshold: vi.fn(async () => 1990),
}))

// ── mock 鉴权闸门 ─────────────────────────────────────────────
const fakeSession = {
  employeeId: 'e1',
  name: '测试',
  phone: '13900000000',
  roles: [{ role: 'admin', scopeType: '总部' }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] as string[] },
} as unknown
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => fakeSession),
}))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  isAdminScope: () => true,
}))

// ── mock prepareBoardContext：固定 meta + comparison（enabled=false 单次 runner）──
const fixedCtx = {
  scope: { type: 'all' as const },
  meta: {
    scope: { type: 'all' as const, id: null, name: '全部' },
    timeRange: { start: '2026-05-01', end: '2026-05-26', presetLabel: '本月' },
  },
  comparison: {
    current: { start: '2026-05-01', end: '2026-05-26' },
    previous: { start: '2026-04-01', end: '2026-04-30' },
    lastYear: { start: '2025-05-01', end: '2025-05-26' },
  },
  enabled: false,
}
vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: vi.fn(async () => fixedCtx),
}))

import { getProductBoard } from '../product'
import type { ProductBoardParams } from '@/lib/data-center/types'

const PARAMS: ProductBoardParams = {
  scope: { type: 'all' },
  timeRange: { preset: 'month' },
  withComparison: false,
}

beforeEach(() => {
  breakdownQueryIndex = 0
  responder.filterRows = []
  responder.skeletonRows = []
  responder.cardByStoreRows = []
  responder.cardByMarketRows = []
  responder.memberByStoreRows = []
  responder.memberByMarketRows = []
  responder.cycleByStoreRows = []
  responder.cycleByMarketRows = []
  responder.scalarCard = { v: 0 }
  responder.scalarMember = { v: 0 }
  responder.scalarCycle = { count: 0, revenue: 0 }
})

describe('getProductBoard 装配', () => {
  it('filterOptions：一级 kind + 其下二级 categories', async () => {
    responder.filterRows = [
      { kind: '护理项目', category: '面部护理' },
      { kind: '护理项目', category: '身体护理' },
      { kind: '家居产品', category: '精华液' },
    ]
    const res = await getProductBoard(PARAMS)
    expect(res.filterOptions).toEqual([
      { kind: '护理项目', categories: ['面部护理', '身体护理'] },
      { kind: '家居产品', categories: ['精华液'] },
    ])
  })

  it('kpis 键齐全（10 项）且 unit 正确', async () => {
    responder.scalarCard = { v: 8 }
    responder.scalarMember = { v: 20 }
    responder.scalarCycle = { count: 4, revenue: 40000 }

    const res = await getProductBoard(PARAMS)

    const expectedKeys = [
      'cardHolders',
      'cardHolderRate',
      'trialCount',
      'newCount',
      'newRevenue',
      'newAvgTicket',
      'repurchaseCount',
      'repurchaseRevenue',
      'repurchaseAvgTicket',
      'repurchaseRate',
    ]
    expect(Object.keys(res.kpis).sort()).toEqual(expectedKeys.sort())

    expect(res.kpis.cardHolders.unit).toBe('count')
    expect(res.kpis.cardHolderRate.unit).toBe('percent')
    expect(res.kpis.trialCount.unit).toBe('count')
    expect(res.kpis.newCount.unit).toBe('count')
    expect(res.kpis.newRevenue.unit).toBe('amount')
    expect(res.kpis.newAvgTicket.unit).toBe('amount')
    expect(res.kpis.repurchaseRevenue.unit).toBe('amount')
    expect(res.kpis.repurchaseAvgTicket.unit).toBe('amount')
    expect(res.kpis.repurchaseRate.unit).toBe('percent')
  })

  it('KPI 派生：持卡占比 / 复购率 / 客单价正确', async () => {
    responder.scalarCard = { v: 10 } // 持卡 10
    responder.scalarMember = { v: 40 } // 会员 40
    responder.scalarCycle = { count: 5, revenue: 50000 } // 各 cohort 都返回这个标量

    const res = await getProductBoard(PARAMS)

    // 持卡占比 = 10 / 40 = 0.25
    expect(res.kpis.cardHolderRate.value).toBeCloseTo(0.25, 6)
    // 复购率 = 复购人数(5) / 品项进入人数(5) = 1
    expect(res.kpis.repurchaseRate.value).toBeCloseTo(1, 6)
    // 新增客单价 = 50000 / 5 = 10000
    expect(res.kpis.newAvgTicket.value).toBe(10000)
    // 复购客单价 = 50000 / 5 = 10000
    expect(res.kpis.repurchaseAvgTicket.value).toBe(10000)
  })

  it('meta 透传自 ctx（scope/timeRange/presetLabel）', async () => {
    const res = await getProductBoard(PARAMS)
    expect(res.scope).toEqual({ type: 'all', id: null, name: '全部' })
    expect(res.timeRange).toEqual({ start: '2026-05-01', end: '2026-05-26', presetLabel: '本月' })
  })

  it('selected 透传一级 / 二级筛选（含 trim 空串归 null）', async () => {
    const res1 = await getProductBoard({ ...PARAMS, productKind: '护理项目', categoryName: '面部护理' })
    expect(res1.selected).toEqual({ productKind: '护理项目', categoryName: '面部护理' })

    const res2 = await getProductBoard({ ...PARAMS, productKind: '', categoryName: '  ' })
    expect(res2.selected).toEqual({ productKind: null, categoryName: null })

    const res3 = await getProductBoard(PARAMS)
    expect(res3.selected).toEqual({ productKind: null, categoryName: null })
  })

  it('byMarket / byStore 含持卡/体验/新增/复购列 + 派生', async () => {
    responder.scalarCard = { v: 1 }
    responder.scalarMember = { v: 1 }
    responder.scalarCycle = { count: 1, revenue: 10 }
    // 骨架：1 市场 1 门店
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    responder.cardByStoreRows = [{ group_id: 's1', v: 6 }]
    responder.cardByMarketRows = [{ group_id: 'm1', v: 6 }]
    responder.memberByStoreRows = [{ group_id: 's1', v: 24 }]
    responder.memberByMarketRows = [{ group_id: 'm1', v: 24 }]
    responder.cycleByStoreRows = [
      {
        group_id: 's1',
        trial_count: 2,
        new_count: 3,
        new_revenue: 30000,
        repurchase_count: 3,
        repurchase_revenue: 30000,
      },
    ]
    responder.cycleByMarketRows = [
      {
        group_id: 'm1',
        trial_count: 2,
        new_count: 3,
        new_revenue: 30000,
        repurchase_count: 3,
        repurchase_revenue: 30000,
      },
    ]

    const res = await getProductBoard(PARAMS)

    expect(res.byMarket).toHaveLength(1)
    expect(res.byStore).toHaveLength(1)

    const m = res.byMarket[0]
    expect(m.groupId).toBe('m1')
    expect(m.groupName).toBe('市场A')
    expect(m.marketName).toBeUndefined() // 市场行不带所属市场

    for (const k of [
      'cardHolders',
      'cardHolderRate',
      'trialCount',
      'newCount',
      'newRevenue',
      'newAvgTicket',
      'repurchaseCount',
      'repurchaseRevenue',
      'repurchaseRate',
    ]) {
      expect(m.metrics).toHaveProperty(k)
    }

    // 持卡占比 = 6 / 24 = 0.25
    expect(m.metrics.cardHolderRate).toBeCloseTo(0.25, 6)
    // 新增客单价 = 30000 / 3 = 10000
    expect(m.metrics.newAvgTicket).toBe(10000)
    // 复购率 = 复购(3) / 品项进入(3) = 1
    expect(m.metrics.repurchaseRate).toBeCloseTo(1, 6)

    // 门店行带所属市场
    const s = res.byStore[0]
    expect(s.groupId).toBe('s1')
    expect(s.marketName).toBe('市场A')
    expect(s.metrics.cardHolders).toBe(6)
    expect(s.metrics.trialCount).toBe(2)
  })

  it('明细派生防除零：分母 0 → null', async () => {
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    responder.cardByStoreRows = [{ group_id: 's1', v: 0 }] // 持卡 0 → 复购率 null
    responder.cardByMarketRows = [{ group_id: 'm1', v: 0 }]
    responder.memberByStoreRows = [{ group_id: 's1', v: 0 }] // 会员 0 → 占比 null
    responder.memberByMarketRows = [{ group_id: 'm1', v: 0 }]
    responder.cycleByStoreRows = [
      { group_id: 's1', trial_count: 0, new_count: 0, new_revenue: 0, repurchase_count: 0, repurchase_revenue: 0 },
    ]
    responder.cycleByMarketRows = [
      { group_id: 'm1', trial_count: 0, new_count: 0, new_revenue: 0, repurchase_count: 0, repurchase_revenue: 0 },
    ]

    const res = await getProductBoard(PARAMS)
    const m = res.byMarket[0]
    expect(m.metrics.cardHolderRate).toBeNull()
    expect(m.metrics.newAvgTicket).toBeNull()
    expect(m.metrics.repurchaseRate).toBeNull()
  })

  it('市场行使用市场内去重结果，不累加同市场跨店顾客', async () => {
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
      { market_id: 'm1', market_name: '市场A', store_id: 's2', store_name: '门店2' },
    ]
    // 同一顾客在两店均有记录：门店行可各有一份，市场行必须以市场去重值为准。
    responder.cardByStoreRows = [{ group_id: 's1', v: 4 }, { group_id: 's2', v: 4 }]
    responder.cardByMarketRows = [{ group_id: 'm1', v: 5 }]
    responder.memberByStoreRows = [{ group_id: 's1', v: 10 }, { group_id: 's2', v: 10 }]
    responder.memberByMarketRows = [{ group_id: 'm1', v: 20 }]
    responder.cycleByStoreRows = [
      { group_id: 's1', trial_count: 3, new_count: 3, new_revenue: 300, repurchase_count: 3, repurchase_revenue: 300 },
      { group_id: 's2', trial_count: 3, new_count: 3, new_revenue: 300, repurchase_count: 3, repurchase_revenue: 300 },
    ]
    responder.cycleByMarketRows = [
      { group_id: 'm1', trial_count: 5, new_count: 5, new_revenue: 600, repurchase_count: 5, repurchase_revenue: 600 },
    ]

    const res = await getProductBoard(PARAMS)
    const market = res.byMarket.find((row) => row.groupId === 'm1')!

    expect(market.metrics.cardHolders).toBe(5)
    expect(market.metrics.trialCount).toBe(5)
    expect(market.metrics.newCount).toBe(5)
    expect(market.metrics.repurchaseCount).toBe(5)
    expect(market.metrics.newRevenue).toBe(600)
  })
})
