import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { execute, mockGetSession } = vi.hoisted(() => ({
  execute: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { listInventorySettlements, normalizeSettlementPeriod, settlementDocKinds, settlementProjectionSql } from './settlements'

const compile = (query: SQL) => new PgDialect().sqlToQuery(query)
/** 第 n 次 execute 的编译结果（语法树 → sql + params）。 */
const callOf = (index: number) => compile(execute.mock.calls[index][0] as SQL)

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

/** 汇总行原始行：numeric 与真 postgres.js 一样是 string。 */
const summaryRow = (over: Record<string, unknown> = {}) => ({
  market_node: 'M1',
  market_name: '南昌市场',
  party_node: 'HQ',
  party_name: '供应链总部',
  doc_count: 2,
  return_doc_count: 0,
  total_quantity: '30.00',
  returned_quantity: '0.00',
  payable_amount: '1234.50',
  ...over,
})

describe('货款结算只读报表', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('门店价格档（none）不返回任何金额字段且不触发查询', async () => {
    mockGetSession.mockResolvedValue(STORE_SESSION)

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(false)
    expect(report.canViewStoreSettlement).toBe(false)
    expect(report.marketRows).toEqual([])
    expect(report.storeRows).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it('供应链价格档只见市场结算，不见门店结算', async () => {
    mockGetSession.mockResolvedValue(SUPPLY_CHAIN_SESSION)
    // 调用 0 = 市场选项（DISTINCT market_id），调用 1 = 市场段聚合
    execute
      .mockResolvedValueOnce([{ id: 'M1', name: '南昌市场' }])
      .mockResolvedValueOnce([summaryRow()])

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(false)
    // 调用序列：0=市场选项，1=市场段聚合；门店段不可见，不落库查询。
    expect(execute).toHaveBeenCalledTimes(2)
    const query = callOf(1)
    // 条件不许放宽：单据类型 + 状态白名单 + 日期区间 + scope 双端点。
    expect(query.params).toContain('市场报货')
    expect(query.params).toContain('已完成')
    expect(query.params).toContain('2026-09-01')
    expect(query.params).toContain('2026-09-02')
    expect(query.sql).toContain('source_org_node_id')
    expect(query.sql).toContain('target_org_node_id')
    expect(query.params).toContain('HQ')
    // 供应链总部 scope 不下钻：条件中不得出现任何市场/门店节点。
    expect(query.params).not.toContain('M1')
    expect(report.marketRows).toEqual([
      {
        sourceOrgNodeId: 'M1',
        sourceOrgNodeName: '南昌市场',
        targetOrgNodeId: 'HQ',
        targetOrgNodeName: '供应链总部',
        docCount: 2,
        returnDocCount: 0,
        totalQuantity: 30,
        returnedQuantity: 0,
        payableAmount: 1234.5,
      },
    ])
    expect(report.storeRows).toEqual([])
  })

  it('市场价格档同时汇总市场结算与门店结算', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    execute
      .mockResolvedValueOnce([{ id: 'M1', name: '南昌市场' }])  // 0 = 市场选项
      .mockResolvedValueOnce([summaryRow({ payable_amount: '500.00', total_quantity: '10.00' })])
      .mockResolvedValueOnce([summaryRow({
        party_node: 'S1', party_name: '红谷滩店', doc_count: 3, total_quantity: '12.00', payable_amount: '888.00',
      })])

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.canViewMarketSettlement).toBe(true)
    expect(report.canViewStoreSettlement).toBe(true)
    // 调用序列：0=市场选项，1=市场段，2=分院段
    expect(execute).toHaveBeenCalledTimes(3)
    const [marketQuery, storeQuery] = [callOf(1), callOf(2)]
    // 市场段：市场报货 + 已完成白名单；分院段：分院配货 + 待收货/已完成两态。
    expect(marketQuery.params).toContain('市场报货')
    expect(marketQuery.params).toContain('已完成')
    expect(storeQuery.params).toContain('分院配货')
    expect(storeQuery.params).toContain('待收货')
    expect(storeQuery.params).toContain('已完成')
    // 两段都必须带日期范围与本市场 scope（含门店节点），双端点任一命中。
    for (const query of [marketQuery, storeQuery]) {
      expect(query.params).toContain('2026-09-01')
      expect(query.params).toContain('2026-09-02')
      expect(query.sql).toContain('source_org_node_id')
      expect(query.sql).toContain('target_org_node_id')
      expect(query.params).toContain('M1')
      expect(query.params).toContain('S1')
      expect(query.params).toContain('S2')
    }
    // 选项由服务端下发，不受期间/筛选影响
    expect(report.marketOptions).toEqual([{ id: 'M1', name: '南昌市场' }])
    expect(report.marketRows[0].payableAmount).toBe(500)
    expect(report.storeRows[0]).toMatchObject({
      targetOrgNodeId: 'S1',
      targetOrgNodeName: '红谷滩店',
      docCount: 3,
      totalQuantity: 12,
      payableAmount: 888,
    })
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
    execute.mockResolvedValue([])

    await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    // 两段结算查询的 scope 都必须收敛到市场 B 绑定覆盖的 org；
    // 门店 A 节点绝不允许进入金额聚合条件（整行即金额）。
    expect(execute).toHaveBeenCalledTimes(3)
    for (const index of [1, 2]) {
      const query = callOf(index)
      expect(query.params).toContain('MKT-B')
      expect(query.params).toContain('NODE-B1')
      expect(query.params).not.toContain('NODE-A1')
      expect(query.params).not.toContain('STORE-A1')
    }
  })

  it('scope 为空的会话返回空行且不触发查询（fail-closed）', async () => {
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
    expect(execute).not.toHaveBeenCalled()
  })

  it('净额与退货分列：金额取净额、数量与单据数不净额化', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)
    execute
      .mockResolvedValueOnce([])  // 0 = 市场选项
      .mockResolvedValueOnce([summaryRow({
        doc_count: 2, return_doc_count: 1, total_quantity: '30.00', returned_quantity: '5.00', payable_amount: '-1500.00',
      })])
      .mockResolvedValueOnce([])

    const report = await listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' })

    expect(report.marketRows[0]).toMatchObject({
      docCount: 2,
      returnDocCount: 1,
      totalQuantity: 30,
      returnedQuantity: 5,
      // 上月配货本月退货 → 净额可为负
      payableAmount: -1500,
    })
  })

  it('日期非法或起止倒挂抛 INVALID_PARAMS', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)

    await expect(listInventorySettlements({ startDate: '2026/09/01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不是有效的日历日期')
    await expect(listInventorySettlements({ startDate: '2026-09-02', endDate: '2026-09-01' }))
      .rejects.toThrow('INVALID_PARAMS: 结算开始日期不能晚于结束日期')
    expect(execute).not.toHaveBeenCalled()
  })

  it('F6：形状合法但日历非法的日期在入口抛 INVALID_PARAMS，不打到 PG（22008）', async () => {
    mockGetSession.mockResolvedValue(MARKET_SESSION)

    for (const startDate of ['2026-02-30', '2026-13-01', '0000-01-01']) {
      await expect(listInventorySettlements({ startDate }))
        .rejects.toThrow('INVALID_PARAMS')
    }
    expect(execute).not.toHaveBeenCalled()
  })
})

