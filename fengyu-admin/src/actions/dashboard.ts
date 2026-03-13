'use server'

import { db } from '@/db'
import { saleOrders } from '@db/order'
import { appointments } from '@db/appointment'
import { sql, eq } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'

export async function getDashboardStats(): Promise<DashboardStats> {
  // Single aggregation query for sale_orders metrics
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
  `)

  // Separate query for pending appointments
  const appointmentStats = await db.execute(sql`
    SELECT COUNT(*) AS pending_appointments
    FROM appointments
    WHERE status = '待确认'
  `)

  const row = orderStats[0] ?? {}
  const apptRow = appointmentStats[0] ?? {}

  return {
    todayVisitors: Number(row.today_visitors ?? 0),
    todayRevenue: Number(row.today_revenue ?? 0),
    pendingOrders: Number(row.pending_orders ?? 0),
    pendingAppointments: Number(apptRow.pending_appointments ?? 0),
    yesterdayVisitors: Number(row.yesterday_visitors ?? 0),
    yesterdayRevenue: Number(row.yesterday_revenue ?? 0),
  }
}
