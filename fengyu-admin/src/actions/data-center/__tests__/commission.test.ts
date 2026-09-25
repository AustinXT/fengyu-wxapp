import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'

/**
 * 员工提成日报 / 明细取数 action（#375）：权限闸门、顾客姓名脱敏、订单号链接权限、
 * keyset 翻页游标、指标卡算术。SQL 口径本身由 consistency.commission.test.ts 与 prod 基线核对覆盖，
 * 这里按 SQL 特征把 db.execute 路由到夹具。
 */

const { mockGetSession, execute } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db: { execute } }))

import { exportCommissionDetail, getCommissionDaily, getCommissionDetail } from '../commission'
import { commissionFilterSignature, decodeCommissionCursor, encodeCommissionCursor } from '@/lib/data-center/commission-daily'

const dialect = new PgDialect()
function sqlText(query: SQL): string {
  return dialect.sqlToQuery(query).sql
}

const COMMISSION = ['data_center:dashboard', 'data_center:staff_commission']

function session(extra: string[] = [], actions: string[] = COMMISSION): AuthSession {
  const all = [...actions, ...extra]
  return {
    employeeId: 'EMP-1',
    name: '测试',
    phone: '13800000000',
    roles: [{
      role: 'admin', isSuperAdmin: true, scopeId: 'HQ', scopeType: '总部',
      actions: all, scopeStoreIds: [], scopeOrgNodeIds: ['HQ'],
    }],
    permissions: { actions: all, scopeStoreIds: [] },
  }
}

function detailRow(id: number, date: string, source: 'sale' | 'service' = 'sale') {
  return {
    source, source_id: String(id), biz_date: date, store_id: 'S1', store_name: '蓝莱店', employee_id: 'E1',
    employee_name: '张三', position_name: '美容师', order_id: `SO-${id}`, payment_id: source === 'sale' ? String(900 + id) : null,
    customer_name: '王小明', order_kind: '销售单·首次支付', product_name: '面部护理', category_l1: '生美', category_l2: '面部',
    received: '100.00', consume_amount: null, allocated: '50.00', rate: '0.0300', commission: '1.50',
  }
}

let pageRows: Record<string, unknown>[] = []

beforeEach(() => {
  vi.clearAllMocks()
  pageRows = []
  execute.mockImplementation(async (query: SQL) => {
    const text = sqlText(query)
    if (text.includes('detail_rows')) return pageRows
    if (text.includes('summary_rows')) {
      return [{ count: 3, orders: 2, received: '300.00', allocated: '150.00', commission: '4.50', sale: '3.00', service: '1.50' }]
    }
    if (text.includes('SELECT e.employee_id')) return [{ employee_id: 'E1', name: '张三', position_name: null, home_name: '蓝莱店' }]
    if (text.includes('GROUPING SETS')) return []
    if (text.includes('earning_employees')) return [{ sale: '201746.24', service: '374896.13', orders: 8065, earning_employees: 151, employees: 196 }]
    if (text.includes('technician_scoped')) return [{ v: 158 }]
    if (text.includes("allocation_status = '待分配'")) return [{ count: 15, amount: '21188.00' }]
    throw new Error(`未预期的 SQL：${text.slice(0, 80)}`)
  })
})