/**
 * #453 的运行时类型守卫：非字符串日期必须在进 SQL 之前被拒。
 * 重写测试时这组一度被漏掉 —— 守卫还在（`typeof !== 'string'`），但没有测试钉住它，
 * 后续若有人把它放宽成"只靠 SQL 的 ::date 转换"，22008 类回归不会变红。
 */
describe('#453 结算日期运行时类型', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetSession.mockResolvedValue(MARKET_SESSION)
  })

  it.each([123, {}, ['2026-09-01'], false])('非字符串日期 %s 在查询前报 INVALID_PARAMS', async (value) => {
    for (const filters of [{ startDate: value }, { endDate: value }]) {
      await expect(listInventorySettlements(filters as never))
        .rejects.toThrow('INVALID_PARAMS: 结算期间日期格式必须为 YYYY-MM-DD')
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('闰日与库存宽年份照常放行', () => {
    expect(normalizeSettlementPeriod({ startDate: '2024-02-29', endDate: '2024-02-29' }))
      .toEqual({ startDate: '2024-02-29', endDate: '2024-02-29' })
    expect(normalizeSettlementPeriod({ startDate: '0001-01-01', endDate: '9999-12-31' }))
      .toEqual({ startDate: '0001-01-01', endDate: '9999-12-31' })
    // 空串回落默认期间（本月），不是报错
    expect(normalizeSettlementPeriod({ startDate: '', endDate: '  ' })).toMatchObject({ startDate: expect.stringMatching(/^\d{4}-\d{2}-01$/) })
  })
})

/**
 * #349 结算投影的**单源**守护。这组断言是「哪类单据怎么并入」的唯一定义处 ——
 * 汇总、下钻、导出三处都从 settlementProjectionSql 取数，改这张表就等于改三处。
 */
describe('#349 结算投影：单据类型单源', () => {
  it('符号 / 端点方向 / 归期口径 / 状态白名单逐条固定', () => {
    expect(settlementDocKinds).toEqual([
      { segment: 'market', docType: '市场报货', status: '已完成', sign: 1, swapped: false, marketPrice: false },
      { segment: 'market', docType: '市场退货', status: '已完成', sign: -1, swapped: false, marketPrice: true },
      { segment: 'store', docType: '分院配货', status: '待收货', sign: 1, swapped: false, marketPrice: false },
      { segment: 'store', docType: '分院配货', status: '已完成', sign: 1, swapped: false, marketPrice: false },
      { segment: 'store', docType: '院退货', status: '已完成', sign: -1, swapped: true, marketPrice: false },
    ])
  })

  it('门店间调货与市场间调货一律不在结算范围内', () => {
    expect(settlementDocKinds.some((kind) => kind.docType.includes('调货'))).toBe(false)
  })

  it('院退货是唯一交换端点的一类；市场退货与市场报货同向', () => {
    expect(settlementDocKinds.filter((kind) => kind.swapped).map((kind) => kind.docType)).toEqual(['院退货'])
  })

  it('退货只认已完成、按审批日归期且转上海时区', () => {
    const query = compile(settlementProjectionSql({
      segment: 'market', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: null,
    }))
    expect(query.params).toContain('市场退货')
    expect(query.params).toContain('已完成')
    expect(query.sql).toContain("AT TIME ZONE 'Asia/Shanghai'")
    // 归期列而非原始 doc_date 参与区间过滤
    expect(query.sql).toContain('p.effective_date >=')
    expect(query.params).not.toContain('已驳回')
  })

  it('市场退货按市场价计价（堵死「金额÷数量」反推门店价的泄漏路径）', () => {
    const query = compile(settlementProjectionSql({
      segment: 'market', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: null,
    }))
    expect(query.sql).toContain('COALESCE(i.market_actual_unit_price, i.supply_chain_unit_cost, 0)')
  })

  it('scope 为空 → FALSE；null → 不加范围限制', () => {
    const empty = compile(settlementProjectionSql({
      segment: 'market', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: [],
    }))
    expect(empty.sql).toContain('FALSE')
    const unscoped = compile(settlementProjectionSql({
      segment: 'market', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: null,
    }))
    expect(unscoped.sql).not.toContain('source_org_node_id IN')
  })

  it('市场筛选作用在 market_id 上（与四类单据的 DB 派生列同源）', () => {
    const query = compile(settlementProjectionSql({
      segment: 'store', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: null, market: 'M1',
    }))
    expect(query.sql).toContain('d.market_id =')
    expect(query.params).toContain('M1')
  })
})
