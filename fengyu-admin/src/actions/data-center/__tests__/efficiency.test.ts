/**
 * getEfficiencyBoard 装配逻辑单测
 *
 * 关注点（非 SQL 正确性，SQL 由 consistency 测试 + e2e 守护）：
 *   1. kpis 键齐全（7 项人均派生）且单位正确；分母=0 → null
 *   2. byMarket 结构正确（按市场聚合 + 各项人均）
 *   3. storeRankings / staffRankings 各 metric 键存在
 *   4. assignRanks 并列跳号语义（[100,100,50] → 1/1/3）
 *
 * Mock 策略（仿 sales.test.ts / dashboard.test.ts）：
 *   - @/db.execute：按"调用顺序队列"返回（无 withComparison，每个查询恰跑一次，顺序确定）
 *   - drizzle-orm.sql：no-op（不参与逻辑）
 *   - @/lib/permissions / @/lib/auth：放行 withPermission 包装
 *   - @/lib/data-center/{context,scope-sql}：mock 成固定 ctx / no-op 片段
 *
 * db.execute 调用顺序（与 efficiency.ts Promise.all 顺序一致）：
 *   Part A（0-8）：revenueTotal / consumeTotal / salesCommTotal / serviceCommTotal /
 *                 footfallTotal / projectCountTotal / memberCount / technicianCount / managerCount
 *   Part B（9-19）：skeleton / managerByStore / techByStore / **techDirectByMarket** /
 *                 revenueByStore / consumeByStore / shengmeiConsumeByStore /
 *                 salesCommByStore / serviceCommByStore / footfallByMarket / projectByStore
 *   Part C（20-24）：storeRank revenue / consume / retainedMember / newMember / projectCount
 *   Part D（25-29）：staffRank revenue / consume / newMember / projectCount / income
 *   Part E（30）：staffDetail
 *
 * ⚠️ 本 mock 按**位置**喂数据，往 Promise.all 里插一条查询就会让其后全部错位。
 * #285 加 techDirectByMarket 时实测打翻了 5 条用例。`setupQueue` 末尾的长度断言
 * 就是为此加的：队列长度与 efficiency.ts 的实际查询数对不上时**立即报错**，
 * 而不是让错位静默地把断言变成测另一个查询的结果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})), join: vi.fn(() => ({})) }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isAdminScope: vi.fn(() => true),
}))

vi.mock('@/lib/data-center/scope-sql', () => ({
  scopeFilterSql: vi.fn(() => ({})),
  scopeStoreSkeletonSql: vi.fn(() => ({})),
  // 2026-09-03 产能员工池放宽：无门店（直挂组织节点）员工分支的可见性片段
  orgAnchorScopeSql: vi.fn(() => ({})),
}))

const mockCtx = {
  scope: { type: 'all' as const },
  meta: {
    scope: { type: 'all' as const, id: null, name: '全部' },
    timeRange: { start: '2026-05-01', end: '2026-05-26', presetLabel: '本月' },
  },
  comparison: {
    current: { start: '2026-05-01', end: '2026-05-26' },
    previous: null,
    lastYear: null,
  },
  enabled: false,
}

vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: vi.fn(),
}))

import { getEfficiencyBoard } from '../efficiency'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { prepareBoardContext } from '@/lib/data-center/context'

/** 单标量行包装 */
const v = (n: number) => [{ v: n }]

/**
 * 按"调用顺序"配置 db.execute 返回值（共 `EXPECTED_QUERY_COUNT` 次）。
 * @param opts.scalars Part A 9 个标量（默认全 0）
 * @param opts.skeleton Part B 骨架行
 * @param opts.detail   Part B **10** 个明细行表
 *   （manager / tech-by-store / **tech-direct-by-market** / rev / cons / shengmeiCons /
 *    salesComm / serviceComm / marketFootfall / project）
 * @param opts.storeRanks Part C 5 个门店榜行表
 * @param opts.staffRanks Part D 5 个员工榜行表
 * @param opts.staffDetail Part E 按技师人效明细行表
 */
