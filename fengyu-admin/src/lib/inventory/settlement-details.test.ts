import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

import {
  exportSettlementSegmentDetailsForSession,
  listSettlementDetailsForSession,
  normalizeSettlementDetailFilters,
  normalizeSettlementSegmentFilters,
  settlementDetailSelectSql,
} from './settlement-details'
import { settlementProjectionSql } from './settlements'

const compile = (query: SQL) => new PgDialect().sqlToQuery(query)

const session = (actions: string[], scopeOrgNodeIds: string[]) => ({
  employeeId: 'E1',
  roles: [{ role: 'inventory_market_finance', scopeType: '市场', scopeId: scopeOrgNodeIds[0], scopeOrgNodeIds, scopeStoreIds: [], actions }],
  permissions: { actions, scopeOrgNodeIds, scopeStoreIds: [] },
})

const MARKET_PRICE_SESSION = session(['inventory:list', 'inventory:market_price_view'], ['M1', 'S1'])
const SUPPLY_CHAIN_SESSION = session(['inventory:list', 'inventory:supply_chain_price_view'], ['HQ'])
const NO_PRICE_SESSION = session(['inventory:list'], ['S1'])

const baseFilters = {
  segment: 'market' as const,
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  marketNode: 'M1',
  partyNode: 'HQ',
}

const rawDetail = (over: Record<string, unknown> = {}) => ({
  id: '9007199254740993',
  doc_id: 'FPH-20260920-0001',
  doc_type: '分院配货',
  status: '待收货',
  effective_date: '2026-09-20',
  market_node: 'M1',
  market_name: '南昌市场',
  party_node: 'S1',
  party_name: '红谷滩店',
  market_id: 'M1',
  sku_id: 'SKU1',
  sku_name: '面膜',
  spec_name: null,
  batch_no: 'B1',
  is_gift: false,
  is_return: false,
  quantity: '2.00',
  signed_amount: '240.00',
  store_standard_unit_price: '150.00',
  store_unit_discount: '10.00',
  store_actual_unit_price: '140.00',
  ...over,
})

beforeEach(() => {
  execute.mockReset()
})

