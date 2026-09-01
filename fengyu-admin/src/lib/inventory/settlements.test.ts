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

function groupedSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: async () => rows,
            }),
          }),
        }),
      }),
    }),
  }
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
    ]))

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(false)
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
      ]))
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
      ]))

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(true)
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
})
