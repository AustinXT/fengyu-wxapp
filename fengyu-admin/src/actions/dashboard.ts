'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'
import { getSession, hasRole } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'

const ZERO_BUSINESS: Pick<DashboardStats,
  'todayVisitors' | 'todayRevenue' | 'pendingOrders' | 'pendingAllocations' |
  'pendingAppointments' | 'activeServices' | 'yesterdayVisitors' | 'yesterdayRevenue'
> = {
  todayVisitors: 0, todayRevenue: 0, pendingOrders: 0,
  pendingAllocations: 0, pendingAppointments: 0, activeServices: 0,
  yesterdayVisitors: 0, yesterdayRevenue: 0,
}

/** 查询系统概览指标（admin/hr/product 共用） */
async function getAdminStats() {
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM stores WHERE is_closed = false) AS total_stores,
      (SELECT COUNT(*) FROM staff_wechat_users WHERE is_resigned = false) AS total_employees,
      (SELECT COUNT(*) FROM products WHERE valid_end IS NULL OR valid_end >= CURRENT_DATE) AS total_products,
      (SELECT COUNT(*) FROM client_wechat_users) AS total_customers
  `)
  const r = (rows as any[])[0] ?? {}
  return {
    totalStores: Number(r.total_stores ?? 0),
    totalEmployees: Number(r.total_employees ?? 0),
    totalProducts: Number(r.total_products ?? 0),
    totalCustomers: Number(r.total_customers ?? 0),
  }
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const session = await getSession()
  requirePermission(session, 'dashboard:view')

  // 判断角色上下文
  const isAdmin = hasRole(session, 'admin')
  const isHr = hasRole(session, 'hr')
  const isProduct = hasRole(session, 'product')
  const hasBusiness = session.permissions.actions.includes('data_center:dashboard')

  // 业务角色（manager/finance）：返回业务指标
  if (hasBusiness) {
    const scopeIds = session.permissions.scopeStoreIds
    if (scopeIds.length === 0) {
      return { ...ZERO_BUSINESS, roleContext: 'business' }
    }

    const orderStats = await db.execute(sql`
      SELECT
        COUNT(DISTINCT CASE
          WHEN DATE(sale_order_datetime) = CURRENT_DATE
            AND status NOT IN ('已关闭', '支付失败')
          THEN client_user_id
        END) AS today_visitors,
        COALESCE(SUM(CASE
          WHEN DATE(paid_at) = CURRENT_DATE
          THEN total_amount
        END), 0) AS today_revenue,
        COUNT(CASE
          WHEN status IN ('待支付', '待确认收款')
          THEN 1
        END) AS pending_orders,
        COUNT(CASE
          WHEN status IN ('已支付') AND allocation_status = 'pending'
          THEN 1
        END) AS pending_allocations,
        COUNT(DISTINCT CASE
          WHEN DATE(sale_order_datetime) = CURRENT_DATE - 1
            AND status NOT IN ('已关闭', '支付失败')
          THEN client_user_id
        END) AS yesterday_visitors,
        COALESCE(SUM(CASE
          WHEN DATE(paid_at) = CURRENT_DATE - 1
          THEN total_amount
        END), 0) AS yesterday_revenue
      FROM sale_orders
      WHERE store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
    `)

    const appointmentStats = await db.execute(sql`
      SELECT COUNT(*) AS pending_appointments
      FROM appointments
      WHERE status = '待确认' AND store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
    `)

    const serviceStats = await db.execute(sql`
      SELECT COUNT(*) AS active_services
      FROM service_orders
      WHERE status = '服务中' AND store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
    `)

    const row = (orderStats as any[])[0] ?? {}
    const apptRow = (appointmentStats as any[])[0] ?? {}
    const svcRow = (serviceStats as any[])[0] ?? {}

    return {
      todayVisitors: Number(row.today_visitors ?? 0),
      todayRevenue: Number(row.today_revenue ?? 0),
      pendingOrders: Number(row.pending_orders ?? 0),
      pendingAllocations: Number(row.pending_allocations ?? 0),
      pendingAppointments: Number(apptRow.pending_appointments ?? 0),
      activeServices: Number(svcRow.active_services ?? 0),
      yesterdayVisitors: Number(row.yesterday_visitors ?? 0),
      yesterdayRevenue: Number(row.yesterday_revenue ?? 0),
      roleContext: 'business',
    }
  }

  // 非业务角色：返回系统概览 + 角色上下文
  const adminStats = await getAdminStats()
  const roleContext = isAdmin ? 'admin' : isHr ? 'hr' : isProduct ? 'product' : 'admin'

  return {
    ...ZERO_BUSINESS,
    roleContext,
    adminStats,
  }
}