describe('权限闸门', () => {
  it.each([
    ['日报', () => getCommissionDaily({})],
    ['明细', () => getCommissionDetail({})],
  ])('%s：只有 dashboard 的账号被拒成 PERMISSION_DENIED，且不查库', async (_label, call) => {
    mockGetSession.mockResolvedValue(session([], ['data_center:dashboard']))
    await expect(call()).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('getCommissionDaily · 指标卡', () => {
  it('提成合计 = 业绩 + 消耗；人均分母 = 产能技师；单均分母 = 去重订单；待分配同 /allocations 口径', async () => {
    mockGetSession.mockResolvedValue(session(['allocation:list']))
    const result = await getCommissionDaily({ month: '2026-08' })

    expect(result.kpis.total).toBeCloseTo(576642.37, 2)
    expect(result.kpis.saleShare).toBeCloseTo(201746.24 / 576642.37, 10)
    expect(result.kpis.earningEmployees).toBe(151)
    expect(result.kpis.employees).toBe(196)
    expect(result.kpis.technicianCount).toBe(158)
    expect(result.kpis.perTechnician).toBeCloseTo(3649.64, 2)
    expect(result.kpis.perOrder).toBeCloseTo(71.5, 2)
    expect(result.pending).toEqual({ count: 15, amount: 21188 })
    expect(result.canLinkAllocations).toBe(true)
  })

  it('无 allocation:list 时待分配提示不可点', async () => {
    mockGetSession.mockResolvedValue(session())
    expect((await getCommissionDaily({ month: '2026-08' })).canLinkAllocations).toBe(false)
  })
})

describe('getCommissionDetail · 脱敏与链接权限', () => {
  it('无 customer:list：顾客姓名脱敏；无 allocation:list：订单号不可点', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = [detailRow(1, '2026-08-02')]
    const result = await getCommissionDetail({ month: '2026-08' })
    expect(result.rows[0].customerName).toBe('王*明')
    expect(result.customerMasked).toBe(true)
    expect(result.canLinkOrders).toBe(false)
  })

  it('有 customer:list / allocation:list：原样返回、可点；bigint 字符串转数字', async () => {
    mockGetSession.mockResolvedValue(session(['customer:list', 'allocation:list']))
    pageRows = [detailRow(12, '2026-08-02')]
    const result = await getCommissionDetail({ month: '2026-08' })
    expect(result.rows[0]).toMatchObject({ customerName: '王小明', sourceId: 12, paymentId: 912, key: 'sale:12', rate: 0.03 })
    expect(result.canLinkOrders).toBe(true)
    expect(result.summary.averageRate).toBeCloseTo(4.5 / 150, 10)
    expect(result.employeeOptions).toEqual([{ employeeId: 'E1', label: '蓝莱店 · 张三（无岗位）' }])
  })
})

describe('附加能力按每条角色授权判定（不拼接）', () => {
  it('提成权限在角色 A、customer:list / allocation:list 只在角色 B：仍脱敏、订单号不可点', async () => {
    const roleA = { role: 'manager', scopeId: 'HQ', scopeType: '总部' as const, actions: COMMISSION, scopeStoreIds: ['S1'], scopeOrgNodeIds: ['HQ'] }
    const roleB = { role: 'customer_mgr', scopeId: 'M2', scopeType: '市场' as const, actions: ['customer:list', 'allocation:list'], scopeStoreIds: ['S9'], scopeOrgNodeIds: ['M2'] }
    mockGetSession.mockResolvedValue({
      employeeId: 'EMP-2', name: '双角色', phone: '', roles: [roleA, roleB],
      permissions: { actions: [...COMMISSION, 'customer:list', 'allocation:list'], scopeStoreIds: ['S1', 'S9'] },
    } satisfies AuthSession)
    pageRows = [detailRow(1, '2026-08-02')]
    const result = await getCommissionDetail({ month: '2026-08' })
    expect(result.customerMasked).toBe(true)
    expect(result.rows[0].customerName).toBe('王*明')
    expect(result.canLinkOrders).toBe(false)
  })
})

describe('getCommissionDetail · keyset 翻页', () => {
  const signature = commissionFilterSignature({
    scope: 'all', scopeId: '', month: '2026-08', employeeId: null, storeId: null, date: null, type: null,
  })

  it('第一页：多取的探测行决定有下一页，没有上一页；下一页游标 = 本页末行键', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = Array.from({ length: 21 }, (_, i) => detailRow(100 - i, '2026-08-02'))
    const result = await getCommissionDetail({ month: '2026-08', size: '20' })
    expect(result.rows).toHaveLength(20)
    expect(result.prevCursor).toBeNull()
    expect(decodeCommissionCursor(result.nextCursor, signature)).toEqual({ d: '2026-08-02', t: 'sale', id: 81 })
  })

  it('带 after 游标：有上一页；最后一页没有下一页', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = [detailRow(5, '2026-08-01')]
    const after = encodeCommissionCursor({ d: '2026-08-02', t: 'sale', id: 81 }, signature)
    const result = await getCommissionDetail({ month: '2026-08', after })
    expect(result.nextCursor).toBeNull()
    expect(decodeCommissionCursor(result.prevCursor, signature)).toEqual({ d: '2026-08-01', t: 'sale', id: 5 })
    expect(sqlText(execute.mock.calls.find(([q]) => sqlText(q).includes('detail_rows'))![0])).toContain('source_id <')
  })

  it('带 before 游标：SQL 反向取，结果翻回正序；恒有下一页', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = [detailRow(1, '2026-08-01', 'service'), detailRow(2, '2026-08-02')]
    const before = encodeCommissionCursor({ d: '2026-08-01', t: 'sale', id: 1 }, signature)
    const result = await getCommissionDetail({ month: '2026-08', before })
    expect(result.rows.map((row) => row.key)).toEqual(['sale:2', 'service:1'])
    expect(result.prevCursor).toBeNull()
    expect(result.nextCursor).not.toBeNull()
    expect(sqlText(execute.mock.calls.find(([q]) => sqlText(q).includes('detail_rows'))![0])).toContain('ORDER BY biz_date ASC, source DESC, source_id ASC')
  })

  it.each(['before', 'after'] as const)('%s 游标查回 0 行（期间数据被改）：回到第一页，不卡在上下页都禁用的空页', async (direction) => {
    mockGetSession.mockResolvedValue(session())
    const firstPage = [detailRow(9, '2026-08-03'), detailRow(8, '2026-08-03')]
    let call = 0
    execute.mockImplementation(async (query: SQL) => {
      const text = sqlText(query)
      if (text.includes('detail_rows')) return call++ === 0 ? [] : firstPage
      if (text.includes('summary_rows')) return [{ count: 2, orders: 2, received: '0', allocated: '0', commission: '0', sale: '0', service: '0' }]
      return []
    })
    const cursor = encodeCommissionCursor({ d: '2026-08-01', t: 'sale', id: 1 }, signature)
    const result = await getCommissionDetail({ month: '2026-08', [direction]: cursor })
    expect(result.rows.map((row) => row.key)).toEqual(['sale:9', 'sale:8'])
    expect(result.prevCursor).toBeNull()
    expect(result.nextCursor).toBeNull()
  })

  it('游标与当前筛选不符（换了月份）：忽略游标，回到第一页', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = [detailRow(1, '2026-07-10')]
    const stale = encodeCommissionCursor({ d: '2026-08-02', t: 'sale', id: 81 }, signature)
    const result = await getCommissionDetail({ month: '2026-07', after: stale })
    expect(result.prevCursor).toBeNull()
    expect(sqlText(execute.mock.calls.find(([q]) => sqlText(q).includes('detail_rows'))![0])).not.toContain('source_id <')
  })
})

describe('exportCommissionDetail', () => {
  it('第一批带汇总，后续批次不再查汇总；导出也脱敏', async () => {
    mockGetSession.mockResolvedValue(session())
    pageRows = Array.from({ length: 3 }, (_, i) => detailRow(10 - i, '2026-08-02'))
    const first = await exportCommissionDetail({ month: '2026-08' }, { limit: 2 })
    expect(first.rows).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.summary?.count).toBe(3)
    expect(first.rows[0].customerName).toBe('王*明')

    execute.mockClear()
    pageRows = [detailRow(8, '2026-08-02')]
    const second = await exportCommissionDetail({ month: '2026-08' }, { limit: 2, cursor: first.nextCursor })
    expect(second.summary).toBeNull()
    expect(second.hasMore).toBe(false)
    expect(execute.mock.calls.some(([q]) => sqlText(q).includes('summary_rows'))).toBe(false)
  })

  it('游标解不出来（筛选被改或损坏）直接失败，不从头重导造成重复', async () => {
    mockGetSession.mockResolvedValue(session())
    await expect(exportCommissionDetail({ month: '2026-08' }, { limit: 2, cursor: 'garbage' })).rejects.toThrow('INVALID_STATE')
  })
})
