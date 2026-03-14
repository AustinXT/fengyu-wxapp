'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'

// ─── 公共类型 ───────────────────────────────────────────────

export interface DateFilter {
  storeId?: string
  startDate?: string  // YYYY-MM-DD
  endDate?: string    // YYYY-MM-DD
}

// 校验日期格式，防止 SQL 注入
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

// 校验 storeId 格式（字母数字和连字符）
function isValidStoreId(s: string): boolean {
  return /^[\w-]+$/.test(s)
}

// 使用 $N 参数化构建安全 SQL
function buildSafeParams(
  f: DateFilter,
  scopeStoreIds: string[],
  storeCol: string,
  dateCol: string,
  startIdx = 1
): { clauses: string; params: unknown[]; nextIdx: number } {
  const clauses: string[] = []
  const params: unknown[] = []
  let idx = startIdx

  if (scopeStoreIds.length === 0) {
    clauses.push('FALSE')
  } else {
    const placeholders = scopeStoreIds.map((id, i) => {
      params.push(id)
      return `$${idx + i}`
    })
    clauses.push(`${storeCol} IN (${placeholders.join(',')})`)
    idx += scopeStoreIds.length
  }

  if (f.storeId && isValidStoreId(f.storeId)) {
    clauses.push(`${storeCol} = $${idx}`)
    params.push(f.storeId)
    idx++
  }
  if (f.startDate && isValidDate(f.startDate)) {
    clauses.push(`${dateCol} >= $${idx}`)
    params.push(f.startDate)
    idx++
  }
  if (f.endDate && isValidDate(f.endDate)) {
    clauses.push(`${dateCol} <= $${idx}`)
    params.push(f.endDate)
    idx++
  }

  return {
    clauses: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params,
    nextIdx: idx,
  }
}

// 简化版：仅 scope 过滤（无日期）— 使用白名单列名 + 安全拼接
function buildScopeFilter(scopeStoreIds: string[], storeCol = 'store_id'): string {
  if (scopeStoreIds.length === 0) return `AND FALSE`
  // scopeStoreIds 来自数据库查询结果（可信来源），额外做字符白名单校验
  const safeIds = scopeStoreIds.filter(id => /^[\w-]+$/.test(id))
  if (safeIds.length === 0) return `AND FALSE`
  return `AND ${storeCol} IN (${safeIds.map(id => `'${id}'`).join(',')})`
}

// 构建安全的过滤子句（inline filter params）
function buildInlineFilter(filter: DateFilter, storeCol = 'store_id', dateCol = 'sale_order_datetime'): string {
  const parts: string[] = []
  if (filter.storeId && isValidStoreId(filter.storeId)) {
    parts.push(`AND ${storeCol} = '${filter.storeId}'`)
  }
  if (filter.startDate && isValidDate(filter.startDate)) {
    parts.push(`AND DATE(${dateCol}) >= '${filter.startDate}'`)
  }
  if (filter.endDate && isValidDate(filter.endDate)) {
    parts.push(`AND DATE(${dateCol}) <= '${filter.endDate}'`)
  }
  return parts.join(' ')
}

// ─── Tab 1: 客户回店率 ─────────────────────────────────────

export interface ReturnRateRow {
  month: string
  totalCustomers: number
  returningCustomers: number
  returnRate: number
}

export interface StoreReturnRate {
  storeId: string
  storeName: string
  totalCustomers: number
  returningCustomers: number
  returnRate: number
}

export async function getReturnRateByMonth(filter: DateFilter = {}): Promise<ReturnRateRow[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds)
  const inlineFilter = buildInlineFilter(filter)

  const rows = await db.execute(sql.raw(`
    WITH monthly AS (
      SELECT
        TO_CHAR(DATE_TRUNC('month', sale_order_datetime), 'YYYY-MM') AS month,
        client_user_id
      FROM sale_orders
      WHERE status NOT IN ('已关闭', '支付失败')
        AND client_user_id IS NOT NULL
        ${scopeFilter} ${inlineFilter}
      GROUP BY 1, 2
    ),
    with_prev AS (
      SELECT
        m.month,
        m.client_user_id,
        CASE WHEN p.client_user_id IS NOT NULL THEN 1 ELSE 0 END AS is_return
      FROM monthly m
      LEFT JOIN monthly p
        ON m.client_user_id = p.client_user_id
        AND p.month = TO_CHAR(DATE_TRUNC('month', TO_DATE(m.month, 'YYYY-MM') - INTERVAL '1 month'), 'YYYY-MM')
    )
    SELECT
      month,
      COUNT(DISTINCT client_user_id) AS total_customers,
      COUNT(DISTINCT CASE WHEN is_return = 1 THEN client_user_id END) AS returning_customers
    FROM with_prev
    GROUP BY month
    ORDER BY month
  `))

  return (rows as Array<Record<string, unknown>>).map(r => ({
    month: String(r.month),
    totalCustomers: Number(r.total_customers),
    returningCustomers: Number(r.returning_customers),
    returnRate: Number(r.total_customers) > 0
      ? Math.round(Number(r.returning_customers) / Number(r.total_customers) * 1000) / 10
      : 0,
  }))
}

