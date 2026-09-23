/**
 * 客量板块 getCustomerBoard 装配单测
 *
 * 策略：mock @/db.execute（按调用顺序喂 canned 行）+ mock prepareBoardContext（固定 ctx）
 *   + mock auth/permissions（让 withPermission 闸门放行）。
 * 不验证 SQL 正确性（那是 e2e / consistency 的活），只验证：
 *   - kpis 键齐全（19 项）+ unit 正确
 *   - 6 分桶键 + 激活键出现在 byMarket/byStore.metrics
 *   - byMarket/byStore 结构（groupId/groupName/marketName/metrics）
 *   - 派生（convRate/客单价）防除零 → null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * mock @/db.execute —— 按 SQL 文本内容路由（不靠调用顺序，避免 KPI 多查询计数脆弱）：
 *   - 骨架查询（含 'o_store' / market_id AS）→ skeletonRows
 *   - 明细聚合（产出 group_id + registered）→ regActiveRows
 *   - 明细聚合（产出 group_id + bucket_d）→ opsRows
 *   - 其余（KPI 标量）→ scalarRow
 * 测试通过设置这些变量控制返回。
 */
const responder: {
  scalarRow: Record<string, unknown>
  skeletonRows: Array<Record<string, unknown>>
  regActiveRows: Array<Record<string, unknown>>
  opsRows: Array<Record<string, unknown>>
} = {
  scalarRow: { v: 0, total_count: 0, total_spend: 0 },
  skeletonRows: [],
  regActiveRows: [],
  opsRows: [],
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
      // 骨架查询特征：JOIN org_nodes o_store ... market_id
      if (/o_store/.test(t) && /market_id/.test(t) && !/group_id/i.test(t) && !/WITH skel/.test(t)) {
        return responder.skeletonRows
      }
      // 明细聚合（WITH skel）：按产出列区分 regActive vs ops
      if (/WITH skel/.test(t)) {
        if (/bucket_d/.test(t)) return responder.opsRows
        return responder.regActiveRows
      }
      return [responder.scalarRow]
    }),
  },
}))

// ── mock 鉴权闸门（withPermission 内部 getSession + requirePermission）──
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
  // scope-sql.ts 依赖 isAdminScope；admin → TRUE 短路
  isAdminScope: () => true,
}))

// ── mock prepareBoardContext：固定 meta + comparison ─────────────
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
  enabled: false, // 关同比环比 → 每个 KPI 仅 1 次 runner，DB 调用可预期
}
/**
 * 同比/环比开关。默认 false（上面那条理由），但「分母禁用同比」这条不变量
 * 只在 `enabled=true` 时才走到，固定 false 会让它零覆盖（#284 round-1 两个谱系都点名）。
 * 用可变对象而不是改 fixedCtx，保证其余用例的 DB 调用次数仍然可预期。
 */
const ctxState = { enabled: false }
vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: vi.fn(async () => ({ ...fixedCtx, enabled: ctxState.enabled })),
}))

import { getCustomerBoard } from '../customer'
import { db } from '@/db'
import type { BoardParams } from '@/lib/data-center/types'

const PARAMS: BoardParams = {
  scope: { type: 'all' },
  timeRange: { preset: 'month' },
  withComparison: false,
}

beforeEach(() => {
  ctxState.enabled = false
  responder.scalarRow = { v: 0, total_count: 0, total_spend: 0 }
  responder.skeletonRows = []
  responder.regActiveRows = []
  responder.opsRows = []
})