describe('#349 结算下钻明细：参数与段可见性', () => {
  it('段非法或端点缺失在 SQL 前拒绝', async () => {
    await expect(listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, { ...baseFilters, segment: 'other' } as never))
      .rejects.toThrow('INVALID_PARAMS')
    await expect(listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, { ...baseFilters, partyNode: undefined } as never))
      .rejects.toThrow('INVALID_PARAMS')
    expect(normalizeSettlementDetailFilters({ ...baseFilters, market: '  ' }).market).toBeUndefined()
    expect(normalizeSettlementSegmentFilters({ segment: 'store', startDate: '2026-09-01', endDate: '2026-09-30' }))
      .toMatchObject({ segment: 'store', startDate: '2026-09-01', endDate: '2026-09-30', market: undefined })
    expect(execute).not.toHaveBeenCalled()
  })

  it('门店价格档两段都不可见，返回空集且不查库', async () => {
    for (const segment of ['market', 'store'] as const) {
      const result = await listSettlementDetailsForSession(NO_PRICE_SESSION as never, { ...baseFilters, segment })
      expect(result).toEqual({
        rows: [],
        truncated: false,
        limit: 2000,
        totals: { forwardQuantity: 0, returnedQuantity: 0, amount: 0 },
      })
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('供应链价格档可见市场段、不可见分院段（§9.5 不得见门店结算价）', async () => {
    execute.mockResolvedValue([])
    const store = await listSettlementDetailsForSession(SUPPLY_CHAIN_SESSION as never, { ...baseFilters, segment: 'store' })
    expect(store.rows).toEqual([])
    expect(execute).not.toHaveBeenCalled()

    await listSettlementDetailsForSession(SUPPLY_CHAIN_SESSION as never, baseFilters)
    // 明细 + 该行的完整合计（合计独立聚合，不受展示上限影响）
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('分院段收窄到市场价格档绑定，供应链绑定不参与', async () => {
    execute.mockResolvedValue([])
    // 市场档会话（scope M1/S1）查分院段：scope 直接就是它自己的绑定
    await listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, { ...baseFilters, segment: 'store', partyNode: 'S1' })
    const query = compile(execute.mock.calls[0][0] as SQL)
    expect(query.params).toContain('M1')
    expect(query.params).toContain('S1')
  })
})

describe('#349 结算下钻明细：与汇总同源', () => {
  it('端点过滤作用在投影列上，不是原始端点列', async () => {
    execute.mockResolvedValue([])
    await listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, baseFilters)
    const query = compile(execute.mock.calls[0][0] as SQL)
    // 投影列 p.market_node / p.party_node —— 退货行原始端点是反的，按原始列过滤会一条都查不到
    expect(query.sql).toContain('p.market_node =')
    expect(query.sql).toContain('p.party_node =')
    expect(query.params).toContain('M1')
    expect(query.params).toContain('HQ')
    // 同一份投影：单据类型表与上海时区归期都在
    expect(query.params).toContain('市场退货')
    expect(query.sql).toContain("AT TIME ZONE 'Asia/Shanghai'")
  })

  it('价格列按段取，两段互不跨界', () => {
    const projection = settlementProjectionSql({
      segment: 'market', startDate: '2026-09-01', endDate: '2026-09-30', scopedOrgNodeIds: null,
    })
    const marketSql = compile(settlementDetailSelectSql(projection, 'market', 'M1', 'HQ', 10)).sql
    expect(marketSql).toContain('p.market_actual_unit_price')
    expect(marketSql).not.toContain('p.store_actual_unit_price')

    const storeSql = compile(settlementDetailSelectSql(projection, 'store', 'M1', 'S1', 10)).sql
    expect(storeSql).toContain('p.store_actual_unit_price')
    expect(storeSql).not.toContain('p.market_actual_unit_price')
  })

  it('退货行带 isReturn 与负金额', async () => {
    execute.mockResolvedValue([rawDetail({ is_return: true, signed_amount: '-1200.00', quantity: '1.00' })])
    const result = await listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, baseFilters)
    expect(result.rows[0]).toMatchObject({ isReturn: true, signedAmount: -1200, quantity: 1 })
    expect(result.truncated).toBe(false)
  })

  it('完整合计取服务端聚合，不受展示上限影响（验收「明细合计 = 汇总行」）', async () => {
    execute
      .mockResolvedValueOnce([rawDetail({ id: '1', quantity: '6.00', signed_amount: '6600.00' })])
      .mockResolvedValueOnce([{ forward_quantity: '6.00', returned_quantity: '4.00', amount: '2600.00' }])
    const result = await listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, baseFilters)
    // rows 只回了 1 行，但合计是整段的（正向 6 / 退货 4 / 净额 2600）—— 与汇总行同口径
    expect(result.rows).toHaveLength(1)
    expect(result.totals).toEqual({ forwardQuantity: 6, returnedQuantity: 4, amount: 2600 })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('超过展示上限时截断（上限 2000，与来源明细同量级）', async () => {
    execute.mockResolvedValue(Array.from({ length: 2001 }, (_, index) => rawDetail({ id: String(index + 1) })))
    const result = await listSettlementDetailsForSession(MARKET_PRICE_SESSION as never, baseFilters)
    expect(result.rows).toHaveLength(2000)
    expect(result.truncated).toBe(true)
  })
})

describe('#349 结算明细导出：整段 keyset', () => {
  const exportFilters = { segment: 'market' as const, startDate: '2026-09-01', endDate: '2026-09-30' }

  it.each(['0', '-1', '1.2', '9223372036854775808', 2, null])('拒绝坏游标 %j', async (cursor) => {
    await expect(exportSettlementSegmentDetailsForSession(MARKET_PRICE_SESSION as never, exportFilters, { limit: 2, cursor } as never))
      .rejects.toThrow('INVALID_STATE')
    expect(execute).not.toHaveBeenCalled()
  })

  it('必须分批，不接受无界批次', async () => {
    await expect(exportSettlementSegmentDetailsForSession(MARKET_PRICE_SESSION as never, exportFilters))
      .rejects.toThrow('INVALID_STATE')
    expect(execute).not.toHaveBeenCalled()
  })

  it('整段导出不带端点过滤，bigint 游标不丢精度', async () => {
    execute.mockResolvedValueOnce([
      rawDetail({ id: '9007199254740993' }),
      rawDetail({ id: '9007199254740994' }),
      rawDetail({ id: '9007199254740995' }),
    ])
    const first = await exportSettlementSegmentDetailsForSession(MARKET_PRICE_SESSION as never, exportFilters, { limit: 2 })
    expect(first).toMatchObject({ hasMore: true, nextCursor: '9007199254740994' })
    expect(compile(execute.mock.calls[0][0] as SQL).sql).not.toContain('p.market_node =')

    execute.mockResolvedValueOnce([rawDetail({ id: '9007199254740995' })])
    const last = await exportSettlementSegmentDetailsForSession(
      MARKET_PRICE_SESSION as never, exportFilters, { limit: 2, cursor: first.nextCursor },
    )
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeUndefined()
    expect(compile(execute.mock.calls[1][0] as SQL).sql).toMatch(/p\.item_id > \$\d+::bigint/)
  })
})
