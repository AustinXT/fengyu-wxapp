import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, mockGetSession } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockGetSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: mockDb }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { listInventorySettlements } from './settlements'

function session(input: {
  role: string
  scopeId: string
  scopeType: '总部' | '市场' | '门店'
  actions: string[]
  scopeOrgNodeIds?: string[]
}) {
  return {
    employeeId: 'E-TEST',
    name: '测试员工',
    phone: '13800000000',
    roles: [{
      role: input.role,
      scopeId: input.scopeId,
      scopeType: input.scopeType,
      scopeStoreIds: [],
      scopeOrgNodeIds: input.scopeOrgNodeIds ?? [input.scopeId],
      actions: input.actions,
    }],
    permissions: {
      actions: input.actions,
      scopeStoreIds: [],
      scopeOrgNodeIds: input.scopeOrgNodeIds ?? [input.scopeId],
    },
  } as never
}

const SUPPLY_CHAIN_SESSION = session({
  role: 'inventory_supply_chain_operator',
  scopeId: 'HQ',
  scopeType: '总部',
  actions: ['inventory:list', 'inventory:supply_chain_price_view'],
})

const MARKET_SESSION = session({
  role: 'inventory_market_finance',
  scopeId: 'M1',
  scopeType: '市场',
  actions: ['inventory:list', 'inventory:market_price_view'],
  scopeOrgNodeIds: ['M1', 'S1', 'S2'],
})

const STORE_SESSION = session({
  role: 'inventory_store_operator',
  scopeId: 'S1',
  scopeType: '门店',
  actions: ['inventory:list', 'inventory:store_operate'],
})

function groupedSelect(rows: unknown[], sink?: { where?: unknown }) {
  return {
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: (condition: unknown) => {
            if (sink) sink.where = condition
            return {
              groupBy: () => ({
                orderBy: async () => rows,
              }),
            }
          },
        }),
      }),
    }),
  }
}

/** 递归遍历 Drizzle 条件对象，断言参数/片段是否出现（与 engine.test.ts 同构）。 */
function sqlContains(query: unknown, fragment: string): boolean {
  const seen = new Set<object>()
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(fragment)
    if (!value || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(visit)
    return Object.values(value as Record<string, unknown>).some(visit)
  }
  return visit(query)
}

