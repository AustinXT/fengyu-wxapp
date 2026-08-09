/**
 * getSalesBoard 装配逻辑单测
 *
 * 关注点（非 SQL 正确性，SQL 由 consistency 测试 + e2e 守护）：
 *   1. kpis 键齐全（11 项）且单位正确
 *   2. byMarket / byStore 结构正确（groupId/groupName/metrics 键、市场聚合）
 *   3. 店均派生（门店数=0 → null）
 *   4. scope=store 停用门店返回 0，店均不除以 1
 *
 * Mock 策略（仿 dashboard.test.ts / permissions.test.ts）：
 *   - @/db.execute：按"调用顺序队列"返回（disable comparison 让每个 KPI 只跑一次，顺序确定）
 *   - drizzle-orm.sql：no-op（不参与逻辑）
 *   - @/lib/data-center/context.prepareBoardContext：返回固定 ctx（enabled=false）
 *   - @/lib/auth + @/lib/permissions：放行 withPermission 包装
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
  // sales.ts → scope-sql.ts 间接 import isAdminScope；这里给个放行实现
  isAdminScope: vi.fn(() => true),
}))

// scope-sql 真实模块依赖 isAdminScope（已 mock），sql（已 mock）→ 可直接走真实实现，
// 但为隔离装配逻辑，干脆把 scope-sql 也 mock 成 no-op 片段。
vi.mock('@/lib/data-center/scope-sql', () => ({
  scopeFilterSql: vi.fn(() => ({})),
  scopeStoreSkeletonSql: vi.fn(() => ({})),
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
  enabled: false, // 关同比环比 → 每个 KPI 只跑一次，db.execute 调用顺序确定
}

vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: vi.fn(),
}))

import { getSalesBoard } from '../sales'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { prepareBoardContext } from '@/lib/data-center/context'

/**
 * 按"调用顺序"配置 db.execute 返回值。
 * sales.ts 调用顺序（enabled=false）：
 *   KPI 0: storeRevenue
 *   KPI 1: shengmeiRevenue
 *   KPI 2: storeConsume
 *   KPI 3: shengmeiConsume
 *   KPI 4: newCustomerRevenue
 *   KPI 5: trafficCustomerRevenue
 *   KPI 6: storeCount
 *   KPI 7: employeeCount
 *   明细 8: skeleton
 *   明细 9: technicianCount
 *   明细 10: storeRevenue(byStore)
 *   明细 11: shengmeiRevenue
 *   明细 12: newCustomerRevenue
 *   明细 13: trafficCustomerRevenue
 *   明细 14: storeConsume
 *   明细 15: shengmeiConsume
 */
