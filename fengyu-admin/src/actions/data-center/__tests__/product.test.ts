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
 *   - 骨架（含 o_store + market_id，无 group/CTE）→ skeletonRows
 *   - 持卡按店（含 paid_sessions > 0 + GROUP BY so.store_id）→ cardByStoreRows
 *   - 会员按店（含 bound_store_id + GROUP BY）→ memberByStoreRows
 *   - cycle 按店（含 store_ids 并集 + trial_store/new_store/repurchase_store）→ cycleByStoreRows
 *   - 持卡总量（含 paid_sessions > 0，无 GROUP BY store）→ scalarCard
 *   - 会员总量（含 became_member_at，无 GROUP BY）→ scalarMember
 *   - cycle 标量（含 WITH daily_agg + cohort）→ scalarCycle
 */
const responder: {
  filterRows: Array<Record<string, unknown>>
  skeletonRows: Array<Record<string, unknown>>
  cardByStoreRows: Array<Record<string, unknown>>
  memberByStoreRows: Array<Record<string, unknown>>
  cycleByStoreRows: Array<Record<string, unknown>>
  scalarCard: Record<string, unknown>
  scalarMember: Record<string, unknown>
  scalarCycle: Record<string, unknown>
} = {
  filterRows: [],
  skeletonRows: [],
  cardByStoreRows: [],
  memberByStoreRows: [],
  cycleByStoreRows: [],
  scalarCard: { v: 0 },
  scalarMember: { v: 0 },
  scalarCycle: { count: 0, revenue: 0 },
}

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
      // 骨架（o_store + market_id，非 CTE/分组）
      if (/o_store/.test(t) && /market_id/.test(t) && !/WITH daily_agg/.test(t)) {
        return responder.skeletonRows
      }
      // cycle 按店（含 store_ids 并集 + 各客群 store 聚合，无 cohort 标量段）
      if (/store_ids/.test(t) && /trial_store/.test(t)) {
        return responder.cycleByStoreRows
      }
      // cycle 标量（WITH daily_agg + cohort）
      if (/WITH daily_agg/.test(t) && /cohort/.test(t)) {
        return [responder.scalarCycle]
      }
      /**
       * ⚠️ **持卡必须先于会员判定**（#287）。
       *
       * 同源改造后，持卡查询与会员查询共用同一个
       * `FROM client_wechat_users c WHERE <scope on bound_store_id> AND became_member_at IS NOT NULL`
       * 前缀，byStore 侧连 `GROUP BY c.bound_store_id` 都一样 —— 唯一的区别是持卡多了
       * `paid_sessions`（在 `EXISTS` 子查询里）。
       *
       * 旧路由按「`paid_sessions` + `GROUP BY so.store_id`」认持卡，改造后前者还在、
       * 后者没了，于是**持卡查询被错路由成会员查询**，两者返回同一批行、占比恒等于 1。
       * 本轮实测踩到过。所以这里改成 `paid_sessions` 优先分流。
       */
      if (/paid_sessions/.test(t)) {
        return /GROUP BY c\.bound_store_id/.test(t)
          ? responder.cardByStoreRows
          : [responder.scalarCard]
      }
      if (/became_member_at/.test(t)) {
        return /GROUP BY c\.bound_store_id/.test(t)
          ? responder.memberByStoreRows
          : [responder.scalarMember]
      }
      /**
       * ⚠️ **兜底必须抛错，不能返回零值** —— 本轮实测教训：
       * 同源改造后持卡 SQL 与会员 SQL 高度相似，路由一旦混淆就会静默取到错误的行；
       * 若兜底再把「没命中任何分支」伪装成合法的 `[{ v: 0 }]`，
       * 两类失效都变成「数字看起来只是变了」而不是「测试红」。
       */
      throw new Error('mock 未路由到任何分支，SQL 片段：' + t.slice(0, 200))
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
  responder.filterRows = []
  responder.skeletonRows = []
  responder.cardByStoreRows = []
  responder.memberByStoreRows = []
  responder.cycleByStoreRows = []
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
    responder.cardByStoreRows = [{ store_id: 's1', v: 6 }]
    responder.memberByStoreRows = [{ store_id: 's1', v: 24 }]
    responder.cycleByStoreRows = [
      {
        store_id: 's1',
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

  /**
   * #287：持卡占比曾经分子分母不同源，集团恒 253%、单店最高 2600%。
   *
   * ⚠️ **本文件 mock 掉了 SQL，证不了「SQL 层面不会再出 >100%」** —— 那由
   * `consistency.product.test.ts` 的结构守护 + 生产实测（40 家门店 0 家 >100%）背书。
   * 这里只能守住装配层的两件事，而**旧夹具（6 / 24）两件都守不住**：
   *
   *   1. **两条查询不得被路由混淆** —— 同源改造后持卡与会员查询共用同一个前缀、
   *      连 `GROUP BY c.bound_store_id` 都一样，极易被按文本路由的 mock 混为一谈。
   *      一旦混淆，两者返回同一批行、占比恒等于 **1** —— 而旧夹具（6/24）下这看起来只是"数变了"。
   *      分子分母取**互质且都非零**的值（30/24），混淆时占比会变成 1 ≠ 1.25，
   *      下面 `toBeCloseTo(1.25)` 那一条就是探测器（再写一条 `not.toBe(1)` 是装饰，被它蕴含）。
   *   2. **装配层不得偷偷夹紧到 100%** —— 若 SQL 层将来回归出 >100%，看板必须**如实显示**，
   *      让读数人看见异常；夹紧会把 SQL 缺陷伪装成正常数字（#287 能被审计发现正是因为它没夹紧）。
   */
  it('持卡占比：分子分母不混淆，>100% 如实透传不夹紧（#287）', async () => {
    responder.skeletonRows = [
      { store_id: 's1', store_name: '门店1', market_id: 'm1', market_name: '市场A' },
    ]
    // 30 / 24 = 1.25：两值互质且非零 —— 若两条查询被路由混淆，结果会精确等于 1
    responder.cardByStoreRows = [{ store_id: 's1', v: 30 }]
    responder.memberByStoreRows = [{ store_id: 's1', v: 24 }]
    responder.scalarCard = { v: 30 }
    responder.scalarMember = { v: 24 }
    responder.cycleByStoreRows = [
      {
        store_id: 's1',
        trial_count: 0,
        new_count: 0,
        new_revenue: 0,
        repurchase_count: 0,
        repurchase_revenue: 0,
      },
    ]

    const res = await getProductBoard(PARAMS)
    const s = res.byStore[0]

    expect(s.metrics.cardHolders, '持卡数被会员数顶替 —— 两条查询在 mock 路由里被混淆了').toBe(30)
    expect(
      s.metrics.cardHolderRate,
      '持卡占比被夹紧到 100% —— SQL 层若回归出 >100%，看板必须如实显示，否则缺陷会被伪装成正常数字',
    ).toBeCloseTo(1.25, 6)
    // KPI 大卡同理
    expect(res.kpis.cardHolders.value).toBe(30)
    expect(res.kpis.cardHolderRate.value).toBeCloseTo(1.25, 6)
  })

  it('明细派生防除零：分母 0 → null', async () => {
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    responder.cardByStoreRows = [{ store_id: 's1', v: 0 }]
    responder.memberByStoreRows = [{ store_id: 's1', v: 0 }] // 会员 0 → 占比 null
    responder.cycleByStoreRows = [
      { store_id: 's1', trial_count: 0, new_count: 0, new_revenue: 0, repurchase_count: 0, repurchase_revenue: 0 },
    ]

    const res = await getProductBoard(PARAMS)
    const m = res.byMarket[0]
    expect(m.metrics.cardHolderRate).toBeNull()
    expect(m.metrics.newAvgTicket).toBeNull()
    expect(m.metrics.repurchaseRate).toBeNull()
  })
})
