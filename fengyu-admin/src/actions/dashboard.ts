'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'
import { hasRole } from '@/lib/auth'
import { withPermission } from '@/lib/with-permission'


const ZERO_BUSINESS: Pick<DashboardStats,
  'todayVisitors' | 'todayRevenue' | 'todayPaidAmount' | 'todayRefundedAmount' |
  'todayOpenedCustomers' | 'pendingOrders' | 'pendingAllocations' |
  'pendingAppointments' | 'activeServices' | 'yesterdayVisitors' | 'yesterdayRevenue' |
  'yesterdayPaidAmount' | 'totalPaidAmount'
> = {
  todayVisitors: 0, todayRevenue: 0, todayPaidAmount: 0, todayRefundedAmount: 0,
  todayOpenedCustomers: 0,
  pendingOrders: 0, pendingAllocations: 0, pendingAppointments: 0, activeServices: 0,
  yesterdayVisitors: 0, yesterdayRevenue: 0, yesterdayPaidAmount: 0,
  totalPaidAmount: 0,
}


async function getAdminStats() {
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM stores WHERE is_closed = false) AS total_stores,
      (SELECT COUNT(*) FROM staff_wechat_users WHERE is_resigned = false) AS total_employees,
      (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL) AS total_products,
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

export const getDashboardStats = withPermission('dashboard:view', async (session): Promise<DashboardStats> => {
  
  const isAdmin = hasRole(session, 'admin')
  const isHr = hasRole(session, 'hr')
  const isProduct = hasRole(session, 'product')
  const hasBusiness = session.permissions.actions.includes('data_center:dashboard')

  
  if (hasBusiness) {
    const scopeIds = session.permissions.scopeStoreIds
    if (scopeIds.length === 0) {
      return { ...ZERO_BUSINESS, roleContext: 'business' }
    }

    
    const orderStats = await db.execute(sql`
      WITH tz_today AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today
      ),
      bounds AS (
        SELECT today, today - 1 AS yesterday FROM tz_today
      )
      SELECT
        COALESCE(SUM(CASE
          WHEN paid_at::date = (SELECT today FROM bounds)
            AND status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN (received::numeric - refunded_amount::numeric)
        END), 0) AS today_revenue,
        COALESCE(SUM(CASE
          WHEN paid_at::date = (SELECT today FROM bounds)
            AND status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN received::numeric
        END), 0) AS today_paid_amount,
        COALESCE(SUM(CASE
          WHEN paid_at::date = (SELECT today FROM bounds)
            AND status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN refunded_amount::numeric
        END), 0) AS today_refunded_amount,
        COUNT(DISTINCT CASE
          WHEN sale_order_datetime::date = (SELECT today FROM bounds)
            AND status NOT IN ('已关闭', '支付失败', '未审核', '已作废')
            AND sale_order_type IN ('销售单', '转换单')
          THEN client_user_id
        END) AS today_opened_customers,
        COUNT(CASE
          WHEN status = '待支付'
          THEN 1
        END) AS pending_orders,
        COUNT(CASE
          WHEN status IN ('已支付') AND allocation_status = '待分配'
            AND sale_order_type IN ('销售单', '转换单')
          THEN 1
        END) AS pending_allocations,
        COALESCE(SUM(CASE
          WHEN paid_at::date = (SELECT yesterday FROM bounds)
            AND status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN (received::numeric - refunded_amount::numeric)
        END), 0) AS yesterday_revenue,
        COALESCE(SUM(CASE
          WHEN paid_at::date = (SELECT yesterday FROM bounds)
            AND status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN received::numeric
        END), 0) AS yesterday_paid_amount,
        COALESCE(SUM(CASE
          WHEN status IN ('已支付', '已完成')
            AND sale_order_type IN ('销售单', '转换单')
          THEN received::numeric
        END), 0) AS total_paid_amount
      FROM sale_orders
      WHERE store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
        -- 历史订单（WorkFine 核对补登）不计入经营营收/待分配（仅供会员体系重算）
        AND legacy_source IS DISTINCT FROM 'workfine'
    `)

    
    const visitorStats = await db.execute(sql`
      WITH tz_today AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today
      )
      SELECT
        COUNT(DISTINCT CASE
          WHEN service_date = (SELECT today FROM tz_today)
          THEN client_user_id
        END) AS today_visitors,
        COUNT(DISTINCT CASE
          WHEN service_date = (SELECT today FROM tz_today) - 1
          THEN client_user_id
        END) AS yesterday_visitors
      FROM service_orders
      WHERE status = '已完成'
        AND client_user_id IS NOT NULL
        AND store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
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
    const visitorRow = (visitorStats as any[])[0] ?? {}
    const apptRow = (appointmentStats as any[])[0] ?? {}
    const svcRow = (serviceStats as any[])[0] ?? {}

    return {
      todayVisitors: Number(visitorRow.today_visitors ?? 0),
      todayRevenue: Number(row.today_revenue ?? 0),
      todayPaidAmount: Number(row.today_paid_amount ?? 0),
      todayRefundedAmount: Number(row.today_refunded_amount ?? 0),
      todayOpenedCustomers: Number(row.today_opened_customers ?? 0),
      pendingOrders: Number(row.pending_orders ?? 0),
      pendingAllocations: Number(row.pending_allocations ?? 0),
      pendingAppointments: Number(apptRow.pending_appointments ?? 0),
      activeServices: Number(svcRow.active_services ?? 0),
      yesterdayVisitors: Number(visitorRow.yesterday_visitors ?? 0),
      yesterdayRevenue: Number(row.yesterday_revenue ?? 0),
      yesterdayPaidAmount: Number(row.yesterday_paid_amount ?? 0),
      totalPaidAmount: Number(row.total_paid_amount ?? 0),
      roleContext: 'business',
    }
  }

  
  const adminStats = await getAdminStats()
  const roleContext = isAdmin ? 'admin' : isHr ? 'hr' : isProduct ? 'product' : 'admin'

  return {
    ...ZERO_BUSINESS,
    roleContext,
    adminStats,
  }
})
