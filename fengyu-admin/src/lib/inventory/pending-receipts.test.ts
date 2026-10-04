import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { execute, getSession } = vi.hoisted(() => ({ execute: vi.fn(), getSession: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/auth', () => ({ getSession }))
import { exportPendingReceipts, listPendingReceipts, pendingReceiptOptions } from '@/actions/inventory/pending-receipts'
import { normalizePendingReceiptFilters, pendingReceiptWhereSql } from './pending-receipts'

const session = (scopeId = 'M1', actions = ['inventory:list', 'inventory:export']) => ({
  employeeId: 'E1', roles: [{ role: 'inventory_market_finance', scopeType: '市场', scopeId, scopeOrgNodeIds: [scopeId, `${scopeId}-S1`], scopeStoreIds: [], actions }],
  permissions: { actions, scopeOrgNodeIds: [scopeId, `${scopeId}-S1`], scopeStoreIds: [] },
})
const compile = (query: SQL) => new PgDialect().sqlToQuery(query)
const raw = (id: string) => ({ id, recipient_id: 'M1-S1', recipient_name: '门店一', market_id: 'M1', market_name: '市场一', doc_date: '2026-09-20', doc_id: 'DOC1', sku_id: 'SKU1', sku_name: '面膜', batch_no: 'B1', sent_quantity: '10.00', received_quantity: '3.00', pending_quantity: '7.00', transit_days: 9 })

beforeEach(() => { execute.mockReset(); getSession.mockResolvedValue(session()) })

describe('#361 参数与共享 SQL', () => {
  it.each([{ kind: 'other' }, { start: '2026-02-30' }, { start: '0000-01-01' }, { start: 20260101 }, { end: {} }, { start: '2026-09-02', end: '2026-09-01' }, { kind: 'market', store: 'S1' }])('非法条件在 SQL 前拒绝 %j', async filters => {
    await expect(listPendingReceipts(filters as never)).rejects.toThrow('INVALID_PARAMS')
    expect(execute).not.toHaveBeenCalled()
  })
  it('闰日、库存宽年份和空日期', () => {
    expect(normalizePendingReceiptFilters({ start: '0001-01-01', end: '9999-12-31' })).toMatchObject({ start: '0001-01-01', end: '9999-12-31' })
    expect(normalizePendingReceiptFilters({ start: '2024-02-29', end: '' }).end).toBeUndefined()
  })
  it('状态与 fulfilled 条件固定，全部过滤参数化，空scope拒绝', () => {
    const filters = normalizePendingReceiptFilters({ market: "M1' OR 1=1--", store: 'S1', start: '2026-09-01', end: '2026-09-30' })
    const query = compile(pendingReceiptWhereSql(filters, ['M1', 'S1']))
    expect(query.sql).toContain("d.status = '待收货'")
    expect(query.sql).toContain('COALESCE(i.fulfilled_quantity, 0) < i.quantity')
    expect(query.sql).not.toContain(filters.market)
    expect(query.params).toContain(filters.market)
    expect(compile(pendingReceiptWhereSql(filters, [])).sql).toContain('FALSE')
    expect(compile(pendingReceiptWhereSql({ kind: 'market' }, null)).params).toEqual(['品项公司发货'])
  })
})

describe('#361 权限、scope与 keyset', () => {
  it('查询权限不足不访问SQL，不能用list权限导出', async () => {
    getSession.mockResolvedValue(session('M1', ['inventory:list']))
    await expect(exportPendingReceipts({}, { limit: 2 })).rejects.toThrow('PERMISSION_DENIED')
    getSession.mockResolvedValue(session('M1', ['inventory:export']))
    await expect(listPendingReceipts({})).rejects.toThrow('PERMISSION_DENIED')
    expect(execute).not.toHaveBeenCalled()
  })
  it('查询与导出分别按实际授权绑定收窄，不能拼接其它角色范围', async () => {
    const a = session('M1', ['inventory:list']); const b = session('M2', ['inventory:export'])
    getSession.mockResolvedValue({ ...a, roles: [...a.roles, ...b.roles], permissions: { ...a.permissions, actions: ['inventory:list', 'inventory:export'], scopeOrgNodeIds: ['M1', 'M2'] } })
    execute.mockResolvedValue([])
    await listPendingReceipts({})
    expect(compile(execute.mock.calls[0][0]).params).toContain('M1')
    expect(compile(execute.mock.calls[0][0]).params).not.toContain('M2')
    execute.mockClear()
    await exportPendingReceipts({}, { limit: 2 })
    expect(compile(execute.mock.calls[0][0]).params).toContain('M2')
    expect(compile(execute.mock.calls[0][0]).params).not.toContain('M1')
  })
  it('兼容历史10/3/7，数量转换且页面页码夹紧', async () => {
    execute.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([raw('9007199254740993')])
    const page = await listPendingReceipts({ page: '99999', size: '20' })
    expect(page).toMatchObject({ total: 1, page: 1, rows: [{ id: '9007199254740993', sentQuantity: 10, receivedQuantity: 3, pendingQuantity: 7, transitDays: 9 }] })
  })
  it.each([['2.9', '50', 2, 50, 50], [Infinity, '20', 1, 20, 0], [{ toString: null }, { toString: null }, 1, 20, 0], ['1e21', '7', 1, 20, 0]])('分页非法值优雅回落或截断 %j/%j', async (inputPage, size, page, pageSize, offset) => {
    execute.mockResolvedValueOnce([{ total: 1000 }]).mockResolvedValueOnce([])
    expect(await listPendingReceipts({ page: inputPage, size })).toMatchObject({ page, pageSize })
    const query = compile(execute.mock.calls[1][0])
    expect(query.params.slice(-2)).toEqual([pageSize, offset])
  })
  it.each(['0', '-1', '1.2', '9223372036854775808', 2, null])('拒绝坏worker游标 %j', async cursor => {
    await expect(exportPendingReceipts({}, { limit: 2, cursor } as never)).rejects.toThrow('INVALID_STATE')
    expect(execute).not.toHaveBeenCalled()
  })
  it('字符串bigint探测行与游标不丢精度，末页不返回游标', async () => {
    execute.mockResolvedValueOnce([raw('9007199254740993'), raw('9007199254740994'), raw('9007199254740995')])
    const first = await exportPendingReceipts({}, { limit: 2 })
    expect(first).toMatchObject({ hasMore: true, nextCursor: '9007199254740994', rows: [{ id: '9007199254740993' }, { id: '9007199254740994' }] })
    execute.mockResolvedValueOnce([raw('9007199254740995')])
    const last = await exportPendingReceipts({}, { limit: 2, cursor: first.nextCursor })
    expect(last).toMatchObject({ hasMore: false, rows: [{ id: '9007199254740995' }] })
    expect(last.nextCursor).toBeUndefined()
    const query = compile(execute.mock.calls[1][0])
    expect(query.sql).toMatch(/i.id > \$\d+::bigint/)
    expect(query.params).toContain('9007199254740994')
  })
  it('导出必须有有界批次，缺scope不会展开', async () => {
    await expect(exportPendingReceipts({})).rejects.toThrow('INVALID_STATE')
    getSession.mockResolvedValue({ ...session(), roles: [], permissions: { actions: ['inventory:list'], scopeOrgNodeIds: [], scopeStoreIds: [] } })
    execute.mockResolvedValue([])
    await pendingReceiptOptions()
    expect(compile(execute.mock.calls[0][0]).sql).toContain('FALSE')
  })
})
