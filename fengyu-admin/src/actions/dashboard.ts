'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { DashboardStats } from '@/lib/types'
import { hasRole } from '@/lib/auth'
import { withPermission } from '@/lib/with-permission'

/**
 * 业务角色看板（manager/finance）零默认值。
 *
 * 2026-04-26 sale-order-domain-refactor（2026-08 现金流口径修订）：
 *   - 组织层级营业额改为 `SUM(sale_order_payments.amount)`，按 `sop.paid_at` 归期，
 *     仅纳入首次支付/回款/退款和销售单/转换单/充值单；储值卡抵扣排除
 *   - `sale_orders.received` / `refunded_amount` 仅作订单快照，不再作为组织层级业绩源
 *   - 客流（visitors）改为 service_orders[已完成]，与 staff mgmt-dashboard 对齐
 *   - 同时保留"开单顾客数"作为辅助指标（todayOpenedCustomers）
 *   - 时区固定 Asia/Shanghai（CC7 跨午夜窗口对齐）
 *
 * **公式 / sale_order_type / status 过滤变更必须同步
 * `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`
 * 与 `dashboard.consistency.test.ts`**
 * （字面量守护：SUMMARY v3 §2 #15 / ticket notes/tickets/2026-05-17-dashboard-three-end-consistency-test.md）。
 */
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

/** 查询系统概览指标（admin/hr/product 共用） */
async function getAdminStats() {
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)
         FROM stores s
         JOIN org_nodes o ON s.org_node_id = o.id
        WHERE s.is_closed = false
          AND o.type = '门店'
          AND o.is_active = true) AS total_stores,
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

    /**
     * 业绩 / 实付 / 已退款 / 待办。
     *
     * 组织层级业绩改按付款流水净现金流：首次支付、回款、退款均按 sop.paid_at 归期，
     * 包含充值单，排除储值卡抵扣。订单数量和待办保持独立聚合，避免 payment JOIN 放大计数。
     * 时区统一 Asia/Shanghai：时间戳存的是北京墙钟字面，直接 ::date 取北京日期即可。
     */
    const orderStats = await db.execute(sql`
      WITH tz_today AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today
      ),
      bounds AS (
        SELECT today, today - 1 AS yesterday FROM tz_today
      ),
      payment_metrics AS (
        SELECT
          COALESCE(SUM(CASE
            WHEN sop.paid_at::date = (SELECT today FROM bounds)
              AND sop.status = '已支付'
              AND sop.change_type IN ('首次支付', '回款', '退款')
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN sop.amount::numeric
          END), 0) AS today_revenue,
          COALESCE(SUM(CASE
            WHEN sop.paid_at::date = (SELECT today FROM bounds)
              AND sop.status = '已支付'
              AND sop.change_type IN ('首次支付', '回款')
              AND sop.amount::numeric > 0
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN sop.amount::numeric
          END), 0) AS today_paid_amount,
          COALESCE(SUM(CASE
            WHEN sop.paid_at::date = (SELECT today FROM bounds)
              AND sop.status = '已支付'
              AND sop.change_type = '退款'
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN ABS(sop.amount::numeric)
          END), 0) AS today_refunded_amount,
          COALESCE(SUM(CASE
            WHEN sop.paid_at::date = (SELECT yesterday FROM bounds)
              AND sop.status = '已支付'
              AND sop.change_type IN ('首次支付', '回款', '退款')
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN sop.amount::numeric
          END), 0) AS yesterday_revenue,
          COALESCE(SUM(CASE
            WHEN sop.paid_at::date = (SELECT yesterday FROM bounds)
              AND sop.status = '已支付'
              AND sop.change_type IN ('首次支付', '回款')
              AND sop.amount::numeric > 0
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN sop.amount::numeric
          END), 0) AS yesterday_paid_amount,
          COALESCE(SUM(CASE
            WHEN sop.status = '已支付'
              AND sop.change_type IN ('首次支付', '回款')
              AND sop.amount::numeric > 0
              AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            THEN sop.amount::numeric
          END), 0) AS total_paid_amount
        FROM sale_order_payments sop
        JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
        WHERE so.store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
          -- 历史订单（WorkFine 核对补登）不计入经营营收（仅供会员体系重算）
          AND so.legacy_source IS DISTINCT FROM 'workfine'
      ),
      order_metrics AS (
        SELECT
          COUNT(DISTINCT CASE
            WHEN so.sale_order_datetime::date = (SELECT today FROM bounds)
              AND so.status NOT IN ('已关闭', '支付失败', '未审核', '已作废')
              AND so.sale_order_type IN ('销售单', '转换单')
            THEN so.client_user_id
          END) AS today_opened_customers,
          COUNT(CASE
            WHEN so.status = '待支付'
            THEN 1
          END) AS pending_orders,
          COUNT(CASE
            WHEN so.status IN ('已支付') AND so.allocation_status = '待分配'
              AND so.sale_order_type IN ('销售单', '转换单')
            THEN 1
          END) AS pending_allocations
        FROM sale_orders so
        WHERE so.store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})
          AND so.legacy_source IS DISTINCT FROM 'workfine'
      )
      SELECT
        payment_metrics.*,
        order_metrics.*
      FROM payment_metrics
      CROSS JOIN order_metrics
    `)

    /**
     * 客流（visitors）走 service_orders[已完成]，与 metrics.md §"客流" + mgmt-dashboard 对齐。
     * 旧实现走 sale_orders.sale_order_datetime 已废弃（audit-17 P0-17-03）。
     */
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

  // 非业务角色：返回系统概览 + 角色上下文
  const adminStats = await getAdminStats()
  const roleContext = isAdmin ? 'admin' : isHr ? 'hr' : isProduct ? 'product' : 'admin'

  return {
    ...ZERO_BUSINESS,
    roleContext,
    adminStats,
  }
})