function setupQueue(opts: {
  scalars?: number[]
  skeleton?: Array<Record<string, unknown>>
  detail?: Array<Array<Record<string, unknown>>>
  storeRanks?: Array<Array<Record<string, unknown>>>
  staffRanks?: Array<Array<Record<string, unknown>>>
  staffDetail?: Array<Record<string, unknown>>
}) {
  const scalars = opts.scalars ?? [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const skeleton = opts.skeleton ?? []
  const detail = opts.detail ?? [[], [], [], [], [], [], [], [], [], []]
  const storeRanks = opts.storeRanks ?? [[], [], [], [], []]
  const staffRanks = opts.staffRanks ?? [[], [], [], [], []]
  const staffDetail = opts.staffDetail ?? []

  // 位置喂数的前提：每段长度必须与 efficiency.ts 对得上。对不上就在这里炸，
  // 别让它一路错位到断言里（#285 实测：插一条查询会静默打翻 5 条用例）。
  expect(scalars, 'Part A 标量数').toHaveLength(9)
  expect(detail, 'Part B 明细表数（含 techDirectByMarket）').toHaveLength(10)
  expect(storeRanks, 'Part C 门店榜数').toHaveLength(5)
  expect(staffRanks, 'Part D 员工榜数').toHaveLength(5)

  const queue: unknown[] = [
    ...scalars.map((n) => v(n)),
    skeleton,
    ...detail,
    ...storeRanks,
    ...staffRanks,
    staffDetail, // Part E：#285 之前根本没有这一槽，第 31 次调用被 `?? []` 静默吞掉
  ]
  // 队列总长必须等于 efficiency.ts 的 db.execute 调用数。`?? []` 的兜底会把「少一槽」
  // 伪装成「查询返回空」——那正是 Part E 长期零覆盖却没人发现的原因。
  expect(queue, 'mock 队列总长必须等于 efficiency.ts 的查询数').toHaveLength(EXPECTED_QUERY_COUNT)
  let i = 0
  ;(db.execute as any).mockImplementation(() => Promise.resolve(queue[i++] ?? []))
}

/**
 * `efficiency.ts` 的 `Promise.all` 元素个数。
 * 改了那边的查询数就要同步改这里 —— 下面的 `assertAllQueriesConsumed` 会把不一致炸出来，
 * 而不是让位置 mock 静默错位（#285 加 qTechDirectByMarket 时实测打翻 5 条用例）。
 */
const EXPECTED_QUERY_COUNT = 31

/** 断言生产代码确实把队列**全部**消费掉了，既不多也不少 */
function assertAllQueriesConsumed() {
  expect(
    (db.execute as any).mock.calls.length,
    'db.execute 调用数与 mock 队列长度不符：Promise.all 里增删了查询',
  ).toBe(EXPECTED_QUERY_COUNT)
}

function mockSessionOk() {
  ;(getSession as any).mockResolvedValue({
    employeeId: 'ADMIN-001',
    name: 'admin',
    phone: '13800000000',
    roles: [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
    permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] },
  })
}

const baseParams = {
  scope: { type: 'all' as const },
  timeRange: { preset: 'month' as const },
  withComparison: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSessionOk()
  ;(prepareBoardContext as any).mockResolvedValue(mockCtx)
})