function setupExecuteQueue(opts: {
  kpis?: number[] // 8 个标量值（默认全 100）
  skeleton?: Array<Record<string, unknown>>
  detailMaps?: Array<Array<Record<string, unknown>>> // 7 个明细行表（tech + 6 业绩）
}) {
  const kpiVals = opts.kpis ?? [1000, 200, 800, 150, 300, 500, 5, 12]
  const skeleton = opts.skeleton ?? []
  const detail = opts.detailMaps ?? [[], [], [], [], [], [], []]

  const queue: unknown[] = [
    ...kpiVals.map((v) => [{ v }]),
    skeleton,
    ...detail,
  ]
  let i = 0
  ;(db.execute as any).mockImplementation(() => Promise.resolve(queue[i++] ?? []))
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

describe('getSalesBoard — KPI 装配', () => {
  it('kpis 含全部 11 个键且单位正确', async () => {
    setupExecuteQueue({})
    const res = await getSalesBoard(baseParams)

    const expectedKeys = [
      'storeRevenue',
      'shengmeiRevenue',
      'storeConsume',
      'shengmeiConsume',
      'newCustomerRevenue',
      'trafficCustomerRevenue',
      'revenuePerStore',
      'shengmeiRevenuePerStore',
      'consumePerStore',
      'storeCount',
      'employeeCount',
    ]
    expect(Object.keys(res.kpis).sort()).toEqual([...expectedKeys].sort())

    // 金额类 unit=amount，计数类 unit=count
    expect(res.kpis.storeRevenue.unit).toBe('amount')
    expect(res.kpis.shengmeiRevenue.unit).toBe('amount')
    expect(res.kpis.storeCount.unit).toBe('count')
    expect(res.kpis.employeeCount.unit).toBe('count')
  })

  it('KPI 标量值正确映射（storeRevenue=1000、employeeCount=12）', async () => {
    setupExecuteQueue({ kpis: [1000, 200, 800, 150, 300, 500, 5, 12] })
    const res = await getSalesBoard(baseParams)
    expect(res.kpis.storeRevenue.value).toBe(1000)
    expect(res.kpis.shengmeiRevenue.value).toBe(200)
    expect(res.kpis.storeConsume.value).toBe(800)
    expect(res.kpis.newCustomerRevenue.value).toBe(300)
    expect(res.kpis.trafficCustomerRevenue.value).toBe(500)
    expect(res.kpis.storeCount.value).toBe(5)
    expect(res.kpis.employeeCount.value).toBe(12)
  })

  it('店均派生 = 分子 / 门店数（1000/5=200）', async () => {
    setupExecuteQueue({ kpis: [1000, 200, 800, 150, 300, 500, 5, 12] })
    const res = await getSalesBoard(baseParams)
    expect(res.kpis.revenuePerStore.value).toBe(200)
    expect(res.kpis.shengmeiRevenuePerStore.value).toBe(40)
    expect(res.kpis.consumePerStore.value).toBe(160)
    expect(res.kpis.revenuePerStore.unit).toBe('amount')
  })

  it('门店数=0 → 店均派生为 null（前端 "--"）', async () => {
    setupExecuteQueue({ kpis: [1000, 200, 800, 150, 300, 500, 0, 12] })
    const res = await getSalesBoard(baseParams)
    expect(res.kpis.revenuePerStore.value).toBeNull()
    expect(res.kpis.shengmeiRevenuePerStore.value).toBeNull()
    expect(res.kpis.consumePerStore.value).toBeNull()
  })

  it('enabled=false 时 KPI 不带 mom/yoy', async () => {
    setupExecuteQueue({})
    const res = await getSalesBoard(baseParams)
    expect(res.kpis.storeRevenue.mom).toBeUndefined()
    expect(res.kpis.storeRevenue.yoy).toBeUndefined()
  })
})

describe('getSalesBoard — 明细表装配', () => {
  const skeleton = [
    { store_id: 'S1', store_name: '门店一', market_id: 'M1', market_name: '市场甲' },
    { store_id: 'S2', store_name: '门店二', market_id: 'M1', market_name: '市场甲' },
    { store_id: 'S3', store_name: '门店三', market_id: 'M2', market_name: '市场乙' },
  ]

  it('byStore：每个骨架门店出一行，含 7 个 metrics 键 + marketName', async () => {
    setupExecuteQueue({
      skeleton,
      detailMaps: [
        [{ store_id: 'S1', v: 3 }], // tech
        [{ store_id: 'S1', v: 1000 }], // storeRevenue
        [{ store_id: 'S1', v: 200 }], // shengmeiRevenue
        [{ store_id: 'S1', v: 300 }], // newCustomerRevenue
        [{ store_id: 'S1', v: 500 }], // trafficCustomerRevenue
        [{ store_id: 'S1', v: 800 }], // storeConsume
        [{ store_id: 'S1', v: 150 }], // shengmeiConsume
      ],
    })
    const res = await getSalesBoard(baseParams)

    expect(res.byStore).toHaveLength(3)
    const s1 = res.byStore.find((r) => r.groupId === 'S1')!
    expect(s1.groupName).toBe('门店一')
    expect(s1.marketName).toBe('市场甲')
    expect(Object.keys(s1.metrics).sort()).toEqual(
      [
        'technicianCount',
        'storeRevenue',
        'shengmeiRevenue',
        'newCustomerRevenue',
        'trafficCustomerRevenue',
        'storeConsume',
        'shengmeiConsume',
      ].sort(),
    )
    expect(s1.metrics.storeRevenue).toBe(1000)
    expect(s1.metrics.technicianCount).toBe(3)

    // 无业绩门店 → 0（骨架兜底）
    const s2 = res.byStore.find((r) => r.groupId === 'S2')!
    expect(s2.metrics.storeRevenue).toBe(0)
    expect(s2.metrics.technicianCount).toBe(0)
  })

  it('byMarket：按 marketId 聚合，门店数=骨架计数，业绩求和', async () => {
    setupExecuteQueue({
      skeleton,
      detailMaps: [
        [
          { store_id: 'S1', v: 3 },
          { store_id: 'S2', v: 2 },
          { store_id: 'S3', v: 4 },
        ], // tech
        [
          { store_id: 'S1', v: 1000 },
          { store_id: 'S2', v: 500 },
          { store_id: 'S3', v: 700 },
        ], // storeRevenue
        [], // shengmeiRevenue
        [], // newCustomerRevenue
        [], // trafficCustomerRevenue
        [], // storeConsume
        [], // shengmeiConsume
      ],
    })
    const res = await getSalesBoard(baseParams)

    expect(res.byMarket).toHaveLength(2)
    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!
    expect(m1.groupName).toBe('市场甲')
    expect(m1.metrics.storeCount).toBe(2) // S1 + S2
    expect(m1.metrics.technicianCount).toBe(5) // 3 + 2
    expect(m1.metrics.storeRevenue).toBe(1500) // 1000 + 500
    // 市场店均 = 1500 / 2 = 750
    expect(m1.metrics.revenuePerStore).toBe(750)

    const m2 = res.byMarket.find((r) => r.groupId === 'M2')!
    expect(m2.metrics.storeCount).toBe(1)
    expect(m2.metrics.storeRevenue).toBe(700)
    expect(m2.metrics.revenuePerStore).toBe(700)
  })

  it('byMarket 含 12 个 metrics 键（含 4 个店均派生）', async () => {
    setupExecuteQueue({ skeleton })
    const res = await getSalesBoard(baseParams)
    const m1 = res.byMarket.find((r) => r.groupId === 'M1')!
    expect(Object.keys(m1.metrics).sort()).toEqual(
      [
        'storeCount',
        'technicianCount',
        'storeRevenue',
        'shengmeiRevenue',
        'revenuePerStore',
        'shengmeiRevenuePerStore',
        'newCustomerRevenue',
        'trafficCustomerRevenue',
        'storeConsume',
        'shengmeiConsume',
        'consumePerStore',
        'shengmeiConsumePerStore',
      ].sort(),
    )
  })

  it('空骨架 → byMarket/byStore 均为空数组', async () => {
    setupExecuteQueue({ skeleton: [] })
    const res = await getSalesBoard(baseParams)
    expect(res.byStore).toEqual([])
    expect(res.byMarket).toEqual([])
  })
})

describe('getSalesBoard — meta 透传 + scope=store 门店数', () => {
  it('meta 来自 ctx（scope/timeRange 透传）', async () => {
    setupExecuteQueue({})
    const res = await getSalesBoard(baseParams)
    expect(res.scope).toEqual(mockCtx.meta.scope)
    expect(res.timeRange).toEqual(mockCtx.meta.timeRange)
  })

  it('scope=store 时 storeCount=0（停用门店）→ 店均为 null', async () => {
    ;(prepareBoardContext as any).mockResolvedValue({
      ...mockCtx,
      scope: { type: 'store', id: 'S1' },
      meta: { ...mockCtx.meta, scope: { type: 'store', id: 'S1', name: '门店一' } },
    })
    // storeCount 是第 7 个 KPI（index 6）；停用门店的真实 COUNT 应返回 0。
    setupExecuteQueue({ kpis: [1000, 200, 800, 150, 300, 500, 0, 12] })
    const res = await getSalesBoard({ ...baseParams, scope: { type: 'store', id: 'S1' } })
    expect(res.kpis.storeCount.value).toBe(0)
    expect(res.kpis.revenuePerStore.value).toBeNull()
  })
})
