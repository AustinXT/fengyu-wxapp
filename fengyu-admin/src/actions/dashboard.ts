'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'

export async function getDashboardStats(): Promise<DashboardStats> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const storeFilter = scopeIds.length > 0
    ? `AND store_id IN (${scopeIds.map(id => `'${id}'`).join(',')})`
    : 'AND FALSE'

  const orderStats = await db.execute(sql.raw(`
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
    WHERE 1=1 ${storeFilter}
  `))

  const apptStoreFilter = scopeIds.length > 0
    ? `AND store_id IN (${scopeIds.map(id => `'${id}'`).join(',')})`
    : 'AND FALSE'

  const appointmentStats = await db.execute(sql.raw(`
    SELECT COUNT(*) AS pending_appointments
    FROM appointments
    WHERE status = '待确认' ${apptStoreFilter}
  `))

  const row = (orderStats as any[])[0] ?? {}
  const apptRow = (appointmentStats as any[])[0] ?? {}

  return {
    todayVisitors: Number(row.today_visitors ?? 0),
    todayRevenue: Number(row.today_revenue ?? 0),
    pendingOrders: Number(row.pending_orders ?? 0),
    pendingAppointments: Number(apptRow.pending_appointments ?? 0),
    yesterdayVisitors: Number(row.yesterday_visitors ?? 0),
    yesterdayRevenue: Number(row.yesterday_revenue ?? 0),
  }
}
