'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'

const ZERO_STATS: DashboardStats = {
  todayVisitors: 0, todayRevenue: 0, pendingOrders: 0,
  pendingAllocations: 0, pendingAppointments: 0, activeServices: 0,
  yesterdayVisitors: 0, yesterdayRevenue: 0,
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const session = await getSession()
  requirePermission(session, 'dashboard:view')

  // 非业务角色（无 data_center:dashboard 权限）返回零值
  if (!session.permissions.actions.includes('data_center:dashboard')) {
    return ZERO_STATS
  }

  const scopeIds = session.permissions.scopeStoreIds
  if (scopeIds.length === 0) return ZERO_STATS

  // 使用参数化查询，避免 SQL 注入
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
    WHERE store_id = ANY(${scopeIds})
  `)

  const appointmentStats = await db.execute(sql`
    SELECT COUNT(*) AS pending_appointments
    FROM appointments
    WHERE status = '待确认' AND store_id = ANY(${scopeIds})
  `)

  const serviceStats = await db.execute(sql`
    SELECT COUNT(*) AS active_services
    FROM service_orders
    WHERE status = '服务中' AND store_id = ANY(${scopeIds})
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
  }
}