describe('getEfficiencyBoard — KPI 人均派生装配', () => {
  // 范围内有门店才算技师人均（#423）；空骨架 = 无门店范围，人均一律 null，见 no-store-per-capita.test.ts
  const oneStore = [{ store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' }]

  it('kpis 含全部 7 个键且单位正确', async () => {
    setupQueue({})
    const res = await getEfficiencyBoard(baseParams)
    // 顺带把「生产代码的查询数 == mock 队列长度」钉死：位置喂数的前提就是这个等式。
    assertAllQueriesConsumed()
    expect(Object.keys(res.kpis).sort()).toEqual(
      [
        'managerAvgMembers',
        'managerAvgEmployees',
        'empAvgRevenue',
        'empAvgConsume',
        'empAvgIncome',
        'empAvgMembers',
        'empAvgProjects',
      ].sort(),
    )
    expect(res.kpis.empAvgRevenue.unit).toBe('amount')
    expect(res.kpis.empAvgConsume.unit).toBe('amount')
    expect(res.kpis.empAvgIncome.unit).toBe('amount')
    expect(res.kpis.empAvgMembers.unit).toBe('count')
    expect(res.kpis.empAvgProjects.unit).toBe('count')
    expect(res.kpis.managerAvgMembers.unit).toBe('count')
    expect(res.kpis.managerAvgEmployees.unit).toBe('count')
  })

  it('人均派生 = 分子 / 分母（员工=技师数、店长=managerCount）', async () => {
    // scalars: revenue=2000 consume=1500 salesComm=300 serviceComm=200
    //          footfall=80 project=400 member=500 tech=10 manager=5
    setupQueue({ scalars: [2000, 1500, 300, 200, 80, 400, 500, 10, 5], skeleton: oneStore })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.kpis.empAvgRevenue.value).toBe(200) // 2000 / 10
    expect(res.kpis.empAvgConsume.value).toBe(150) // 1500 / 10
    expect(res.kpis.empAvgIncome.value).toBe(50) // (300+200) / 10
    expect(res.kpis.empAvgMembers.value).toBe(8) // 80 / 10
    expect(res.kpis.empAvgProjects.value).toBe(40) // 400 / 10
    expect(res.kpis.managerAvgMembers.value).toBe(100) // 500 / 5
    expect(res.kpis.managerAvgEmployees.value).toBe(2) // 10 / 5
  })

  it('分母=0 → 人均派生为 null（前端 "--"）', async () => {
    // tech=0、manager=0
    setupQueue({ scalars: [2000, 1500, 300, 200, 80, 400, 500, 0, 0], skeleton: oneStore })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.kpis.empAvgRevenue.value).toBeNull()
    expect(res.kpis.empAvgProjects.value).toBeNull()
    expect(res.kpis.managerAvgMembers.value).toBeNull()
    expect(res.kpis.managerAvgEmployees.value).toBeNull()
  })

  it('收入 = 销售提成 + 服务提成', async () => {
    setupQueue({ scalars: [0, 0, 700, 300, 0, 0, 0, 10, 0], skeleton: oneStore })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.kpis.empAvgIncome.value).toBe(100) // (700+300)/10
  })

  it('#423 空骨架（无门店范围）：技师人均为 null 而非 0/N=0，noStoreScope=true；店长人均因店长数 0 同为 null', async () => {
    // 门店口径分子恒 0、分母含直挂技师 10 人：修复前 empAvg* 全部是 0
    setupQueue({ scalars: [0, 0, 0, 0, 0, 0, 0, 10, 0] })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.noStoreScope).toBe(true)
    for (const key of ['empAvgRevenue', 'empAvgConsume', 'empAvgIncome', 'empAvgMembers', 'empAvgProjects']) {
      expect(res.kpis[key].value, key).toBeNull()
    }
    expect(res.kpis.managerAvgEmployees.value).toBeNull()
  })

  it('#423 有门店：分子为 0 时人均是 0 不是 null，noStoreScope=false', async () => {
    setupQueue({ scalars: [0, 0, 0, 0, 0, 0, 0, 10, 0], skeleton: oneStore })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.noStoreScope).toBe(false)
    expect(res.kpis.empAvgRevenue.value).toBe(0)
  })
})