describe('getCustomerBoard 装配', () => {
  it('kpis 键齐全（19 项）且 unit 正确', async () => {
    responder.scalarRow = { v: 5, total_count: 3, total_spend: 30 }

    const res = await getCustomerBoard(PARAMS)

    const expectedKeys = [
      'registeredMembers',
      'retainedMembers',
      'visitOnce',
      'visitTwice',
      'dormant',
      'reactivatedDormant',
      'frozen',
      'reactivatedFrozen',
      'deep',
      'reactivatedDeep',
      'operatedMembers',
      'newMembers',
      'trafficCustomers',
      'convRate',
      'memberAvgTicket',
      'newCustomerAvgTicket',
      'serviceCount',
      'projectCount',
      'consumePerVisit',
    ]
    expect(Object.keys(res.kpis).sort()).toEqual(expectedKeys.sort())
    expect(res.kpis).toHaveProperty('registeredMembers')

    // unit 抽查
    expect(res.kpis.registeredMembers.unit).toBe('count')
    expect(res.kpis.memberAvgTicket.unit).toBe('amount')
    expect(res.kpis.newCustomerAvgTicket.unit).toBe('amount')
    expect(res.kpis.convRate.unit).toBe('percent')
    expect(res.kpis.consumePerVisit.unit).toBe('amount')
    expect(res.kpis.serviceCount.unit).toBe('count')
  })

  it('meta 透传自 ctx（scope/timeRange/presetLabel）', async () => {
    const res = await getCustomerBoard(PARAMS)
    expect(res.scope).toEqual({ type: 'all', id: null, name: '全部' })
    expect(res.timeRange).toEqual({ start: '2026-05-01', end: '2026-05-26', presetLabel: '本月' })
  })

  it('byMarket / byStore 含 6 分桶键 + 激活键 + 注册客活键 + 派生列', async () => {
    responder.scalarRow = { v: 1, total_count: 1, total_spend: 10 }
    // 骨架：1 市场 1 门店（buildBreakdownRows 据此去重出组）
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    // regActive 聚合：同时含 m1（市场维度）+ s1（门店维度），路由无法区分故两行都给
    const regRow = {
      registered: 10,
      retained: 8,
      visit_once: 3,
      visit_twice: 2,
      dormant: 1,
      react_dormant: 1,
      frozen: 0,
      react_frozen: 0,
      deep: 0,
      react_deep: 0,
    }
    responder.regActiveRows = [
      { group_id: 'm1', group_name: '市场A', market_name: '市场A', ...regRow },
      { group_id: 's1', group_name: '门店1', market_name: '市场A', ...regRow },
    ]
    const opsRow = {
      bucket_d: 1,
      bucket_c: 2,
      bucket_b: 1,
      bucket_a: 0,
      bucket_v: 0,
      bucket_vic: 0,
      operated_total: 3,
      member_spend_total: 50000,
      member_spend_count: 4,
      new_members: 2,
      new_spend: 8000,
      traffic_customers: 5,
      traffic_visits: 7,
      member_visits: 9,
      project_count: 12,
      sm_total: 3000,
    }
    responder.opsRows = [
      { group_id: 'm1', ...opsRow },
      { group_id: 's1', ...opsRow },
    ]

    const res = await getCustomerBoard(PARAMS)

    expect(res.byMarket).toHaveLength(1)
    expect(res.byStore).toHaveLength(1)

    const m = res.byMarket[0]
    expect(m.groupId).toBe('m1')
    expect(m.groupName).toBe('市场A')
    // 市场行不带 marketName（按市场分组）
    expect(m.marketName).toBeUndefined()

    // 6 分桶键
    for (const k of ['bucketD', 'bucketC', 'bucketB', 'bucketA', 'bucketV', 'bucketVIC']) {
      expect(m.metrics).toHaveProperty(k)
    }
    // 激活键
    for (const k of ['reactivatedDormant', 'reactivatedFrozen', 'reactivatedDeep']) {
      expect(m.metrics).toHaveProperty(k)
    }
    // 注册客活键 + 达成率
    for (const k of ['registered', 'retained', 'visitOnce', 'visitOnceRate', 'visitTwice', 'visitTwiceRate']) {
      expect(m.metrics).toHaveProperty(k)
    }
    // 经营派生列
    for (const k of ['operatedTotal', 'newMembers', 'trafficCustomers', 'convRate', 'memberAvgTicket', 'newCustomerAvgTicket', 'trafficVisits', 'memberVisits', 'projectCount', 'consumePerVisit']) {
      expect(m.metrics).toHaveProperty(k)
    }

    // 派生值正确性：会员客单 = 50000 / 4 = 12500
    expect(m.metrics.memberAvgTicket).toBe(12500)
    // 新客客单 = 8000 / 2 = 4000
    expect(m.metrics.newCustomerAvgTicket).toBe(4000)
    // 成交率 = 2 / 5 = 0.4
    expect(m.metrics.convRate).toBeCloseTo(0.4, 5)
    // 1 次达成率 = 3 / 8 = 0.375
    expect(m.metrics.visitOnceRate).toBeCloseTo(0.375, 5)

    // 门店行带 marketName
    expect(res.byStore[0].marketName).toBe('市场A')
  })

  it('明细派生防除零：分母 0 → null', async () => {
    responder.scalarRow = { v: 0, total_count: 0, total_spend: 0 }
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    // retained=0 → 达成率 null
    responder.regActiveRows = [
      { group_id: 'm1', group_name: '市场A', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
      { group_id: 's1', group_name: '门店1', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
    ]
    // member_spend_count=0, new_members=0, traffic_customers=0 → 全 null
    responder.opsRows = [
      { group_id: 'm1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 0, new_spend: 0, traffic_customers: 0, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
      { group_id: 's1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 0, new_spend: 0, traffic_customers: 0, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
    ]

    const res = await getCustomerBoard(PARAMS)
    const m = res.byMarket[0]
    expect(m.metrics.visitOnceRate).toBeNull()
    expect(m.metrics.visitTwiceRate).toBeNull()
    expect(m.metrics.memberAvgTicket).toBeNull()
    expect(m.metrics.newCustomerAvgTicket).toBeNull()
    expect(m.metrics.convRate).toBeNull()
    expect(m.metrics.consumePerVisit).toBeNull()
  })

  /**
   * #284：「分子 > 0 而分母 = 0」是「分子 ⊄ 分母」的**唯一可观测症状**，而 `safeDiv`
   * 会把它静默转成 null → UI 渲染 '--'，与「本期无人可成交」的正常空态**完全同形**，
   * 永远不会有人报障。上一条用例喂的是全零行，覆盖不到这个态。
   *
   * 方案 1c 下该态**不应再从数据库产生**（分母 ② 分支与分子 `newmem` 用逐字相同的
   * JOIN、scope 谓词与日期条件）。这里锁住的是「万一真出现了，装配层不会崩、也不会
   * 算出 Infinity」，同时把「出现即分母漏人」这条判读写进用例名，留给下一个排障的人。
   */
  it('分子 > 0 而分母 = 0（分母漏人的症状态）：convRate → null，不产生 Infinity', async () => {
    responder.scalarRow = { v: 0, total_count: 0, total_spend: 0 }
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    responder.regActiveRows = [
      { group_id: 'm1', group_name: '市场A', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
      { group_id: 's1', group_name: '门店1', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
    ]
    // new_members=3 而 traffic_customers=0 —— 1c 下不可达，出现即分母漏人
    responder.opsRows = [
      { group_id: 'm1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 3, new_spend: 0, traffic_customers: 0, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
      { group_id: 's1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 3, new_spend: 0, traffic_customers: 0, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
    ]

    const res = await getCustomerBoard(PARAMS)
    const m = res.byMarket[0]
    expect(m.metrics.newMembers).toBe(3)
    expect(m.metrics.trafficCustomers).toBe(0)
    expect(m.metrics.convRate).toBeNull()
    expect(Number.isFinite(m.metrics.convRate as number)).toBe(false)
  })

  /**
   * #284 的核心不变量：分子 ⊆ 分母 ⇒ 成交率 ≤ 100%。
   * 上面的用例只验算术（2/5=0.4），验不了这条 —— 分母漏人时 convRate 会静静地跑出 1。
   */
  it('分母 ⊇ 分子时 convRate ≤ 1（成交率上限不变量）', async () => {
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
    ]
    responder.regActiveRows = [
      { group_id: 'm1', group_name: '市场A', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
      { group_id: 's1', group_name: '门店1', market_name: '市场A', registered: 0, retained: 0, visit_once: 0, visit_twice: 0, dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0 },
    ]
    // 全员转化的极端情形：分子 == 分母 → 恰好 1.0，仍须 ≤ 1
    responder.opsRows = [
      { group_id: 'm1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 7, new_spend: 0, traffic_customers: 7, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
      { group_id: 's1', bucket_d: 0, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0, operated_total: 0, member_spend_total: 0, member_spend_count: 0, new_members: 7, new_spend: 0, traffic_customers: 7, traffic_visits: 0, member_visits: 0, project_count: 0, sm_total: 0 },
    ]

    const res = await getCustomerBoard(PARAMS)
    for (const row of [...res.byMarket, ...res.byStore]) {
      const rate = row.metrics.convRate
      expect(rate).not.toBeNull()
      expect(rate as number).toBeLessThanOrEqual(1)
    }
  })

  /**
   * #284：成交率分母必须禁用同比/环比。
   *
   * 分母的两个分支数据深度差 50 个月（① 取自 service_orders，最早 2026-07-08；
   * ② 取自 became_member_at，回溯 2022-08）。基期一旦落在割点前，① 恒空而 ② 仍出数百人，
   * delta 就成了 100% 由 ② 构成的假数 —— 旧口径下这类基期恒 0、deltaPct 抑制成 '--'，
   * 是诚实的「算不出」。
   *
   * ⚠ 本文件其余用例全程 `enabled=false`，这条不变量原本**零覆盖**：把
   * `withComparison(queryTrialFootfall, …, false)` 的 false 改回 enabled、
   * 或删掉 trafficCustomersCell 的显式 null，测试照样全绿（round-1 两个谱系独立点名）。
   */
  it('enabled=true 时成交率分母与成交率都不出同比/环比（其余 KPI 仍出）', async () => {
    ctxState.enabled = true
    responder.scalarRow = { v: 5, total_count: 3, total_spend: 30 }

    const res = await getCustomerBoard(PARAMS)

    // 分母与派生率：显式 null（前端渲染 '--'），不是字段缺失
    for (const key of ['trafficCustomers', 'convRate']) {
      expect(res.kpis[key], `${key} 应存在`).toBeDefined()
      expect(res.kpis[key].mom, `${key}.mom 必须为 null（割点前基期会算出假数）`).toBeNull()
      expect(res.kpis[key].yoy, `${key}.yoy 必须为 null（割点前基期会算出假数）`).toBeNull()
    }
    // 对照：允许比较的 KPI 仍然带出**数值**，证明 enabled=true 这条路径确实被走到了。
    // ⚠ 用 toBeTypeOf 而不是 not.toBeNull()：后者对 undefined 也通过，证明不了「仍出数值」
    expect(res.kpis.newMembers.mom, 'newMembers 的同比环比不该被一起禁掉').toBeTypeOf('number')
  })

  /**
   * #284：分母是「根本不算」基期，不是「算了再置 null」（round-2 codex P2）。
   *
   * 上一条用例只检查最终对象里 mom/yoy 为 null。若把 `withComparison(..., false)` 的
   * `false` 改回 `enabled`，`withComparison` 会照常跑 previous + lastYear 两次查询，
   * 随后 `trafficCustomersCell` 再把 mom/yoy 覆盖成 null —— 结果对，但那条重型
   * `COUNT(DISTINCT … UNION …)` 从 1 次放大到 3 次，而上一条用例照样绿。
   *
   * 这里直接数分母 SQL 的实际执行次数，锁住注释声称的「不算」。
   */
  it('enabled=true 时分母 SQL 只执行一次（不跑基期查询，避免重型 UNION 放大 3 倍）', async () => {
    ctxState.enabled = true
    responder.scalarRow = { v: 5, total_count: 3, total_spend: 30 }
    // ⚠ mock.calls 跨用例累积（本文件的 beforeEach 只重置 responder，不清 mock），
    // 不先清就会把前面所有用例的调用一起数进来。mockClear 只清 calls、保留 implementation。
    vi.mocked(db.execute).mockClear()

    await getCustomerBoard(PARAMS)

    const executes = vi.mocked(db.execute).mock.calls
    const denomCalls = executes.filter(([q]) => /COUNT\(DISTINCT\s+t\.uid\)/.test(sqlText(q)))
    expect(denomCalls, '分母 SQL 一次都没跑？mock 路由或 SQL 特征串已变').not.toHaveLength(0)
    expect(
      denomCalls,
      `分母 SQL 跑了 ${denomCalls.length} 次 —— enabled=true 下它应只算当期，不算 previous/lastYear`,
    ).toHaveLength(1)

    // ⚠ 这里**不加**「对照组 KPI 跑了 3 次」那种断言：能匹配到的正则
    // （`FROM client_wechat_users c WHERE` + `COUNT(*)`）会同时命中 queryRegistration 与
    // queryNewMemberCount 的多次调用，而 `> 1` 这个阈值在 enabled=false 时也满足 ——
    // 它证不了「enabled=true 已生效」这件它声称要证的事（round-3 DeepSeek P3）。
    // enabled 传播失效这条由上一个用例的 `newMembers.mom` toBeTypeOf('number') 兜住
    // （enabled=false 时该字段是 undefined，直接红）。
  })

  it('市场消费经营直接使用市场内去重结果，不累加跨店顾客', async () => {
    responder.skeletonRows = [
      { market_id: 'm1', market_name: '市场A', store_id: 's1', store_name: '门店1' },
      { market_id: 'm1', market_name: '市场A', store_id: 's2', store_name: '门店2' },
    ]
    const reg = {
      registered: 0, retained: 0, visit_once: 0, visit_twice: 0,
      dormant: 0, react_dormant: 0, frozen: 0, react_frozen: 0, deep: 0, react_deep: 0,
    }
    responder.regActiveRows = [
      { group_id: 'm1', ...reg },
      { group_id: 's1', ...reg },
      { group_id: 's2', ...reg },
    ]
    // 两店各有同一顾客：市场聚合 SQL 已先去重，市场行不能变成门店行之和。
    const byStore = {
      bucket_d: 1, bucket_c: 0, bucket_b: 0, bucket_a: 0, bucket_v: 0, bucket_vic: 0,
      operated_total: 0, member_spend_total: 1000, member_spend_count: 1,
      new_members: 0, new_spend: 0, traffic_customers: 1, traffic_visits: 1,
      member_visits: 0, project_count: 0, sm_total: 0, service_count: 1,
    }
    responder.opsRows = [
      {
        group_id: 'm1',
        ...byStore,
        member_spend_total: 2000,
        traffic_customers: 1,
        traffic_visits: 2,
        service_count: 2,
      },
      { group_id: 's1', ...byStore },
      { group_id: 's2', ...byStore },
    ]

    const res = await getCustomerBoard(PARAMS)
    const market = res.byMarket.find((row) => row.groupId === 'm1')!

    expect(market.metrics.bucketD).toBe(1)
    expect(market.metrics.trafficCustomers).toBe(1)
    expect(market.metrics.trafficVisits).toBe(2)
    expect(market.metrics.memberAvgTicket).toBe(2000)
  })
})