export async function getReturnRateByStore(filter: DateFilter = {}): Promise<StoreReturnRate[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds, 'o.store_id')
  const inlineFilter = buildInlineFilter(filter, 'o.store_id', 'o.sale_order_datetime')

  const rows = await db.execute(sql.raw(`
    WITH period_customers AS (
      SELECT store_id, client_user_id, COUNT(*) AS visit_count
      FROM sale_orders o
      WHERE status NOT IN ('已关闭', '支付失败')
        AND client_user_id IS NOT NULL
        ${scopeFilter} ${inlineFilter}
      GROUP BY store_id, client_user_id
    )
    SELECT
      pc.store_id,
      COALESCE(s.store_name, pc.store_id) AS store_name,
      COUNT(*) AS total_customers,
      COUNT(CASE WHEN pc.visit_count > 1 THEN 1 END) AS returning_customers
    FROM period_customers pc
    LEFT JOIN stores s ON s.store_id = pc.store_id
    GROUP BY pc.store_id, s.store_name
    ORDER BY total_customers DESC
  `))

  return (rows as Array<Record<string, unknown>>).map(r => ({
    storeId: String(r.store_id),
    storeName: String(r.store_name),
    totalCustomers: Number(r.total_customers),
    returningCustomers: Number(r.returning_customers),
    returnRate: Number(r.total_customers) > 0
      ? Math.round(Number(r.returning_customers) / Number(r.total_customers) * 1000) / 10
      : 0,
  }))
}

// ─── Tab 2: 品项占比 ────────────────────────────────────────

export interface CategoryMixRow {
  productKind: string
  orderCount: number
  totalAmount: number
  percentage: number
}

export interface ProductRankRow {
  productName: string
  productKind: string
  orderCount: number
  totalAmount: number
}

export async function getCategoryMix(filter: DateFilter = {}): Promise<CategoryMixRow[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds, 'o.store_id')
  const inlineFilter = buildInlineFilter(filter, 'o.store_id', 'o.sale_order_datetime')

  const rows = await db.execute(sql.raw(`
    SELECT
      COALESCE(pc.product_kind, '未分类') AS product_kind,
      COUNT(DISTINCT o.sale_order_id) AS order_count,
      COALESCE(SUM(si.sale_amount), 0) AS total_amount
    FROM sale_items si
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN products p ON p.product_id = ps.product_id
    LEFT JOIN product_categories pc ON pc.category_id = p.category_id
    WHERE o.status NOT IN ('已关闭', '支付失败')
      AND si.item_direction = 'purchase'
      ${scopeFilter} ${inlineFilter}
    GROUP BY pc.product_kind
    ORDER BY total_amount DESC
  `))

  const total = (rows as Array<Record<string, unknown>>).reduce((s, r) => s + Number(r.total_amount), 0)

  return (rows as Array<Record<string, unknown>>).map(r => ({
    productKind: String(r.product_kind),
    orderCount: Number(r.order_count),
    totalAmount: Number(r.total_amount),
    percentage: total > 0 ? Math.round(Number(r.total_amount) / total * 1000) / 10 : 0,
  }))
}

export async function getProductRank(filter: DateFilter = {}): Promise<ProductRankRow[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds, 'o.store_id')
  const inlineFilter = buildInlineFilter(filter, 'o.store_id', 'o.sale_order_datetime')

  const rows = await db.execute(sql.raw(`
    SELECT
      COALESCE(si.product_name, '未知商品') AS product_name,
      COALESCE(pc.product_kind, '未分类') AS product_kind,
      SUM(si.quantity) AS order_count,
      COALESCE(SUM(si.sale_amount), 0) AS total_amount
    FROM sale_items si
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN products p ON p.product_id = ps.product_id
    LEFT JOIN product_categories pc ON pc.category_id = p.category_id
    WHERE o.status NOT IN ('已关闭', '支付失败')
      AND si.item_direction = 'purchase'
      ${scopeFilter} ${inlineFilter}
    GROUP BY si.product_name, pc.product_kind
    ORDER BY total_amount DESC
    LIMIT 20
  `))

  return (rows as Array<Record<string, unknown>>).map(r => ({
    productName: String(r.product_name),
    productKind: String(r.product_kind),
    orderCount: Number(r.order_count),
    totalAmount: Number(r.total_amount),
  }))
}