describe('货款结算只读报表', () => {
  beforeEach(() => {
    // resetAllMocks 连 mockReturnValue 一并清除，防止上个用例的查询实现泄漏到「不应触发查询」的用例。
    vi.resetAllMocks()
  })

  it('门店价格档（none）不返回任何金额字段且不触发查询', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(false)
    expect(report.canViewStoreSettlement).toBe(false)
    expect(report.marketRows).toEqual([])
    expect(report.storeRows).toEqual([])
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('供应链价格档只见市场结算，不见门店结算', async () => {
    mockGetSession.mockResolvedValue(SUPPLY_CHAIN_SESSION)
    const sink: { where?: unknown } = {}
    mockDb.select.mockReturnValue(groupedSelect([
      {
        sourceOrgNodeId: 'M1',
        sourceOrgNodeName: '南昌市场',
        targetOrgNodeId: 'HQ',
        targetOrgNodeName: '供应链总部',
        docCount: 2,
        totalQuantity: '30.00',
        payableAmount: '1234.50',
      },
    ], sink))

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(false)
    // where 条件不许放宽：单据类型 + 状态白名单 + 日期范围 + scope 双端点。
    expect(sqlContains(sink.where, '市场报货')).toBe(true)
    expect(sqlContains(sink.where, '已完成')).toBe(true)
    expect(sqlContains(sink.where, '2026-09-01')).toBe(true)
    expect(sqlContains(sink.where, '2026-09-02')).toBe(true)
    expect(sqlContains(sink.where, 'source_org_node_id')).toBe(true)
    expect(sqlContains(sink.where, 'target_org_node_id')).toBe(true)
    expect(sqlContains(sink.where, 'HQ')).toBe(true)
    // 供应链总部 scope 不下钻：条件中不得出现任何市场/门店节点。
    expect(sqlContains(sink.where, 'M1')).toBe(false)
    expect(report.marketRows).toEqual([
      {
        sourceOrgNodeId: 'M1',
        sourceOrgNodeName: '南昌市场',
        targetOrgNodeId: 'HQ',
        targetOrgNodeName: '供应链总部',
        docCount: 2,
        totalQuantity: 30,
        payableAmount: 1234.5,
      },
    ])
    expect(report.storeRows).toEqual([])
    // 只发起市场结算一条聚合查询，门店结算不落库查询。
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  it('市场价格档同时汇总市场结算与门店结算', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    const marketSink: { where?: unknown } = {}
    const storeSink: { where?: unknown } = {}
    mockDb.select
      .mockReturnValueOnce(groupedSelect([
        {
          sourceOrgNodeId: 'M1',
          sourceOrgNodeName: '南昌市场',
          targetOrgNodeId: 'HQ',
          targetOrgNodeName: '供应链总部',
          docCount: 1,
          totalQuantity: '10.00',
          payableAmount: '500.00',
        },
      ], marketSink))
      .mockReturnValueOnce(groupedSelect([
        {
          sourceOrgNodeId: 'M1',
          sourceOrgNodeName: '南昌市场',
          targetOrgNodeId: 'S1',
          targetOrgNodeName: '红谷滩店',
          docCount: 3,
          totalQuantity: '12.00',
          payableAmount: '888.00',
        },
      ], storeSink))

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(true)
    // 市场段：市场报货 + 已完成白名单；分院段：分院配货 + 待收货/已完成两态。
    expect(sqlContains(marketSink.where, '市场报货')).toBe(true)
    expect(sqlContains(marketSink.where, '已完成')).toBe(true)
    expect(sqlContains(storeSink.where, '分院配货')).toBe(true)
    expect(sqlContains(storeSink.where, '待收货')).toBe(true)
    expect(sqlContains(storeSink.where, '已完成')).toBe(true)
    // 两段都必须带日期范围与本市场 scope（含门店节点），双端点任一命中。
    for (const sink of [marketSink, storeSink]) {
      expect(sqlContains(sink.where, '2026-09-01')).toBe(true)
      expect(sqlContains(sink.where, '2026-09-02')).toBe(true)
      expect(sqlContains(sink.where, 'source_org_node_id')).toBe(true)
      expect(sqlContains(sink.where, 'target_org_node_id')).toBe(true)
      expect(sqlContains(sink.where, 'M1')).toBe(true)
      expect(sqlContains(sink.where, 'S1')).toBe(true)
      expect(sqlContains(sink.where, 'S2')).toBe(true)
    }
    expect(report.marketRows[0].payableAmount).toBe(500)
    expect(report.storeRows[0]).toMatchObject({
      targetOrgNodeId: 'S1',
      targetOrgNodeName: '红谷滩店',
      docCount: 3,
      totalQuantity: 12,
      payableAmount: 888,
    })
    expect(mockDb.select).toHaveBeenCalledTimes(2)
  })

  it('说明.md §9.3 回归：混合绑定不得借市场 B 价格权汇总门店 A 所在市场货款', async () => {
    // 市场 B 绑库存财务（market_price_view）+ 门店 A 绑门店库存员（无价格权）。
    mockGetSession.mockResolvedValue({
      employeeId: 'E-MIX',
      name: '混合绑定员工',
      phone: '13800000001',
      roles: [{
        role: 'inventory_market_finance', scopeId: 'MKT-B', scopeType: '市场',
        actions: ['inventory:list', 'inventory:market_price_view'],
        scopeStoreIds: ['STORE-B1'],
        scopeOrgNodeIds: ['MKT-B', 'NODE-B1'],
      }, {
        role: 'inventory_store_operator', scopeId: 'NODE-A1', scopeType: '门店',
        actions: ['inventory:list', 'inventory:store_operate'],
        scopeStoreIds: ['STORE-A1'],
        scopeOrgNodeIds: ['NODE-A1'],
      }],
      permissions: {
        actions: ['inventory:list', 'inventory:market_price_view', 'inventory:store_operate'],
        scopeStoreIds: ['STORE-B1', 'STORE-A1'],
        scopeOrgNodeIds: ['MKT-B', 'NODE-B1', 'NODE-A1'],
      },
    } as never)
    const marketSink: { where?: unknown } = {}
    const storeSink: { where?: unknown } = {}
    mockDb.select
      .mockReturnValueOnce(groupedSelect([], marketSink))
      .mockReturnValueOnce(groupedSelect([], storeSink))

    await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    // 两段结算查询的 scope 都必须收敛到市场 B 绑定覆盖的 org；
    // 门店 A 节点绝不允许进入金额聚合条件（整行即金额）。
    for (const sink of [marketSink, storeSink]) {
      expect(sqlContains(sink.where, 'MKT-B')).toBe(true)
      expect(sqlContains(sink.where, 'NODE-B1')).toBe(true)
      expect(sqlContains(sink.where, 'NODE-A1')).toBe(false)
      expect(sqlContains(sink.where, 'STORE-A1')).toBe(false)
    }
  })

  it('scope 为空的会话不触发查询直接返回空行', async () => {
    // 无任何角色绑定但持有动作（历史/导出兼容会话）：org 节点范围为空，fail-closed。
    mockGetSession.mockResolvedValue({
      employeeId: 'E-EMPTY',
      name: '空范围会话',
      phone: '13800000002',
      roles: [],
      permissions: {
        actions: ['inventory:list', 'inventory:market_price_view'],
        scopeStoreIds: [],
        scopeOrgNodeIds: [],
      },
    } as never)

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.marketRows).toEqual([])
    expect(report.storeRows).toEqual([])
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('日期非法或起止倒挂抛 INVALID_PARAMS', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)

    await expect(listInventorySettlements({ startDate: '2026/09/01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算期间日期格式必须为 YYYY-MM-DD')
    await expect(listInventorySettlements({ startDate: '2026-09-02', endDate: '2026-09-01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不能晚于结束日期')
    expect(mockDb.select).not.toHaveBeenCalled()
  })
  it('F6：形状合法但日历非法的日期在入口抛 INVALID_PARAMS，不打到 PG（22008）', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)

    // 月末越界：2 月没有 31 号。
    await expect(listInventorySettlements({ startDate: '2026-02-31' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不是有效的日历日期')
    // 非闰年没有 2 月 29 号；结束日期同样校验。
    await expect(listInventorySettlements({ startDate: '2026-02-01', endDate: '2026-02-29' }))
      .rejects.toThrow('INVALID_PARAMS: 结算结束日期不是有效的日历日期')
    // 4 月只有 30 天 / 月份越界。
    await expect(listInventorySettlements({ startDate: '2026-04-31' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不是有效的日历日期')
    await expect(listInventorySettlements({ startDate: '2026-13-01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不是有效的日历日期')
    // year zero：toISOString 回写比对拦不住，PG date 不接受 0000 年（22008）。
    await expect(listInventorySettlements({ startDate: '0000-01-01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不是有效的日历日期')
    expect(mockDb.select).not.toHaveBeenCalled()

    // 闰年 2 月 29 号是合法日期，正常放行到查询。
    mockDb.select.mockReturnValue(groupedSelect([]))
    const report = await listInventorySettlements({ startDate: '2024-02-29', endDate: '2024-03-01' })
    expect(report.startDate).toBe('2024-02-29')
    expect(mockDb.select).toHaveBeenCalled()
  })

})