describe('getEfficiencyBoard — byMarket 明细装配', () => {
  const skeleton = [
    { store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' },
    { store_id: 'S2', store_name: '门店二', market_id: 'M1', market_name: '市场甲' },
    { store_id: 'S3', store_name: '门店三', market_id: 'M2', market_name: '市场乙' },
  ]

  it('byMarket 含全部 9 个 metric 键（含人均派生）', async () => {
    setupQueue({ skeleton })
    const res = await getEfficiencyBoard(baseParams)
    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!
    expect(Object.keys(m1.metrics).sort()).toEqual(
      [
        'managerCount',
        'managerAvgIncome',
        'technicianCount',
        'techAvgRevenue',
        'techAvgConsume',
        'techAvgShengmeiConsume',
        'techAvgIncome',
        'techAvgMembers',
        'techAvgProjects',
      ].sort(),
    )
  })

  it('按 marketId 聚合：人数求和 + 人均派生正确', async () => {
    setupQueue({
      skeleton,
      detail: [
        [{ store_id: 'S1', v: 1 }, { store_id: 'S2', v: 1 }, { store_id: 'S3', v: 1 }], // manager
        [{ store_id: 'S1', v: 3 }, { store_id: 'S2', v: 2 }, { store_id: 'S3', v: 4 }], // tech
        [], // techDirectByMarket（本用例无直挂技师）
        [{ store_id: 'S1', v: 1000 }, { store_id: 'S2', v: 500 }], // revenue
        [{ store_id: 'S1', v: 800 }], // consume
        [{ store_id: 'S1', v: 200 }], // shengmeiConsume
        [{ store_id: 'S1', v: 150 }, { store_id: 'S2', v: 50 }], // salesComm
        [{ store_id: 'S1', v: 60 }, { store_id: 'S2', v: 40 }], // serviceComm
        [{ market_id: 'M1', v: 30 }], // 市场内去重 footfall
        [{ store_id: 'S1', v: 90 }], // project
      ],
    })
    const res = await getEfficiencyBoard(baseParams)

    const m1 = res.byMarket.find((r) => r.groupId === 'M1')! // S1+S2
    expect(m1.metrics.managerCount).toBe(2) // 1+1
    expect(m1.metrics.technicianCount).toBe(5) // 3+2
    // 市场 income = (150+50)+(60+40) = 300；店长人均收入 = 300/2 = 150
    expect(m1.metrics.managerAvgIncome).toBe(150)
    // 技师人均业绩 = (1000+500)/5 = 300
    expect(m1.metrics.techAvgRevenue).toBe(300)
    // 技师人均实耗 = 800/5 = 160
    expect(m1.metrics.techAvgConsume).toBe(160)
    // 技师人均生美实耗 = 200/5 = 40
    expect(m1.metrics.techAvgShengmeiConsume).toBe(40)
    // 技师人均收入 = 300/5 = 60
    expect(m1.metrics.techAvgIncome).toBe(60)
    // 技师人均会员量(市场内去重客流) = 30/5 = 6
    expect(m1.metrics.techAvgMembers).toBe(6)
    // 技师人均项目数 = 90/5 = 18
    expect(m1.metrics.techAvgProjects).toBe(18)

    const m2 = res.byMarket.find((r) => r.groupId === 'M2')! // S3
    expect(m2.metrics.managerCount).toBe(1)
    expect(m2.metrics.technicianCount).toBe(4)
  })

  it('分母=0（无技师/店长）→ 该市场人均派生为 null', async () => {
    setupQueue({
      skeleton: [{ store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' }],
      detail: [
        [], // manager 0
        [], // tech 0
        [], // techDirectByMarket 0
        [{ store_id: 'S1', v: 1000 }], // revenue
        [], [], [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!
    expect(m1.metrics.managerCount).toBe(0)
    expect(m1.metrics.technicianCount).toBe(0)
    expect(m1.metrics.techAvgRevenue).toBeNull()
    expect(m1.metrics.managerAvgIncome).toBeNull()
  })

  it('同市场跨店到访顾客只计一次客流', async () => {
    setupQueue({
      skeleton: [
        { store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' },
        { store_id: 'S2', store_name: '门店二', market_id: 'M1', market_name: '市场甲' },
      ],
      detail: [
        [{ store_id: 'S1', v: 1 }, { store_id: 'S2', v: 1 }], // manager
        [{ store_id: 'S1', v: 2 }, { store_id: 'S2', v: 2 }], // tech
        [], // techDirectByMarket
        [], [], [], [], [],
        // 两门店客流如果相加会是 6；市场查询已去重，返回 4。
        [{ market_id: 'M1', v: 4 }],
        [],
      ],
    })

    const res = await getEfficiencyBoard(baseParams)
    const market = res.byMarket.find((row) => row.groupId === 'M1')!

    expect(market.metrics.technicianCount).toBe(4)
    expect(market.metrics.techAvgMembers).toBe(1)
  })

  // ── 直挂市场/部门的产能技师必须进分母（#285 gate-1 sibling P1）───────────
  //
  // 员工组织归属是双轨的（store_id 门店 FK + org_node_id 组织节点 FK）。生产有 13 名在职
  // 产能技师 store_id IS NULL、直挂市场或部门节点，他们的产出落在门店上、计入分子，
  // 人头却被只按 store_id 过滤的分母整体剔除 → 集团大卡虚高 +9.33%、南昌凤御 +13.8%。

  it('直挂市场的技师并入该市场分母，且只加一次（不按门店数重复累加）', async () => {
    setupQueue({
      skeleton: [
        { store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' },
        { store_id: 'S2', store_name: '门店二', market_id: 'M1', market_name: '市场甲' },
      ],
      detail: [
        [], // manager
        [{ store_id: 'S1', v: 3 }, { store_id: 'S2', v: 2 }], // tech by store = 5
        [{ market_id: 'M1', market_name: '市场甲', v: 4 }], // 直挂 4 人
        [{ store_id: 'S1', v: 900 }], // revenue
        [], [], [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!

    // 5 + 4 = 9。若在门店循环内累加，M1 有两个门店会变成 5 + 4×2 = 13。
    expect(m1.metrics.technicianCount).toBe(9)
    expect(m1.metrics.techAvgRevenue).toBe(100) // 900 / 9
  })

  it('市场下一个门店都没有时（如「品项公司」）仍凭直挂技师出行', async () => {
    setupQueue({
      skeleton: [{ store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' }],
      detail: [
        [], // manager
        [{ store_id: 'S1', v: 2 }], // tech by store
        [{ market_id: 'M9', market_name: '品项公司', v: 1 }], // 该市场无任何门店
        [], [], [], [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)

    // 门店骨架里没有 M9，只能由直挂技师那一步补出行
    const m9 = res.byMarket.find((r) => r.groupId === 'M9')
    expect(m9, '无门店的市场应凭直挂技师出现在 byMarket').toBeDefined()
    expect(m9!.groupName).toBe('品项公司')
    expect(m9!.metrics.technicianCount).toBe(1)
    // #423：无门店市场的门店口径分子恒 0，技师人均不适用 → null（前端「--」），不再是 0 / 1 = 0
    expect(m9!.metrics.techAvgRevenue).toBeNull()
    expect(res.noStoreMarkets).toEqual(['品项公司'])
    // 同页有门店的市场照常计算（M1 业绩 0 → 人均 0）
    expect(res.byMarket.find((r) => r.groupId === 'M1')!.metrics.techAvgRevenue).toBe(0)
  })

  it('直挂行 market_id 为 null 时跳过，不产生空 groupId 的市场行', async () => {
    setupQueue({
      skeleton: [{ store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' }],
      detail: [
        [],
        [{ store_id: 'S1', v: 2 }],
        [{ market_id: null, market_name: null, v: 7 }], // 锚不到市场的脏行
        [], [], [], [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.byMarket.map((r) => r.groupId)).toEqual(['M1'])
    expect(res.byMarket[0].metrics.technicianCount).toBe(2) // 那 7 人没被算进任何市场
  })

  it('空骨架 → byMarket 为空数组', async () => {
    setupQueue({ skeleton: [] })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.byMarket).toEqual([])
  })
})

describe('getEfficiencyBoard — 排名榜装配 + assignRanks 并列跳号', () => {
  it('⭐ 门店排行榜不截断：12 行进 → 12 行出（防将来加 Top N 截断）', async () => {
    // 闸门 2 收敛轮 codex：给排行榜加 `LIMIT 10` 是极常见的首屏优化，
    // 会让「排行榜合计 == KPI 分子」失效。SQL 侧由 consistency 测试禁 LIMIT/OFFSET 拦；
    // 这条拦 JS 侧的同型风险（`.slice(0, 10)`）—— 用 12 行刻意超过常见的 Top 10。
    const rows = Array.from({ length: 12 }, (_, k) => ({
      store_id: `S${k + 1}`,
      store_name: `门店${k + 1}`,
      market_name: '市场甲',
      value: 1200 - k * 100,
    }))
    setupQueue({ storeRanks: [rows, [], [], [], []] })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.storeRankings.revenue).toHaveLength(12)
    expect(res.storeRankings.revenue.at(-1)).toMatchObject({ id: 'S12', rank: 12 })
  })

  it('storeRankings / staffRankings 各 metric 键存在', async () => {
    setupQueue({})
    const res = await getEfficiencyBoard(baseParams)
    expect(Object.keys(res.storeRankings).sort()).toEqual(
      ['revenue', 'consume', 'retainedMember', 'newMember', 'projectCount'].sort(),
    )
    expect(Object.keys(res.staffRankings).sort()).toEqual(
      ['revenue', 'consume', 'newMember', 'projectCount', 'income'].sort(),
    )
  })

  it('门店榜：rank/id/name/marketName/value 映射 + 并列跳号 [100,100,50]→1/1/3', async () => {
    setupQueue({
      storeRanks: [
        [
          { store_id: 'S1', store_name: '门店一', market_name: '市场甲', value: 100 },
          { store_id: 'S2', store_name: '门店二', market_name: '市场甲', value: 100 },
          { store_id: 'S3', store_name: '门店三', market_name: '市场乙', value: 50 },
        ], // revenue
        [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    const rev = res.storeRankings.revenue
    expect(rev).toHaveLength(3)
    expect(rev.map((r) => r.rank)).toEqual([1, 1, 3]) // 并列跳号
    expect(rev[0]).toMatchObject({ id: 'S1', name: '门店一', marketName: '市场甲', value: 100 })
    expect(rev[2]).toMatchObject({ id: 'S3', name: '门店三', marketName: '市场乙', value: 50 })
  })

  it('员工榜：id=employeeId、name=employeeName、marketName=市场名、value', async () => {
    setupQueue({
      staffRanks: [
        [
          { employee_id: 'E1', employee_name: '张三', store_name: '门店一', market_name: '市场甲', value: 300 },
          { employee_id: 'E2', employee_name: '李四', store_name: '门店二', market_name: '市场乙', value: 200 },
        ], // revenue
        [], [], [], [],
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    const rev = res.staffRankings.revenue
    expect(rev).toHaveLength(2)
    expect(rev.map((r) => r.rank)).toEqual([1, 2])
    expect(rev[0]).toMatchObject({ id: 'E1', name: '张三', marketName: '市场甲', value: 300 })
    expect(rev[1]).toMatchObject({ id: 'E2', name: '李四', marketName: '市场乙', value: 200 })
  })

  it('员工榜 income 走第 5 个员工榜槽位（顺序正确）', async () => {
    setupQueue({
      staffRanks: [
        [], [], [], [],
        [{ employee_id: 'E9', employee_name: '王五', store_name: '门店九', market_name: '市场丙', value: 999 }], // income
      ],
    })
    const res = await getEfficiencyBoard(baseParams)
    expect(res.staffRankings.income[0]).toMatchObject({ id: 'E9', value: 999 })
    expect(res.staffRankings.revenue).toEqual([])
  })

  it('空行表 → 排名榜为空数组', async () => {
    setupQueue({})
    const res = await getEfficiencyBoard(baseParams)
    expect(res.storeRankings.revenue).toEqual([])
    expect(res.staffRankings.income).toEqual([])
  })
})

describe('getEfficiencyBoard — meta 透传', () => {
  it('meta 来自 ctx（scope/timeRange 透传）', async () => {
    setupQueue({})
    const res = await getEfficiencyBoard(baseParams)
    expect(res.scope).toEqual(mockCtx.meta.scope)
    expect(res.timeRange).toEqual(mockCtx.meta.timeRange)
  })
})
