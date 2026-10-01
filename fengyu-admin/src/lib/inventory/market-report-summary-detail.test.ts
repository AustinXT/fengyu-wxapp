import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { execute, getSession } = vi.hoisted(() => ({ execute: vi.fn(), getSession: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/auth', () => ({ getSession }))
import { listMarketReportSummarySources } from '@/actions/inventory/docs'
import {
  exportMarketReportSummarySourcesForSession,
  listMarketReportSummarySourcesForSession,
  marketReportSummarySourceWhereSql,
  normalizeMarketReportSummarySourceFilters,
} from './market-report-summary-detail'

const compile = (query: SQL) => new PgDialect().sqlToQuery(query)

const session = (actions: string[], scopeOrgNodeIds = ['M1', 'M1-S1']) => ({
  employeeId: 'E1',
  roles: [{ role: 'inventory_market_finance', scopeType: '市场', scopeId: 'M1', scopeOrgNodeIds, scopeStoreIds: [], actions }],
  permissions: { actions, scopeOrgNodeIds, scopeStoreIds: [] },
})

const MARKET_PRICE_SESSION = session(['inventory:list', 'inventory:market_price_view'], ['M1', 'M1-S1'])
const NO_PRICE_SESSION = session(['inventory:list'], ['M1', 'M1-S1'])
const ADMIN_SESSION = {
  employeeId: 'E-ADMIN',
  roles: [{ role: 'admin', scopeType: '总部', scopeId: 'HQ', scopeOrgNodeIds: ['HQ'], scopeStoreIds: [], actions: ['inventory:list'], isSuperAdmin: true }],
  permissions: { actions: ['inventory:list'], scopeOrgNodeIds: ['HQ'], scopeStoreIds: [] },
}

const raw = (over: Record<string, unknown> = {}) => ({
  id: '9007199254740993',
  market_id: 'M1',
  market_name: '市场一',
  source_doc_id: 'MTH-20260920-0001',
  source_doc_date: '2026-09-20',
  sku_id: 'SKU1',
  sku_name: '面膜',
  spec_name: null,
  batch_no: 'B1',
  quantity: '3.00',
  market_standard_unit_price: '1200.00',
  market_unit_discount: '200.00',
  market_actual_unit_price: '1000.00',
  promotion_plan_no_snapshot: 'FA-1',
  ...over,
})

beforeEach(() => {
  execute.mockReset()
  getSession.mockReset()
})

describe('#349 汇总单来源明细：参数与共享 SQL', () => {
  it('缺汇总单号在 SQL 前拒绝', async () => {
    await expect(listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, {}))
      .rejects.toThrow('INVALID_PARAMS')
    await expect(listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: '   ' }))
      .rejects.toThrow('INVALID_PARAMS')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([{ docId: 123 }, { docId: 'X', market: {} }])('非法筛选条件被拒 %j', async (input) => {
    await expect(listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, input as never))
      .rejects.toThrow('INVALID_PARAMS')
    expect(execute).not.toHaveBeenCalled()
  })

  it('关系类型固定，单号与市场全部参数化', () => {
    const filters = normalizeMarketReportSummarySourceFilters({ market: "M1' OR 1=1--" })
    const query = compile(marketReportSummarySourceWhereSql('SUM-1', filters, ['M1']))
    expect(query.sql).toContain('l.relation_type = ')
    expect(query.sql).toContain("'市场报货汇总'")
    expect(query.sql).not.toContain(filters.market)
    expect(query.params).toContain('SUM-1')
    expect(query.params).toContain(filters.market)
  })

  it('空 scope 直接 FALSE，null scope 不加范围限制', () => {
    expect(compile(marketReportSummarySourceWhereSql('SUM-1', {}, [])).sql).toContain('FALSE')
    const unscoped = compile(marketReportSummarySourceWhereSql('SUM-1', {}, null))
    expect(unscoped.sql).not.toContain('EXISTS')
    expect(unscoped.params).toEqual(['SUM-1'])
  })

  it('scope 作用在汇总单本身（source 或 target 命中即可见）', () => {
    const query = compile(marketReportSummarySourceWhereSql('SUM-1', {}, ['M1']))
    expect(query.sql).toContain('head.source_org_node_id IN')
    expect(query.sql).toContain('head.target_org_node_id IN')
    expect(query.params).toContain('M1')
  })
})

describe('#349 汇总单来源明细：映射与价格档', () => {
  it('金额 = 分摊量 × 来源行实际单价，数量读 link 而非来源行原始量', async () => {
    execute.mockResolvedValue([raw()])
    const { rows } = await listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' })
    expect(rows[0]).toMatchObject({
      id: '9007199254740993',
      marketName: '市场一',
      sourceDocId: 'MTH-20260920-0001',
      quantity: 3,
      marketActualUnitPrice: 1000,
      amount: 3000,
      promotionPlanNo: 'FA-1',
    })
  })

  it('价格档 none 时三个单价与金额一律 null，服务端剥离而非只靠前端不渲染', async () => {
    execute.mockResolvedValue([raw()])
    const { rows } = await listMarketReportSummarySourcesForSession(NO_PRICE_SESSION as never, { docId: 'SUM-1' })
    expect(rows[0].marketStandardUnitPrice).toBeNull()
    expect(rows[0].marketUnitDiscount).toBeNull()
    expect(rows[0].marketActualUnitPrice).toBeNull()
    expect(rows[0].amount).toBeNull()
    // 福利方案号不是价格字段，两档一致返回 —— 价格档只管单价与金额。
    expect(rows[0].promotionPlanNo).toBe('FA-1')
    // 非价格字段不受影响。
    expect(rows[0].quantity).toBe(3)
  })

  it('价格档收窄按**行**判定：同一张跨市场汇总单里，只有本市场档绑定内的来源行带价', async () => {
    // 市场档会话（scope = M1/S1）打开一张同时汇总 M1 与 M9 的汇总单：
    // M9 不在它的档位绑定里 —— 若只按会话级 visibility 放行，就会泄漏 M9 的进货价（§9.5）。
    execute.mockResolvedValue([
      raw({ id: '1', market_id: 'M1', quantity: '3.00', market_actual_unit_price: '1000.00', market_standard_unit_price: '1200.00' }),
      raw({ id: '2', market_id: 'M9', quantity: '5.00', market_actual_unit_price: '777.00', market_standard_unit_price: '888.00' }),
    ])
    const { rows } = await listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' })

    expect(rows[0].marketActualUnitPrice).toBe(1000)
    expect(rows[0].amount).toBe(3000)
    expect(rows[1].marketActualUnitPrice).toBeNull()
    expect(rows[1].marketStandardUnitPrice).toBeNull()
    expect(rows[1].amount).toBeNull()
    // 非价格字段照常返回（行本身可见，只是价格被剥离）
    expect(rows[1].quantity).toBe(5)
  })

  it('admin（档位不受限）两行都带价', async () => {
    execute.mockResolvedValue([
      raw({ id: '1', market_id: 'M1' }),
      raw({ id: '2', market_id: 'M9', market_actual_unit_price: '777.00' }),
    ])
    const { rows } = await listMarketReportSummarySourcesForSession(ADMIN_SESSION as never, { docId: 'SUM-1' })
    expect(rows[0].marketActualUnitPrice).toBe(1000)
    expect(rows[1].marketActualUnitPrice).toBe(777)
  })

  it('缺价行金额为 null 而不是 0，"没价格"与"合计为 0"可区分', async () => {
    execute.mockResolvedValue([raw({ market_actual_unit_price: null, market_standard_unit_price: null, market_unit_discount: null })])
    const { rows } = await listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' })
    expect(rows[0].marketActualUnitPrice).toBeNull()
    expect(rows[0].amount).toBeNull()
  })

  it('超过展示上限时截断并置位', async () => {
    execute.mockResolvedValue(Array.from({ length: 2001 }, (_, index) => raw({ id: String(index + 1) })))
    const result = await listMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' })
    expect(result.rows).toHaveLength(2000)
    expect(result.truncated).toBe(true)
    expect(compile(execute.mock.calls[0][0]).sql).toContain('LIMIT')
  })
})

describe('#349 汇总单来源明细：导出 keyset', () => {
  it.each(['0', '-1', '1.2', '9223372036854775808', 2, null])('拒绝坏游标 %j', async (cursor) => {
    await expect(exportMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' }, { limit: 2, cursor } as never))
      .rejects.toThrow('INVALID_STATE')
    expect(execute).not.toHaveBeenCalled()
  })

  it('必须分批，不接受无界批次', async () => {
    await expect(exportMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' }))
      .rejects.toThrow('INVALID_STATE')
    expect(execute).not.toHaveBeenCalled()
  })

  it('bigint 游标全程 string，末页不返回游标', async () => {
    execute.mockResolvedValueOnce([
      raw({ id: '9007199254740993' }),
      raw({ id: '9007199254740994' }),
      raw({ id: '9007199254740995' }),
    ])
    const first = await exportMarketReportSummarySourcesForSession(MARKET_PRICE_SESSION as never, { docId: 'SUM-1' }, { limit: 2 })
    expect(first).toMatchObject({ hasMore: true, nextCursor: '9007199254740994' })
    expect(first.rows.map((row) => row.id)).toEqual(['9007199254740993', '9007199254740994'])

    execute.mockResolvedValueOnce([raw({ id: '9007199254740995' })])
    const last = await exportMarketReportSummarySourcesForSession(
      MARKET_PRICE_SESSION as never,
      { docId: 'SUM-1' },
      { limit: 2, cursor: first.nextCursor },
    )
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeUndefined()
    expect(compile(execute.mock.calls[1][0]).sql).toMatch(/l\.id > \$\d+::bigint/)
  })
})

describe('#349 汇总单来源明细：action 权限闸', () => {
  it('缺 inventory:list 不访问 SQL', async () => {
    getSession.mockResolvedValue(session(['inventory:export']))
    await expect(listMarketReportSummarySources({ docId: 'SUM-1' })).rejects.toThrow('PERMISSION_DENIED')
    expect(execute).not.toHaveBeenCalled()
  })
})