// ─── Tab 3: 经营动线 ────────────────────────────────────────

export interface FunnelRow {
  stage: string
  count: number
}

export async function getOperationsFunnel(filter: DateFilter = {}): Promise<FunnelRow[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds)
  const storeClause = filter.storeId && isValidStoreId(filter.storeId) ? `AND store_id = '${filter.storeId}'` : ''
  const dateClause = filter.startDate && isValidDate(filter.startDate) ? `AND DATE(sale_order_datetime) >= '${filter.startDate}'` : ''
  const endClause = filter.endDate && isValidDate(filter.endDate) ? `AND DATE(sale_order_datetime) <= '${filter.endDate}'` : ''

  const orderRows = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS total_orders,
      COUNT(CASE WHEN status IN ('已支付', '已完成') THEN 1 END) AS paid_orders,
      COUNT(DISTINCT client_user_id) AS unique_customers
    FROM sale_orders
    WHERE status != '已关闭'
      ${scopeFilter} ${inlineFilter}
  `))

  const svcScopeFilter = buildScopeFilter(scopeIds)
  const svcStoreClause = filter.storeId && isValidStoreId(filter.storeId) ? `AND store_id = '${filter.storeId}'` : ''
  const svcDateClause = filter.startDate && isValidDate(filter.startDate) ? `AND service_date >= '${filter.startDate}'` : ''
  const svcEndClause = filter.endDate && isValidDate(filter.endDate) ? `AND service_date <= '${filter.endDate}'` : ''

  const serviceRows = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS total_services,
      COUNT(CASE WHEN status = '已完成' THEN 1 END) AS completed_services
    FROM service_orders
    WHERE 1=1
      ${svcScopeFilter} ${svcStoreClause} ${svcDateClause} ${svcEndClause}
  `))

  const apptScopeFilter = buildScopeFilter(scopeIds)
  const apptStoreClause = filter.storeId && isValidStoreId(filter.storeId) ? `AND store_id = '${filter.storeId}'` : ''
  const apptDateClause = filter.startDate && isValidDate(filter.startDate) ? `AND DATE(appointment_time) >= '${filter.startDate}'` : ''
  const apptEndClause = filter.endDate && isValidDate(filter.endDate) ? `AND DATE(appointment_time) <= '${filter.endDate}'` : ''

  const apptRows = await db.execute(sql.raw(`
    SELECT COUNT(*) AS total_appointments
    FROM appointments
    WHERE status NOT IN ('已取消', '已关闭')
      ${apptScopeFilter} ${apptStoreClause} ${apptDateClause} ${apptEndClause}
  `))

  const o = (orderRows as Array<Record<string, unknown>>)[0] ?? {}
  const s = (serviceRows as Array<Record<string, unknown>>)[0] ?? {}
  const a = (apptRows as Array<Record<string, unknown>>)[0] ?? {}

  return [
    { stage: '到店顾客', count: Number(o.unique_customers ?? 0) },
    { stage: '创建订单', count: Number(o.total_orders ?? 0) },
    { stage: '成功支付', count: Number(o.paid_orders ?? 0) },
    { stage: '预约服务', count: Number(a.total_appointments ?? 0) },
    { stage: '开始服务', count: Number(s.total_services ?? 0) },
    { stage: '完成服务', count: Number(s.completed_services ?? 0) },
  ]
}

// ─── Tab 4: 人效分析 ────────────────────────────────────────

export interface StaffEfficiencyRow {
  employeeId: string
  employeeName: string
  storeName: string
  orderCount: number
  totalRevenue: number
  avgTransaction: number
  serviceCount: number
}

export async function getStaffEfficiency(filter: DateFilter = {}): Promise<StaffEfficiencyRow[]> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds, 'o.store_id')
  const inlineFilter = buildInlineFilter(filter, 'o.store_id', 'o.sale_order_datetime')

  const svcDateFilter = filter.startDate && isValidDate(filter.startDate) ? `AND sv.service_date >= '${filter.startDate}'` : ''
  const svcEndFilter = filter.endDate && isValidDate(filter.endDate) ? `AND sv.service_date <= '${filter.endDate}'` : ''

  const rows = await db.execute(sql.raw(`
    SELECT
      e.employee_id,
      COALESCE(e.name, e.employee_id) AS employee_name,
      COALESCE(s.store_name, '') AS store_name,
      COUNT(DISTINCT o.sale_order_id) AS order_count,
      COALESCE(SUM(o.total_amount), 0) AS total_revenue,
      (SELECT COUNT(*) FROM service_orders sv
       WHERE sv.assigned_employee_id = e.employee_id
         AND sv.status = '已完成'
         ${svcDateFilter}
         ${svcEndFilter}
      ) AS service_count
    FROM staff_wechat_users e
    LEFT JOIN sale_orders o
      ON o.opened_by = e.employee_id
      AND o.status IN ('已支付', '已完成')
      ${scopeFilter} ${inlineFilter}
    LEFT JOIN stores s ON s.store_id = e.store_id
    WHERE e.is_resigned = false
    GROUP BY e.employee_id, e.name, s.store_name
    HAVING COUNT(DISTINCT o.sale_order_id) > 0
    ORDER BY total_revenue DESC
    LIMIT 50
  `))

  return (rows as Array<Record<string, unknown>>).map(r => ({
    employeeId: String(r.employee_id),
    employeeName: String(r.employee_name),
    storeName: String(r.store_name),
    orderCount: Number(r.order_count),
    totalRevenue: Number(r.total_revenue),
    avgTransaction: Number(r.order_count) > 0
      ? Math.round(Number(r.total_revenue) / Number(r.order_count) * 100) / 100
      : 0,
    serviceCount: Number(r.service_count),
  }))
}

