import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(), join: vi.fn(() => ({})) }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

import { getDashboardStats } from './dashboard'
import { db } from '@/db'
import { getSession, hasRole } from '@/lib/auth'

// ── helpers ───────────────────────────────────────────────────────────────────

function mockBusinessSession(scopeStoreIds: string[] = ['store-1']) {
  ;(getSession as any).mockResolvedValue({
    employeeId: 'MGR-001',
    roles: [{ role: 'manager' }],
    permissions: {
      actions: ['dashboard:view', 'data_center:dashboard'],
      scopeStoreIds,
    },
  })
  ;(hasRole as any).mockReturnValue(false)
}

function mockAdminSession() {
  ;(getSession as any).mockResolvedValue({
    employeeId: 'ADMIN-001',
    roles: [{ role: 'admin' }],
    permissions: {
      actions: ['dashboard:view'],
      scopeStoreIds: [],
    },
  })
  ;(hasRole as any).mockImplementation((_s: any, role: string) => role === 'admin')
}

function mockHrSession() {
  ;(getSession as any).mockResolvedValue({
    employeeId: 'HR-001',
    roles: [{ role: 'hr' }],
    permissions: {
      actions: ['dashboard:view'],
      scopeStoreIds: [],
    },
  })
  ;(hasRole as any).mockImplementation((_s: any, role: string) => role === 'hr')
}

function mockProductSession() {
  ;(getSession as any).mockResolvedValue({
    employeeId: 'PM-001',
    roles: [{ role: 'product' }],
    permissions: {
      actions: ['dashboard:view'],
      scopeStoreIds: [],
    },
  })
  ;(hasRole as any).mockImplementation((_s: any, role: string) => role === 'product')
}

// ── business 角色 ─────────────────────────────────────────────────────────────

describe('getDashboardStats — business 角色（manager/finance）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopeStoreIds 为空 → 返回 ZERO_BUSINESS + roleContext=business', async () => {
    mockBusinessSession([])

    const result = await getDashboardStats()

    expect(result.roleContext).toBe('business')
    expect(result.todayVisitors).toBe(0)
    expect(result.todayRevenue).toBe(0)
    expect(result.todayPaidAmount).toBe(0)
    expect(result.pendingOrders).toBe(0)
    expect(result.pendingAllocations).toBe(0)
    expect(result.pendingAppointments).toBe(0)
    expect(result.activeServices).toBe(0)
    expect(result.yesterdayPaidAmount).toBe(0)
    expect(result.totalPaidAmount).toBe(0)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('有 scope → 执行 3 次 DB 查询 + 返回聚合结果', async () => {
    mockBusinessSession(['store-1', 'store-2'])

    let callIndex = 0
    ;(db.execute as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // order stats
        return Promise.resolve([{
          today_visitors: '5',
          today_revenue: '8600.00',
          today_paid_amount: '8300.00',
          pending_orders: '3',
          pending_allocations: '2',
          yesterday_visitors: '4',
          yesterday_revenue: '7200.00',
          yesterday_paid_amount: '7000.00',
          total_paid_amount: '123456.78',
        }])
      }
      if (callIndex === 2) {
        // appointment stats
        return Promise.resolve([{ pending_appointments: '7' }])
      }
      // service stats
      return Promise.resolve([{ active_services: '1' }])
    })

    const result = await getDashboardStats()

    expect(result.roleContext).toBe('business')
    expect(result.todayVisitors).toBe(5)
    expect(result.todayRevenue).toBe(8600)
    expect(result.todayPaidAmount).toBe(8300)
    expect(result.pendingOrders).toBe(3)
    expect(result.pendingAllocations).toBe(2)
    expect(result.pendingAppointments).toBe(7)
    expect(result.activeServices).toBe(1)
    expect(result.yesterdayVisitors).toBe(4)
    expect(result.yesterdayRevenue).toBe(7200)
    expect(result.yesterdayPaidAmount).toBe(7000)
    expect(result.totalPaidAmount).toBe(123456.78)
    expect(db.execute).toHaveBeenCalledTimes(3)
  })

  it('DB 返回 null 字段 → 默认为 0（含 paid_amount 系列字段）', async () => {
    mockBusinessSession(['store-1'])

    ;(db.execute as any).mockResolvedValue([{}])

    const result = await getDashboardStats()

    expect(result.todayVisitors).toBe(0)
    expect(result.todayRevenue).toBe(0)
    expect(result.todayPaidAmount).toBe(0)
    expect(result.pendingOrders).toBe(0)
    expect(result.yesterdayPaidAmount).toBe(0)
    expect(result.totalPaidAmount).toBe(0)
  })

  it('含储值卡抵扣场景：todayRevenue 与 todayPaidAmount 可差异（前者含抵扣额）', async () => {
    mockBusinessSession(['store-1'])

    let callIndex = 0
    ;(db.execute as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 订单总额 1000（含 300 储值卡抵扣）→ paidAmount 700
        return Promise.resolve([{
          today_revenue: '1000.00',
          today_paid_amount: '700.00',
          yesterday_revenue: '0',
          yesterday_paid_amount: '0',
          total_paid_amount: '700.00',
        }])
      }
      if (callIndex === 2) return Promise.resolve([{}])
      return Promise.resolve([{}])
    })

    const result = await getDashboardStats()

    expect(result.todayRevenue).toBe(1000)
    expect(result.todayPaidAmount).toBe(700)
    // 财务口径：SUM(paid_amount) < SUM(total_amount) 在有抵扣时成立
    expect(result.todayPaidAmount).toBeLessThan(result.todayRevenue)
    expect(result.totalPaidAmount).toBe(700)
  })
})

// ── admin/hr/product 角色 ─────────────────────────────────────────────────────

describe('getDashboardStats — 非业务角色（admin/hr/product）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin → roleContext=admin + adminStats', async () => {
    mockAdminSession()
    ;(db.execute as any).mockResolvedValue([{
      total_stores: '10',
      total_employees: '50',
      total_products: '120',
      total_customers: '300',
    }])

    const result = await getDashboardStats()

    expect(result.roleContext).toBe('admin')
    expect(result.adminStats).toEqual({
      totalStores: 10,
      totalEmployees: 50,
      totalProducts: 120,
      totalCustomers: 300,
    })
    // 业务指标为零（ZERO_BUSINESS 展开）
    expect(result.todayVisitors).toBe(0)
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('hr → roleContext=hr', async () => {
    mockHrSession()
    ;(db.execute as any).mockResolvedValue([{
      total_stores: '5', total_employees: '25',
      total_products: '0', total_customers: '0',
    }])

    const result = await getDashboardStats()

    expect(result.roleContext).toBe('hr')
    expect(result.adminStats!.totalStores).toBe(5)
  })

  it('product → roleContext=product', async () => {
    mockProductSession()
    ;(db.execute as any).mockResolvedValue([{
      total_stores: '0', total_employees: '0',
      total_products: '45', total_customers: '0',
    }])

    const result = await getDashboardStats()

    expect(result.roleContext).toBe('product')
    expect(result.adminStats!.totalProducts).toBe(45)
  })

  it('adminStats DB 返回空行 → 全 0', async () => {
    mockAdminSession()
    ;(db.execute as any).mockResolvedValue([])

    const result = await getDashboardStats()

    expect(result.adminStats).toEqual({
      totalStores: 0, totalEmployees: 0,
      totalProducts: 0, totalCustomers: 0,
    })
  })
})