// ─── Tab 5: 排行榜 ──────────────────────────────────────────

export interface RankingRow {
  rank: number
  name: string
  subtitle: string
  value: number
}

export async function getRankings(filter: DateFilter = {}): Promise<{
  staffByRevenue: RankingRow[]
  productsByRevenue: RankingRow[]
  customersBySpend: RankingRow[]
}> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = buildScopeFilter(scopeIds, 'o.store_id')
  const inlineFilter = buildInlineFilter(filter, 'o.store_id', 'o.sale_order_datetime')

  const staffRows = await db.execute(sql.raw(`
    SELECT
      COALESCE(e.name, o.opened_by) AS name,
      COALESCE(s.store_name, '') AS subtitle,
      COALESCE(SUM(o.total_amount), 0) AS value
    FROM sale_orders o
    LEFT JOIN staff_wechat_users e ON e.employee_id = o.opened_by
    LEFT JOIN stores s ON s.store_id = e.store_id
    WHERE o.status IN ('已支付', '已完成')
      AND o.opened_by IS NOT NULL
      ${scopeFilter} ${inlineFilter}
    GROUP BY e.name, o.opened_by, s.store_name
    ORDER BY value DESC
    LIMIT 10
  `))

  const productRows = await db.execute(sql.raw(`
    SELECT
      COALESCE(si.product_name, '未知商品') AS name,
      COALESCE(pc.product_kind, '未分类') AS subtitle,
      COALESCE(SUM(si.sale_amount), 0) AS value
    FROM sale_items si
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN products p ON p.product_id = ps.product_id
    LEFT JOIN product_categories pc ON pc.category_id = p.category_id
    WHERE o.status IN ('已支付', '已完成')
      AND si.item_direction = 'purchase'
      ${scopeFilter} ${inlineFilter}
    GROUP BY si.product_name, pc.product_kind
    ORDER BY value DESC
    LIMIT 10
  `))

  const customerRows = await db.execute(sql.raw(`
    SELECT
      COALESCE(c.name, o.client_phone, '未知顾客') AS name,
      COALESCE(c.member_level, '新客') AS subtitle,
      COALESCE(SUM(o.total_amount), 0) AS value
    FROM sale_orders o
    LEFT JOIN client_wechat_users c ON c.user_id = o.client_user_id
    WHERE o.status IN ('已支付', '已完成')
      AND o.client_user_id IS NOT NULL
      ${scopeFilter} ${inlineFilter}
    GROUP BY c.name, o.client_phone, c.member_level
    ORDER BY value DESC
    LIMIT 10
  `))

  const toRankings = (rows: unknown[]) =>
    (rows as Array<Record<string, unknown>>).map((r, i) => ({
      rank: i + 1,
      name: String(r.name),
      subtitle: String(r.subtitle),
      value: Number(r.value),
    }))

  return {
    staffByRevenue: toRankings(staffRows),
    productsByRevenue: toRankings(productRows),
    customersBySpend: toRankings(customerRows),
  }
}

// ─── 门店列表（筛选器用） ─────────────────────────────────────

export async function getStoreOptions(): Promise<Array<{ storeId: string; storeName: string }>> {
  const session = await getSession()
  requirePermission(session, 'data_center:dashboard')

  const scopeIds = session.permissions.scopeStoreIds
  const scopeFilter = scopeIds.length > 0
    ? `AND store_id IN (${scopeIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')})`
    : 'AND FALSE'

  const rows = await db.execute(sql.raw(`
    SELECT store_id, store_name FROM stores WHERE is_closed = false ${scopeFilter} ORDER BY store_name
  `))
  return (rows as Array<Record<string, unknown>>).map(r => ({
    storeId: String(r.store_id),
    storeName: String(r.store_name),
  }))
}
