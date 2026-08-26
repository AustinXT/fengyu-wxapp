'use server'

import { db } from '@/db'
import { serviceOrders, serviceItems, serviceReviews } from '@db/service'
import { serviceCommissions } from '@db/service-commission'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { appointments } from '@db/appointment'
import { eq, desc, and, or, sql, ilike, gte, lte, isNotNull, notExists, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceOrder, ServiceOrderStatus } from '@/lib/types'
import { scopeCondition, isInScope, isAdminScope, requireAdmin } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logTransition } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'
import { pgErrorCode } from '@/lib/pg-error'
import { hasPendingRefundByServiceOrder } from '@/lib/refund-cascade'
import { settleServiceCommissions } from '@/lib/service-commission-settle'
import { grantVisitPointsSafe } from '@/lib/visit-points'
import { parseServiceOrderFilters, parseAllocationServiceFilters } from '@/lib/list-filters'
import {
  offsetPageResult,
  resolveExportBatchLimit,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
  type ExportOffsetPage,
} from '@/lib/export-pagination'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { nowTs } from '@/lib/db-time'
import { getInvalidEmployeeAssignmentId } from '@/lib/employee-assignment-server'

function serializeServiceOrder(r: {
  service_order: typeof serviceOrders.$inferSelect
  storeName: string | null
  employeeName: string | null
  customerName: string | null
}): ServiceOrder {
  const so = r.service_order
  return {
    serviceOrderId: so.serviceOrderId,
    status: so.status as ServiceOrder['status'],
    serviceOrderType: so.serviceOrderType as ServiceOrder['serviceOrderType'],
    marketName: so.marketName,
    storeId: so.storeId,
    serviceDate: so.serviceDate,
    assignedEmployeeId: so.assignedEmployeeId,
    remark: so.remark,
    appointmentId: so.appointmentId,
    clientUserId: so.clientUserId,
    commissionStatus: so.commissionStatus ?? undefined,
    createdAt: so.createdAt.toISOString(),
    updatedAt: so.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    employeeName: r.employeeName ?? undefined,
    customerName: r.customerName ?? undefined,
  }
}

export const getServiceOrders = withPermission(
  'service:list',
  async (session): Promise<ServiceOrder[]> => {
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(scopeCondition(session, serviceOrders.storeId))
    // 默认排序：最近开始/完成/修改的服务单浮顶（admin.sys.spec.md §5）
    .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt))

  return rows.map(serializeServiceOrder)
  },
)

/** 服务单列表筛选参数 */
export interface ServiceOrderFilters {
  status?: string
  /** 服务单状态多选；由 URL `status=待服务,服务中` 解析而来。 */
  statuses?: ServiceOrderStatus[]
  marketId?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  /** 提成状态筛选（'待分配' | '已分配'，用于营业额分配页） */
  commissionStatus?: string
  page?: number
  pageSize?: number
}

/** 构建服务单列表 WHERE 条件（列表分页与导出共用） */
function buildServiceOrderConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, serviceOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(serviceOrders.status, filters.status as typeof serviceOrders.status.enumValues[number]))
  }
  if (filters.statuses?.length) {
    conditions.push(inArray(serviceOrders.status, filters.statuses))
  }
  if (filters.marketId) {
    conditions.push(storeInMarketCondition(serviceOrders.storeId, filters.marketId))
  }
  if (filters.storeId) {
    conditions.push(eq(serviceOrders.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    conditions.push(gte(serviceOrders.serviceDate, filters.dateFrom))
  }
  if (filters.dateTo) {
    conditions.push(lte(serviceOrders.serviceDate, filters.dateTo))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(serviceOrders.serviceOrderId, pattern),
        // 跨表搜索通过子查询实现，避免 JOIN 影响 COUNT
        sql`EXISTS (SELECT 1 FROM staff_wechat_users sw WHERE sw.employee_id = ${serviceOrders.assignedEmployeeId} AND sw.name ILIKE ${pattern})`,
        sql`EXISTS (SELECT 1 FROM client_wechat_users cw WHERE cw.user_id = ${serviceOrders.clientUserId} AND cw.name ILIKE ${pattern})`,
      ),
    )
  }
  if (filters.commissionStatus === '待分配' || filters.commissionStatus === '已分配') {
    conditions.push(eq(serviceOrders.commissionStatus, filters.commissionStatus))
  }

  return conditions
}

/** 分页结果 */
export interface PaginatedServiceOrders {
  data: ServiceOrder[]
  total: number
}

/**
 * 服务端分页服务单列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * 替代 getServiceOrders() 的客户端过滤模式。
 * 搜索支持：服务单号、顾客姓名、美容师姓名（跨表 ILIKE）。
 */
export const getServiceOrdersPaginated = withPermission(
  'service:list',
  async (session, filters: ServiceOrderFilters = {}): Promise<PaginatedServiceOrders> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE 条件（DB 级过滤，与导出共用同一构建器）
  const whereClause = and(...buildServiceOrderConditions(session, filters))

  // COUNT 查询
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(serviceOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  // 数据查询 — JOIN + ORDER + LIMIT/OFFSET
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    // 默认排序：最近开始/完成/修改的服务单浮顶（admin.sys.spec.md §5）
    .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt))
    .limit(pageSize)
    .offset(offset)

  return { data: rows.map(serializeServiceOrder), total }
  },
)

/**
 * 服务单管理页导出 — 「服务单消耗项目主表」（一行 = 服务单 × 一个 service_item）。
 *
 * v1.3.13 曾改为「提成分配明细」（service_commissions 主链，按被分配员工 × 服务项展开，
 * 同一服务单因多员工出现重复行）；现回归服务单主表语义：主链 service_items → service_orders，
 * **不再因多员工重复展开**，并移除员工提成维度列（负责美容师/职位/分配占比/分配额/提成比例/
 * 提成金额）——提成分配明细职责交由营业额分配-服务提成导出（exportAllocationServiceOrders）承担。
 *
 * **行为变化**：仅含 **status='已完成'** 的服务单（已原子扣减次数；含提成已分配 + 待分配），
 * 故比 v1.3.13 多包含「已完成但提成待分配」的服务单；待服务/服务中/待客户确认/已取消等未扣减
 * 次数的服务单不在导出中（service_items 创建时即落库、sessionUsed 为计划值，仅已确认后的单
 * consumeMoney 才是已实现消耗）。WHERE 强制 status='已完成'，与 selectServiceCommissionExportRows
 * （service_commissions 仅在确认时产生，天然只含已完成单）对齐。
 * 筛选沿用服务单管理列表口径（parseServiceOrderFilters：status/store/from/to/q）。
 */
export const exportServiceOrders = withPermission(
  'service:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions,
  ): Promise<ExportBatchResult<ExportServiceOrderItemRow>> => {
    return selectServiceOrderItemExportRows(
      session,
      parseServiceOrderFilters(params),
      resolveExportOffsetPage(options),
    )
  },
)

/**
 * 服务单管理页导出行（消耗项目主表级，一行 = 服务单 × 一个 service_item）。
 * 去除员工提成维度（员工/职位/分配占比/分配额/提成比例/提成金额）；保留 consumeMoney 派生列
 * （= 单次价 × 消耗次数）。金额列为 number，日期/时间为 string（前端再按时区格式化）。
 */
export interface ExportServiceOrderItemRow {
  market: string | null
  storeName: string | null
  serviceOrderId: string
  saleOrderType: string | null
  serviceOrderType: string | null
  customerName: string | null
  customerPhone: string | null
  productType: string | null
  categoryL1: string | null
  categoryL2: string | null
  productName: string | null
  sessionUsed: number | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  consumeMoney: number | null
  unitRealPrice: number | null
  status: string | null
  salesCategory: string | null
  customerType: string | null
  reviewComment: string | null
  rating: number | null
  openedByName: string | null
  sourceSaleOrderId: string | null
  serviceDate: string | null
  createdAt: string | null
  remark: string | null
}

/**
 * 服务单消耗项目主表导出查询（一行 = 一个 service_item × 其服务单）。
 * 主链 service_items → service_orders，9 表 JOIN（无 service_commissions / 负责美容师）。
 * WHERE 强制 status='已完成'（消耗明细只含已扣减次数的服务单）+ 复用 buildServiceOrderConditions
 * （搜索「美容师」走 serviceOrders.assignedEmployeeId EXISTS，不依赖提成链）。导出按筛选条件返回全量。
 */
async function selectServiceOrderItemExportRows(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
  page: ExportOffsetPage | null = null,
): Promise<ExportBatchResult<ExportServiceOrderItemRow>> {
  // 导出「消耗明细」强制 status='已完成'：service_items 在服务单创建时即落库、sessionUsed 为
  // 计划值；只有待客户确认→已完成（原子扣次数 + 计提成 + 关预约）后才是已实现消耗。否则
  // consumeMoney（= unitRealPrice × sessionUsed）会把待服务/服务中/待客户确认/已取消单的
  // 计划值计入而虚高。与 selectServiceCommissionExportRows（service_commissions 仅在确认时
  // 产生）同样只含已完成单；唯退款已完成单分流不同——本导出按物理消耗计入 consumeMoney，
  // 提成导出则排除已 void 的提成行（消耗=物理事实，提成=退款即作废）。
  const whereClause = and(
    eq(serviceOrders.status, '已完成'),
    ...buildServiceOrderConditions(session, filters),
  )

  // 开单人(=sale_orders.opened_by)；本主表不含负责美容师(=service_commissions.employee_id)
  const openedByStaff = alias(staffWechatUsers, 'staff_opened_by') as unknown as typeof staffWechatUsers

  const query = db
    .select({
      market: serviceOrders.marketName,
      storeName: stores.storeName,
      serviceOrderId: serviceOrders.serviceOrderId,
      saleOrderType: saleOrders.saleOrderType,
      serviceOrderType: serviceOrders.serviceOrderType,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fallbackPhone: saleOrders.clientPhone,
      productType: saleItems.productType,
      categoryL1: productCategories.productKind,
      categoryL2: productCategories.categoryName,
      productName: saleItems.productName,
      sessionUsed: serviceItems.sessionUsed,
      skuUnit: productSkus.unit,
      unitRealPrice: serviceItems.unitRealPrice,
      status: serviceOrders.status,
      salesCategory: serviceItems.salesCategory,
      customerType: clientWechatUsers.customerType,
      rating: serviceReviews.rating,
      reviewComment: serviceReviews.comment,
      openedByName: openedByStaff.name,
      sourceSaleOrderId: saleItems.saleOrderId,
      serviceDate: serviceOrders.serviceDate,
      createdAt: serviceOrders.createdAt,
      remark: serviceOrders.remark,
    })
    .from(serviceItems)
    .innerJoin(serviceOrders, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
    .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(openedByStaff, eq(saleOrders.openedBy, openedByStaff.employeeId))
    .leftJoin(serviceReviews, eq(serviceOrders.serviceOrderId, serviceReviews.serviceOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)
    .orderBy(desc(serviceOrders.createdAt), desc(serviceOrders.updatedAt), serviceItems.serviceItemId)
  const raw = page
    ? await query.limit(page.limit + 1).offset(page.offset)
    : await query

  const round2 = (n: number) => Math.round(n * 100) / 100
  const rows: ExportServiceOrderItemRow[] = raw.map((r) => {
    const unit = r.unitRealPrice == null ? null : Number(r.unitRealPrice)
    const sessions = r.sessionUsed ?? null
    const consumeMoney = unit == null || sessions == null ? null : round2(unit * sessions)
    return {
      market: r.market,
      storeName: r.storeName,
      serviceOrderId: r.serviceOrderId,
      saleOrderType: r.saleOrderType,
      serviceOrderType: r.serviceOrderType,
      customerName: r.customerName,
      customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
      productType: r.productType,
      categoryL1: r.categoryL1,
      categoryL2: r.categoryL2,
      productName: r.productName,
      sessionUsed: sessions,
      unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
      consumeMoney,
      unitRealPrice: unit,
      status: r.status,
      salesCategory: r.salesCategory,
      customerType: r.customerType,
      reviewComment: r.reviewComment,
      rating: r.rating ?? null,
      openedByName: r.openedByName,
      sourceSaleOrderId: r.sourceSaleOrderId,
      serviceDate: r.serviceDate,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      remark: r.remark,
    }
  })

  return offsetPageResult(rows, page)
}

/**
 * 营业额分配「服务提成」导出行（明细级，一行 = 一条 service_commissions 提成）。
 * 金额列为 number（便于 Excel 求和）；占比/比例保留 string 原值，交前端 fmtPercent 格式化；
 * 日期/时间为 string（serviceDate 为 date 串，createdAt 为 ISO 串，前端再按时区格式化）。
 */
export interface ExportAllocationServiceRow {
  market: string | null
  storeName: string | null
  serviceOrderId: string
  saleOrderType: string | null
  serviceOrderType: string | null
  customerName: string | null
  customerPhone: string | null
  productType: string | null
  categoryL1: string | null
  categoryL2: string | null
  productName: string | null
  sessionUsed: number | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  consumeMoney: number | null
  unitRealPrice: number | null
  status: string | null
  employeeName: string | null
  positionName: string | null
  allocationRatio: string | null
  allocationAmount: number | null
  commissionRate: string | null
  commissionAmount: number | null
  rating: number | null
  reviewComment: string | null
  salesCategory: string | null
  customerType: string | null
  openedByName: string | null
  sourceSaleOrderId: string | null
  serviceDate: string | null
  createdAt: string | null
  remark: string | null
}

export interface ExportAllocationServiceCursor {
  allocatedOffset: number
  missingOffset: number
  pendingOffset: number
}

function exportOffset(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0))
}

/**
 * 服务单提成分配明细导出查询（一行 = 一条有效 service_commissions）。
 * 主链 service_commissions → service_items → service_orders，12 表 JOIN。
 * 服务单管理页(exportServiceOrders) 与 营业额分配-服务提成(exportAllocationServiceOrders) 共用，
 * 仅入参 filters 的 parser 不同（列表筛选 vs 锁定已完成 + allocStatus）。导出按筛选条件返回全量。
 */
async function selectServiceCommissionExportRows(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
  page: ExportOffsetPage | null = null,
): Promise<ExportBatchResult<ExportAllocationServiceRow>> {
  // service_commissions 软删行不计入；其余筛选基于 serviceOrders 列，JOIN 后仍有效
  const whereClause = and(
    eq(serviceCommissions.isVoid, false),
    ...buildServiceOrderConditions(session, filters),
  )

  // staff_wechat_users 需两次 JOIN：负责美容师(=sc.employee_id) 与 开单人(=slo.opened_by)
  // drizzle 0.45 alias() 返回类型与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
  const openedByStaff = alias(staffWechatUsers, 'staff_opened_by') as unknown as typeof staffWechatUsers

  const query = db
    .select({
      market: serviceOrders.marketName,
      storeName: stores.storeName,
      serviceOrderId: serviceOrders.serviceOrderId,
      saleOrderType: saleOrders.saleOrderType,
      serviceOrderType: serviceOrders.serviceOrderType,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fallbackPhone: saleOrders.clientPhone,
      productType: saleItems.productType,
      categoryL1: productCategories.productKind,
      categoryL2: productCategories.categoryName,
      productName: saleItems.productName,
      sessionUsed: serviceItems.sessionUsed,
      skuUnit: productSkus.unit,
      unitRealPrice: serviceItems.unitRealPrice,
      status: serviceOrders.status,
      employeeName: staffWechatUsers.name,
      positionName: staffWechatUsers.positionName,
      allocationRatio: serviceCommissions.allocationRatio,
      commissionRate: serviceCommissions.commissionRate,
      commissionAmount: serviceCommissions.commissionAmount,
      rating: serviceReviews.rating,
      reviewComment: serviceReviews.comment,
      salesCategory: serviceItems.salesCategory,
      customerType: clientWechatUsers.customerType,
      openedByName: openedByStaff.name,
      sourceSaleOrderId: saleItems.saleOrderId,
      serviceDate: serviceOrders.serviceDate,
      createdAt: serviceOrders.createdAt,
      remark: serviceOrders.remark,
      scId: serviceCommissions.id,
    })
    .from(serviceCommissions)
    .innerJoin(serviceItems, eq(serviceCommissions.serviceItemId, serviceItems.serviceItemId))
    .innerJoin(serviceOrders, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
    .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(staffWechatUsers, eq(serviceCommissions.employeeId, staffWechatUsers.employeeId))
    .leftJoin(openedByStaff, eq(saleOrders.openedBy, openedByStaff.employeeId))
    .leftJoin(serviceReviews, eq(serviceOrders.serviceOrderId, serviceReviews.serviceOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)
    // 段内 orderBy 主键须为 createdAt：exportAllocationServiceOrders 合并层按 createdAt desc 做全量合并排序。
    // 本 helper 与 exportServiceOrders（服务单管理页导出）共用，导出以 createdAt 为自然序同样合理。
    .orderBy(desc(serviceOrders.createdAt), desc(serviceOrders.updatedAt), serviceCommissions.id)
  const raw = page
    ? await query.limit(page.limit + 1).offset(page.offset)
    : await query

  const round2 = (n: number) => Math.round(n * 100) / 100
  const rows: ExportAllocationServiceRow[] = raw.map((r) => {
    const unit = r.unitRealPrice == null ? null : Number(r.unitRealPrice)
    const sessions = r.sessionUsed ?? null
    const consumeMoney = unit == null || sessions == null ? null : round2(unit * sessions)
    const ratioNum = r.allocationRatio == null ? null : Number(r.allocationRatio)
    const allocationAmount =
      consumeMoney == null || ratioNum == null ? null : round2(consumeMoney * ratioNum)
    return {
      market: r.market,
      storeName: r.storeName,
      serviceOrderId: r.serviceOrderId,
      saleOrderType: r.saleOrderType,
      serviceOrderType: r.serviceOrderType,
      customerName: r.customerName,
      customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
      productType: r.productType,
      categoryL1: r.categoryL1,
      categoryL2: r.categoryL2,
      productName: r.productName,
      sessionUsed: sessions,
      unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
      consumeMoney,
      unitRealPrice: unit,
      status: r.status,
      employeeName: r.employeeName,
      positionName: r.positionName,
      allocationRatio: r.allocationRatio,
      allocationAmount,
      commissionRate: r.commissionRate,
      commissionAmount: r.commissionAmount == null ? null : Number(r.commissionAmount),
      rating: r.rating ?? null,
      reviewComment: r.reviewComment,
      salesCategory: r.salesCategory,
      customerType: r.customerType,
      openedByName: r.openedByName,
      sourceSaleOrderId: r.sourceSaleOrderId,
      serviceDate: r.serviceDate,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      remark: r.remark,
    }
  })

  return offsetPageResult(rows, page)
}

/**
 * 服务提成导出「待分配」占位段（一行 = 一个已完成但 commission_status='待分配' 的服务单 × service_item）。
 * 无 service_commissions，分配/提成/评价列留空；与 selectServiceCommissionExportRows（已分配段）粒度对称。
 * 仅 exportAllocationServiceOrders 使用，不影响服务单管理页导出（exportServiceOrders）。
 */
async function selectPendingServiceCommissionExportRows(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
  page: ExportOffsetPage | null = null,
): Promise<ExportBatchResult<ExportAllocationServiceRow>> {
  const whereClause = and(
    eq(serviceOrders.commissionStatus, '待分配'),
    eq(serviceOrders.status, '已完成'),
    ...buildServiceOrderConditions(session, { ...filters, commissionStatus: undefined }),
  )

  // staff_wechat_users 两次 JOIN 之一：开单人(=slo.opened_by)；占位段无负责美容师(=sc.employee_id)
  const openedByStaff = alias(staffWechatUsers, 'staff_opened_by') as unknown as typeof staffWechatUsers

  const query = db
    .select({
      market: serviceOrders.marketName,
      storeName: stores.storeName,
      serviceOrderId: serviceOrders.serviceOrderId,
      saleOrderType: saleOrders.saleOrderType,
      serviceOrderType: serviceOrders.serviceOrderType,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fallbackPhone: saleOrders.clientPhone,
      productType: saleItems.productType,
      categoryL1: productCategories.productKind,
      categoryL2: productCategories.categoryName,
      productName: saleItems.productName,
      sessionUsed: serviceItems.sessionUsed,
      skuUnit: productSkus.unit,
      unitRealPrice: serviceItems.unitRealPrice,
      status: serviceOrders.status,
      salesCategory: serviceItems.salesCategory,
      customerType: clientWechatUsers.customerType,
      openedByName: openedByStaff.name,
      sourceSaleOrderId: saleItems.saleOrderId,
      serviceDate: serviceOrders.serviceDate,
      createdAt: serviceOrders.createdAt,
      remark: serviceOrders.remark,
    })
    .from(serviceOrders)
    .innerJoin(serviceItems, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
    .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(openedByStaff, eq(saleOrders.openedBy, openedByStaff.employeeId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)
    // 同 selectServiceCommissionExportRows：主键 createdAt，与 exportAllocationServiceOrders 合并层排序键一致
    .orderBy(desc(serviceOrders.createdAt), desc(serviceOrders.updatedAt), serviceItems.serviceItemId)
  const raw = page
    ? await query.limit(page.limit + 1).offset(page.offset)
    : await query

  const round2 = (n: number) => Math.round(n * 100) / 100
  const rows: ExportAllocationServiceRow[] = raw.map((r) => {
    const unit = r.unitRealPrice == null ? null : Number(r.unitRealPrice)
    const sessions = r.sessionUsed ?? null
    const consumeMoney = unit == null || sessions == null ? null : round2(unit * sessions)
    return {
      market: r.market,
      storeName: r.storeName,
      serviceOrderId: r.serviceOrderId,
      saleOrderType: r.saleOrderType,
      serviceOrderType: r.serviceOrderType,
      customerName: r.customerName,
      customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
      productType: r.productType,
      categoryL1: r.categoryL1,
      categoryL2: r.categoryL2,
      productName: r.productName,
      sessionUsed: sessions,
      unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
      consumeMoney,
      unitRealPrice: unit,
      status: r.status,
      // 待分配：无 service_commissions，分配/提成/评价列留空
      employeeName: null,
      positionName: null,
      allocationRatio: null,
      allocationAmount: null,
      commissionRate: null,
      commissionAmount: null,
      rating: null,
      reviewComment: null,
      salesCategory: r.salesCategory,
      customerType: r.customerType,
      openedByName: r.openedByName,
      sourceSaleOrderId: r.sourceSaleOrderId,
      serviceDate: r.serviceDate,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      remark: r.remark,
    }
  })

  return offsetPageResult(rows, page)
}

/**
 * 已分配服务单缺失有效提成明细时的占位段（一行 = 一个没有 active service_commissions 的 service_item）。
 * 典型场景：寄存单退款专用服务单会真扣次数但不计业绩，确认时仍置 commission_status='已分配'。
 */
async function selectMissingAllocatedServiceCommissionExportRows(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
  page: ExportOffsetPage | null = null,
): Promise<ExportBatchResult<ExportAllocationServiceRow>> {
  const whereClause = and(
    eq(serviceOrders.commissionStatus, '已分配'),
    eq(serviceOrders.status, '已完成'),
    sql`NOT EXISTS (
      SELECT 1
        FROM service_commissions sc_active
       WHERE sc_active.service_item_id = ${serviceItems.serviceItemId}
         AND sc_active.is_void = false
    )`,
    ...buildServiceOrderConditions(session, { ...filters, commissionStatus: undefined }),
  )

  const openedByStaff = alias(staffWechatUsers, 'staff_opened_by') as unknown as typeof staffWechatUsers

  const query = db
    .select({
      market: serviceOrders.marketName,
      storeName: stores.storeName,
      serviceOrderId: serviceOrders.serviceOrderId,
      saleOrderType: saleOrders.saleOrderType,
      serviceOrderType: serviceOrders.serviceOrderType,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fallbackPhone: saleOrders.clientPhone,
      productType: saleItems.productType,
      categoryL1: productCategories.productKind,
      categoryL2: productCategories.categoryName,
      productName: saleItems.productName,
      sessionUsed: serviceItems.sessionUsed,
      skuUnit: productSkus.unit,
      unitRealPrice: serviceItems.unitRealPrice,
      status: serviceOrders.status,
      employeeName: staffWechatUsers.name,
      positionName: staffWechatUsers.positionName,
      rating: serviceReviews.rating,
      reviewComment: serviceReviews.comment,
      salesCategory: serviceItems.salesCategory,
      customerType: clientWechatUsers.customerType,
      openedByName: openedByStaff.name,
      sourceSaleOrderId: saleItems.saleOrderId,
      serviceDate: serviceOrders.serviceDate,
      createdAt: serviceOrders.createdAt,
      remark: serviceOrders.remark,
    })
    .from(serviceOrders)
    .innerJoin(serviceItems, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
    .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(staffWechatUsers, eq(serviceItems.employeeId, staffWechatUsers.employeeId))
    .leftJoin(openedByStaff, eq(saleOrders.openedBy, openedByStaff.employeeId))
    .leftJoin(serviceReviews, eq(serviceOrders.serviceOrderId, serviceReviews.serviceOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)
    .orderBy(desc(serviceOrders.createdAt), desc(serviceOrders.updatedAt), serviceItems.serviceItemId)
  const raw = page
    ? await query.limit(page.limit + 1).offset(page.offset)
    : await query

  const round2 = (n: number) => Math.round(n * 100) / 100
  const rows: ExportAllocationServiceRow[] = raw.map((r) => {
    const unit = r.unitRealPrice == null ? null : Number(r.unitRealPrice)
    const sessions = r.sessionUsed ?? null
    const isDepositRefund = r.remark === DEPOSIT_REFUND_REMARK
    const consumeMoney =
      isDepositRefund ? 0 : unit == null || sessions == null ? null : round2(unit * sessions)
    return {
      market: r.market,
      storeName: r.storeName,
      serviceOrderId: r.serviceOrderId,
      saleOrderType: r.saleOrderType,
      serviceOrderType: r.serviceOrderType,
      customerName: r.customerName,
      customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
      productType: r.productType,
      categoryL1: r.categoryL1,
      categoryL2: r.categoryL2,
      productName: r.productName,
      sessionUsed: sessions,
      unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
      consumeMoney,
      unitRealPrice: unit,
      status: r.status,
      employeeName: r.employeeName,
      positionName: r.positionName,
      allocationRatio: null,
      allocationAmount: null,
      commissionRate: null,
      commissionAmount: null,
      rating: r.rating ?? null,
      reviewComment: r.reviewComment,
      salesCategory: r.salesCategory,
      customerType: r.customerType,
      openedByName: r.openedByName,
      sourceSaleOrderId: r.sourceSaleOrderId,
      serviceDate: r.serviceDate,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      remark: r.remark,
    }
  })

  return offsetPageResult(rows, page)
}

/**
 * 导出营业额分配「服务提成」（allocStatus 三态分流，合并后按 createdAt desc 返回全量）：
 * - 全部：已分配明细（service_commissions 主链）∪ 已分配缺明细占位 ∪ 待分配占位；
 * - 已分配：明细段 + 缺明细占位；待分配：仅占位段（分配/提成列留空）。
 * 列表筛选 parseAllocationServiceFilters 锁定 status='已完成'；导出各段按 commission_status 各自控制，
 * 不依赖 buildServiceOrderConditions 的 commissionStatus 分支（该分支仍服务列表侧）。
 */
export const exportAllocationServiceOrders = withPermission(
  'service:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions<ExportAllocationServiceCursor>,
  ): Promise<ExportBatchResult<ExportAllocationServiceRow, ExportAllocationServiceCursor>> => {
    const parsedFilters = parseAllocationServiceFilters(params)
    const commissionStatus = parsedFilters.commissionStatus
    const baseFilters = { ...parsedFilters, commissionStatus: undefined }
    const limit = resolveExportBatchLimit(options?.limit)
    const cursor: ExportAllocationServiceCursor = {
      allocatedOffset: exportOffset(options?.cursor?.allocatedOffset),
      missingOffset: exportOffset(options?.cursor?.missingOffset),
      pendingOffset: exportOffset(options?.cursor?.pendingOffset),
    }
    const pageFor = (offset: number): ExportOffsetPage | null =>
      limit == null ? null : { limit, offset }
    const merged: Array<{
      row: ExportAllocationServiceRow
      sort: number
      source: 'allocated' | 'missing' | 'pending'
    }> = []
    let allocatedCandidateCount = 0
    let missingCandidateCount = 0
    let pendingCandidateCount = 0
    let allocatedHasMore = false
    let missingHasMore = false
    let pendingHasMore = false

    if (commissionStatus !== '待分配') {
      const allocatedFilters = {
        ...baseFilters,
        commissionStatus: commissionStatus === '已分配' ? '已分配' : undefined,
      }
      const result = await selectServiceCommissionExportRows(
        session,
        allocatedFilters,
        pageFor(cursor.allocatedOffset),
      )
      allocatedCandidateCount = result.rows.length
      allocatedHasMore = result.hasMore
      for (const r of result.rows) {
        merged.push({ row: r, sort: r.createdAt ? Date.parse(r.createdAt) : 0, source: 'allocated' })
      }

      const missingResult = await selectMissingAllocatedServiceCommissionExportRows(
        session,
        baseFilters,
        pageFor(cursor.missingOffset),
      )
      missingCandidateCount = missingResult.rows.length
      missingHasMore = missingResult.hasMore
      for (const r of missingResult.rows) {
        merged.push({ row: r, sort: r.createdAt ? Date.parse(r.createdAt) : 0, source: 'missing' })
      }
    }
    if (commissionStatus !== '已分配') {
      const result = await selectPendingServiceCommissionExportRows(
        session,
        baseFilters,
        pageFor(cursor.pendingOffset),
      )
      pendingCandidateCount = result.rows.length
      pendingHasMore = result.hasMore
      for (const r of result.rows) {
        merged.push({ row: r, sort: r.createdAt ? Date.parse(r.createdAt) : 0, source: 'pending' })
      }
    }

    const sourceOrder = { allocated: 0, missing: 1, pending: 2 } as const
    merged.sort((left, right) => {
      const byTime = right.sort - left.sort
      if (byTime !== 0 || limit == null) return byTime
      return sourceOrder[left.source] - sourceOrder[right.source]
    })
    const selected = limit == null ? merged : merged.slice(0, limit)
    const rows = selected.map((item) => item.row)
    if (limit == null) return { rows, truncated: false, hasMore: false }

    const allocatedCount = selected.filter((item) => item.source === 'allocated').length
    const missingCount = selected.filter((item) => item.source === 'missing').length
    const pendingCount = selected.length - allocatedCount - missingCount
    const hasMore =
      allocatedCandidateCount > allocatedCount ||
      missingCandidateCount > missingCount ||
      pendingCandidateCount > pendingCount ||
      allocatedHasMore ||
      missingHasMore ||
      pendingHasMore
    return {
      rows,
      truncated: false,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: {
              allocatedOffset: cursor.allocatedOffset + allocatedCount,
              missingOffset: cursor.missingOffset + missingCount,
              pendingOffset: cursor.pendingOffset + pendingCount,
            },
          }
        : {}),
    }
  },
)

export const getServiceOrderById = withPermission(
  'service:list',
  async (session, serviceOrderId: string): Promise<ServiceOrder | null> => {
  // 交易数据跟顾客走：详情读取不限门店 scope（顾客档案「服务记录」可跨门店点进只读查看）。
  // 越权写入安全边界由各 mutation action 自带的 scopeCondition 守护；本读取仅标记 readOnly。
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (rows.length === 0) return null
  return {
    ...serializeServiceOrder(rows[0]),
    readOnly: !isInScope(session, rows[0].service_order.storeId),
  }
  },
)

export interface ServiceItemDetail {
  serviceItemId: string
  saleItemId: string
  sessionUsed: number
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  unitRealPrice: string | null
  employeeName: string | null
  employeeId: string | null
  productName: string | null
  skuName: string | null
  salesCategory: string | null
  remainingSessions: number | null
  sessionCount: number | null
  paidSessions: number | null
  quantity: number | null
}

export const getServiceItems = withPermission(
  'service:list',
  async (_session, serviceOrderId: string): Promise<ServiceItemDetail[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.service_item_id,
      si.sale_item_id,
      si.session_used,
      si.unit_real_price,
      si.employee_id,
      e.name AS employee_name,
      sli.product_name,
      COALESCE(ps.unit, CASE WHEN sli.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      NULL::text AS sku_name,
      sli.sales_category,
      sli.remaining_sessions,
      sli.session_count,
      sli.paid_sessions,
      sli.quantity AS sli_quantity
    FROM service_items si
    LEFT JOIN staff_wechat_users e ON e.employee_id = si.employee_id
    LEFT JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
    LEFT JOIN product_skus ps ON ps.sku_id = sli.sku_id
    WHERE si.service_order_id = ${serviceOrderId}
  `)

  return (rows as any[]).map((r: any) => ({
    serviceItemId: r.service_item_id,
    saleItemId: r.sale_item_id,
    sessionUsed: Number(r.session_used),
    unit: r.unit ?? '次',
    unitRealPrice: r.unit_real_price,
    employeeName: r.employee_name,
    employeeId: r.employee_id,
    productName: r.product_name,
    skuName: r.sku_name ?? null,
    salesCategory: r.sales_category ?? null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
    paidSessions: r.paid_sessions !== null && r.paid_sessions !== undefined ? Number(r.paid_sessions) : null,
    quantity: r.sli_quantity !== null && r.sli_quantity !== undefined ? Number(r.sli_quantity) : null,
  }))
  },
)

/** 顾客对已完成服务单的评价（一单一评，service_order_id 作 PK） */
export interface ServiceReview {
  rating: number
  comment: string | null
  createdAt: string
}

export const getServiceReview = withPermission(
  'service:list',
  async (_session, serviceOrderId: string): Promise<ServiceReview | null> => {
    const rows = await db
      .select({
        rating: serviceReviews.rating,
        comment: serviceReviews.comment,
        createdAt: serviceReviews.createdAt,
      })
      .from(serviceReviews)
      .where(eq(serviceReviews.serviceOrderId, serviceOrderId))
      .limit(1)
    if (rows.length === 0) return null
    return {
      rating: rows[0].rating,
      comment: rows[0].comment,
      createdAt: rows[0].createdAt.toISOString(),
    }
  },
)

/** 顾客可用服务项目（有效收款订单中有已付未用次数的疗程卡权益：购买行 + 转换单转入行） */
export interface AvailableSaleItem {
  saleItemId: string
  saleItemGroupId: string | null
  saleOrderId: string
  saleOrderDatetime: string | null
  paidAt: string | null
  orderStatus: string
  saleOrderType: string
  documentType: string | null
  marketName: string
  legacySource: string | null
  storeId: string
  skuId: string | null
  itemDirection: string
  refSaleItemId: string | null
  productName: string | null
  productType: string | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  /** 一级品项（历史无分类卡为 null） */
  productKind: string | null
  /** 二级品项 ID（历史无分类卡为 null） */
  categoryId: string | null
  /** 二级品项名称（历史无分类卡为 null） */
  categoryName: string | null
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  quantity: number
  /** 可用次数（已付未用）；paidSessions 为 NULL 时退回物理剩余。步进器 max 用此值 */
  paidUnusedSessions: number
  unitPrice: string
  unitRealPrice: string
  saleAmount: string
  received: string
  pendingReceived: string
  expireDate: string | null
  remark: string | null
  salesCategory: string | null
}

export const getAvailableSaleItems = withPermission(
  'service:create',
  async (_session, clientUserId: string): Promise<AvailableSaleItem[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.sale_item_id,
      si.sale_item_group_id,
      si.sale_order_id,
      o.sale_order_datetime,
      o.paid_at,
      o.status AS order_status,
      o.sale_order_type,
      o.document_type,
      o.market_name,
      o.legacy_source,
      si.store_id,
      si.sku_id,
      si.item_direction,
      si.ref_sale_item_id,
      si.product_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      si.quantity,
      si.unit_price,
      si.unit_real_price,
      si.sale_amount,
      si.received,
      si.pending_received,
      si.expire_date,
      si.remark,
      si.sales_category,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      ps.category_id,
      pc.category_name,
      pc.product_kind
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status IN ('已支付', '部分支付', '已完成')
      AND (
        si.item_direction = '购买'
        OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
      )
      AND si.product_type = '疗程卡'
      AND si.remaining_sessions IS NOT NULL
      AND si.remaining_sessions > 0
      AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- #5 收紧到「已付未用」口径：只列出还有已付未用次数的卡（paid <= used 即欠款已用满则排除）。
      -- 推翻 2026-05-20 D6=A 放宽决策，与 staff service-create 的 consumable 门控对齐。
      -- 历史 NULL 行（paid_sessions IS NULL）视作物理剩余可用，不排除。
      AND (
        si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )
    ORDER BY o.paid_at DESC, si.sale_item_id
  `)

  return (rows as any[]).map((r: any) => {
    const total = r.session_count !== null ? Number(r.session_count) : 0
    const remain = r.remaining_sessions !== null ? Number(r.remaining_sessions) : 0
    const paid = (r.paid_sessions !== null && r.paid_sessions !== undefined) ? Number(r.paid_sessions) : null
    const used = Math.max(total - remain, 0)
    return {
      saleItemId: r.sale_item_id,
      saleItemGroupId: r.sale_item_group_id ?? null,
      saleOrderId: r.sale_order_id,
      saleOrderDatetime: r.sale_order_datetime instanceof Date
        ? r.sale_order_datetime.toISOString()
        : (r.sale_order_datetime ?? null),
      paidAt: r.paid_at instanceof Date ? r.paid_at.toISOString() : (r.paid_at ?? null),
      orderStatus: r.order_status,
      saleOrderType: r.sale_order_type,
      documentType: r.document_type ?? null,
      marketName: r.market_name ?? '',
      legacySource: r.legacy_source ?? null,
      storeId: r.store_id,
      skuId: r.sku_id ?? null,
      itemDirection: r.item_direction,
      refSaleItemId: r.ref_sale_item_id ?? null,
      productName: r.product_name,
      productType: r.product_type,
      unit: r.unit ?? (r.product_type === '家居产品' ? '盒' : '次'),
      productKind: r.product_kind ?? null,
      categoryId: r.category_id ?? null,
      categoryName: r.category_name ?? null,
      sessionCount: r.session_count !== null ? Number(r.session_count) : null,
      remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
      paidSessions: r.paid_sessions !== null && r.paid_sessions !== undefined ? Number(r.paid_sessions) : null,
      quantity: Number(r.quantity ?? 1),
      paidUnusedSessions: paid === null ? remain : Math.max(0, paid - used),
      unitPrice: r.unit_price ?? '0',
      unitRealPrice: r.unit_real_price ?? '0',
      saleAmount: r.sale_amount ?? '0',
      received: r.received ?? '0',
      pendingReceived: r.pending_received ?? '0',
      expireDate: r.expire_date,
      remark: r.remark ?? null,
      salesCategory: r.sales_category ?? null,
    }
  })
  },
)

/** C4: 开始服务 — WHERE status = '待服务' */
export const startServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [svcCtx] = await db
    .select({
      assignedEmployeeId: serviceOrders.assignedEmployeeId,
      employeeName: staffWechatUsers.name,
      clientUserId: serviceOrders.clientUserId,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  type StartOutcome =
    | { kind: 'started' }
    | { kind: 'state_changed' }
    | { kind: 'insufficient_balance'; message: string }

  let outcome: StartOutcome
  try {
    outcome = await db.transaction(async (tx) => {
      // 与转换单争用同一批 sale_items 行锁，按 sale_item_id 固定顺序避免多卡服务死锁。
      // 必须先取得行锁，再单独汇总预扣；把汇总放进同一 SELECT 的标量子查询，
      // 无法保证子查询一定在 FOR UPDATE 之后求值。
      const lockRows = await tx.execute(sql`
        SELECT
          sit.service_item_id,
          sit.sale_item_id,
          sit.session_used,
          si.remaining_sessions,
          si.session_count,
          si.paid_sessions,
          si.product_type
        FROM service_items sit
        INNER JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
        WHERE sit.service_order_id = ${serviceOrderId}
        ORDER BY si.sale_item_id, sit.service_item_id
        FOR UPDATE OF si
      `)

      const lockedRows = Array.from(lockRows as unknown as Iterable<Record<string, unknown>>)
      const saleItemIds = [...new Set(lockedRows.map((row) => String(row.sale_item_id)))]
      const reservedRows = saleItemIds.length === 0
        ? []
        : await tx.execute(sql`
            SELECT reserved_item.sale_item_id,
                   COALESCE(SUM(reserved_item.session_used), 0) AS total_reserved
            FROM service_items reserved_item
            INNER JOIN service_orders reserved_order
              ON reserved_order.service_order_id = reserved_item.service_order_id
            WHERE reserved_item.sale_item_id IN (${sql.join(saleItemIds.map((id) => sql`${id}`), sql`, `)})
              AND reserved_item.reserved_at IS NOT NULL
              AND reserved_item.service_order_id <> ${serviceOrderId}
              AND reserved_order.status IN ('服务中', '待客户确认')
            GROUP BY reserved_item.sale_item_id
          `)
      const reservedBySaleItemId = new Map(
        Array.from(reservedRows as unknown as Iterable<Record<string, unknown>>)
          .map((row) => [String(row.sale_item_id), Number(row.total_reserved ?? 0)] as const),
      )

      const cards = new Map<string, {
        remaining: number
        sessionCount: number | null
        paidSessions: number | null
        productType: string | null
        totalReserved: number
        requested: number
      }>()
      for (const row of lockedRows) {
        const saleItemId = String(row.sale_item_id)
        const existing = cards.get(saleItemId)
        if (existing) {
          existing.requested += Number(row.session_used ?? 0)
          continue
        }
        cards.set(saleItemId, {
          remaining: Number(row.remaining_sessions ?? 0),
          sessionCount: row.session_count === null ? null : Number(row.session_count),
          paidSessions: row.paid_sessions === null ? null : Number(row.paid_sessions),
          productType: (row.product_type as string | null) ?? null,
          totalReserved: reservedBySaleItemId.get(saleItemId) ?? 0,
          requested: Number(row.session_used ?? 0),
        })
      }

      for (const [saleItemId, card] of cards) {
        if (card.productType !== '疗程卡') continue
        const remainingAvailable = card.remaining - card.totalReserved
        const paidAvailable = card.sessionCount === null
          ? Number.POSITIVE_INFINITY
          : (card.paidSessions ?? card.sessionCount)
            - (card.sessionCount - card.remaining)
            - card.totalReserved
        const available = Math.min(remainingAvailable, paidAvailable)
        if (available < card.requested) {
          return {
            kind: 'insufficient_balance' as const,
            message: `订单行 ${saleItemId} 可用次数不足（剩余 ${card.remaining}，已预留 ${card.totalReserved}，本次需 ${card.requested}）`,
          }
        }
      }

      const startedAt = nowTs()
      const result = await tx
        .update(serviceOrders)
        .set({ status: '服务中', startedAt })
        .where(and(
          eq(serviceOrders.serviceOrderId, serviceOrderId),
          eq(serviceOrders.status, '待服务'),
          scopeCondition(session, serviceOrders.storeId),
        ))
      if ((result as any).count === 0) {
        return { kind: 'state_changed' as const }
      }

      // 仅在状态 CAS 成功后写预扣；若状态已被其它端推进，整个事务不会释放/覆盖其预扣。
      await tx.execute(sql`
        UPDATE service_items
        SET reserved_at = ${startedAt}, updated_at = ${startedAt}
        WHERE service_order_id = ${serviceOrderId}
          AND reserved_at IS NULL
      `)
      return { kind: 'started' as const }
    })
  } catch {
    return { success: false, message: '开始服务失败，请稍后重试' }
  }

  if (outcome.kind === 'state_changed') {
    return { success: false, message: '服务单状态已变更，无法开始' }
  }
  if (outcome.kind === 'insufficient_balance') {
    return { success: false, message: outcome.message }
  }

  await logTransition(session, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已开始' }
  },
)

/**
 * C4: 员工标记完成服务 — 服务中 → 待客户确认（轻量，仅翻状态 + 记 staff_completed_at）
 *
 * 不扣次数 / 不关预约——这些副作用推迟到顾客确认（confirmServiceOrder）。
 * scope 通过预检查实现：非 admin 先验证服务单归属。
 */
export const completeServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志 + 非 admin scope 预检查
  const [svcCtx] = await db
    .select({
      storeId: serviceOrders.storeId,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0 || !svcCtx || !scopeStoreIds.includes(svcCtx.storeId)) {
      return { success: false, message: '无权操作该服务单' }
    }
  }

  let result: any
  try {
    result = await db
      .update(serviceOrders)
      .set({ status: '待客户确认', staffCompletedAt: nowTs() })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '服务中'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '标记完成失败，请稍后重试' }
  }

  if ((result as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }

  await logTransition(session, 'service.complete', 'service_order', serviceOrderId, '服务中', '待客户确认', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '已标记完成，待客户确认' }
  },
)

/**
 * C1+C4: 后台代客户确认服务 — 待客户确认 → 已完成（原子扣减 remaining_sessions + 状态推进）
 *
 * 兜底入口：顾客不便用小程序时由后台 / 店长代确认。执行 finalize 副作用（扣次数）。
 * scope 通过预检查实现：非 admin 先验证服务单归属，再执行原子 SQL。
 */
export const confirmServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志 + 非 admin scope 预检查
  const [svcCtx] = await db
    .select({
      storeId: serviceOrders.storeId,
      serviceOrderType: serviceOrders.serviceOrderType,
      serviceDate: serviceOrders.serviceDate,
      clientUserId: serviceOrders.clientUserId,
      remark: serviceOrders.remark,
      hasPositiveItem: sql<boolean>`EXISTS (
        SELECT 1 FROM service_items sit
        WHERE sit.service_order_id = ${serviceOrders.serviceOrderId}
          AND COALESCE(sit.unit_real_price, 0) > 0
      )`,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0 || !svcCtx || !scopeStoreIds.includes(svcCtx.storeId)) {
      return { success: false, message: '无权操作该服务单' }
    }
  }

  // 冻结闭环（Bug I）：关联订单退款审批中禁止确认核销。两端镜像 staff service.js
  if (await hasPendingRefundByServiceOrder(db, serviceOrderId)) {
    return { success: false, message: '关联订单退款审批中，暂不可确认' }
  }

  // 扣减次数 + 置已完成 + 写服务提成，全部在同一事务内（任一步失败整体回滚）。
  // D6=A 不变量（2026-05-19 ticket）：分期付款的卡只能消费"已支付"的那部分次数。
  // 扣减条件叠加 paid_sessions 限额——扣减后已用次数
  //   (session_count - remaining_sessions + session_used) 不得超 COALESCE(paid_sessions, session_count)。
  // 与 staff service.js:407 一致；paid_sessions NULL 视为 session_count（兼容历史/旧 fixture）。
  // 服务提成写入（settleServiceCommissions）镜像 staff/client finalizeServiceOrder：
  //   三端 confirm/finalize 都应产出 service_commissions + commission_status='已分配'。
  // 预扣在扣减和状态推进全部成功前始终保留；这样转换单拿到 sale_items 锁时只会使用未预扣的次数。
  let outcome: { kind: 'ok' } | { kind: 'status_changed' }
  try {
    outcome = await db.transaction(async (tx) => {
      // 按稳定顺序先锁卡行，和 service.start / conversion 共用同一把锁。
      await tx.execute(sql`
        SELECT si.sale_item_id
        FROM sale_items si
        INNER JOIN service_items sit ON sit.sale_item_id = si.sale_item_id
        WHERE sit.service_order_id = ${serviceOrderId}
        ORDER BY si.sale_item_id
        FOR UPDATE OF si
      `)

      const result = await tx.execute(sql`
        WITH status_check AS (
          UPDATE service_orders
          SET status = '已完成', completed_at = NOW(), updated_at = NOW()
          WHERE service_order_id = ${serviceOrderId} AND status = '待客户确认'
          RETURNING service_order_id
        ),
        service_totals AS (
          SELECT sale_item_id, SUM(session_used) AS session_used
          FROM service_items
          WHERE service_order_id = ${serviceOrderId}
          GROUP BY sale_item_id
        ),
        deduct AS (
          UPDATE sale_items
          SET remaining_sessions = remaining_sessions - totals.session_used,
              updated_at = NOW()
          FROM service_totals totals
          WHERE sale_items.sale_item_id = totals.sale_item_id
            AND sale_items.remaining_sessions >= totals.session_used
            AND (sale_items.session_count - sale_items.remaining_sessions + totals.session_used) <= COALESCE(sale_items.paid_sessions, sale_items.session_count)
            AND EXISTS (SELECT 1 FROM status_check)
          RETURNING sale_items.sale_item_id
        ),
        total_items AS (
          SELECT COUNT(*) AS n FROM service_totals
        )
        SELECT
          (SELECT COUNT(*) FROM status_check) AS status_updated,
          (SELECT COUNT(*) FROM deduct) AS items_deducted,
          (SELECT n FROM total_items) AS items_total
      `)
      const row = (result as unknown as Array<{ status_updated: unknown; items_deducted: unknown; items_total: unknown }>)[0]
      if (!row || Number(row.status_updated) === 0) {
        return { kind: 'status_changed' as const }
      }
      // 若 status_updated=1 但 items_deducted < items_total，说明某行触发了 paid_sessions 限额
      if (Number(row.items_deducted) < Number(row.items_total)) {
        // 事务必须回滚状态推进和任何已成功的行扣减，不能留下“已完成但未扣净”的服务单。
        throw new ApiError('INSUFFICIENT_BALANCE', 'SERVICE_ITEMS_INSUFFICIENT_PAID')
      }
      // 扣减与状态 CAS 都成功后才释放预扣，避免转换单在两步之间取得本次服务的次数。
      await tx.execute(sql`
        UPDATE service_items
        SET reserved_at = NULL, updated_at = NOW()
        WHERE service_order_id = ${serviceOrderId}
      `)
      // 扣减 + 置已完成均成功 → 写服务提成 + commission_status='已分配'（镜像 staff/client finalize）
      await settleServiceCommissions(tx, serviceOrderId, {
        employeeId: session.employeeId,
        name: session.name,
        role: session.roles[0]?.role ?? null,
      })
      // 到店积分失败由 SAVEPOINT 隔离并落 points.visitGrantFailed，不阻断服务完成。
      await grantVisitPointsSafe(tx, {
        serviceOrderId,
        serviceOrderType: svcCtx?.serviceOrderType,
        serviceDate: svcCtx?.serviceDate,
        clientUserId: svcCtx?.clientUserId,
        remark: svcCtx?.remark,
        hasPositiveItem: svcCtx?.hasPositiveItem,
      }, 'admin.service.confirm')
      return { kind: 'ok' as const }
    })
  } catch (err) {
    if (err instanceof ApiError && err.message.includes('SERVICE_ITEMS_INSUFFICIENT_PAID')) {
      return { success: false, message: '部分服务行已支付次数不足，请先完成订单付款后再确认服务' }
    }
    return { success: false, message: '确认服务失败，请稍后重试' }
  }

  if (outcome.kind === 'status_changed') {
    return { success: false, message: '服务单状态已变更，无法确认' }
  }
  await logTransition(session, 'service.confirm', 'service_order', serviceOrderId, '待客户确认', '已完成', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已确认完成' }
  },
)

/**
 * C4: 取消服务 — 确认前（待服务 / 服务中 / 待客户确认）可取消，不扣次数。
 *
 * 副作用（扣次数 + 计提成 + 关预约）全部推迟到 confirm，故确认前取消是零副作用纯状态翻转，
 * 与 staffApi service.cancel（service.js:999-1046）口径一致。已完成走退款链路，不可取消。
 */
export const cancelServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 查当前状态 + 顾客名（状态守卫 + 日志真实 from 状态）；带 scope 过滤，无权时直接判"不存在/无权"
  const [svc] = await db
    .select({ status: serviceOrders.status, customerName: clientWechatUsers.name })
    .from(serviceOrders)
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), scopeCondition(session, serviceOrders.storeId)))
    .limit(1)

  if (!svc) {
    return { success: false, message: '服务单不存在或无权操作' }
  }

  // 状态守卫：仅确认前三态可取消；已完成走退款链路
  if (!['待服务', '服务中', '待客户确认'].includes(svc.status)) {
    return {
      success: false,
      message: svc.status === '已完成' ? '服务单已完成，请通过退款链路处理' : '服务单当前状态不可取消',
    }
  }

  let cancelResult: any
  try {
    cancelResult = await db.transaction(async (tx) => {
      const result = await tx
        .update(serviceOrders)
        .set({ status: '已取消' })
        .where(and(
          eq(serviceOrders.serviceOrderId, serviceOrderId),
          eq(serviceOrders.status, svc.status),
          scopeCondition(session, serviceOrders.storeId),
        ))
      // 只有状态 CAS 成功的服务单才能释放预扣，避免并发开始服务留下“服务中但无预扣”。
      if ((result as any).count > 0) {
        await tx.execute(sql`
          UPDATE service_items
          SET reserved_at = NULL, updated_at = NOW()
          WHERE service_order_id = ${serviceOrderId}
        `)
      }
      return result
    })
  } catch {
    return { success: false, message: '取消服务失败，请稍后重试' }
  }

  if ((cancelResult as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法取消' }
  }

  await logTransition(session, 'service.cancel', 'service_order', serviceOrderId, svc.status, '已取消', {
    customerName: svc.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已取消' }
  },
)

/**
 * 物理删除服务单（仅系统管理员；数据治理用，清理测试服务单）。
 *
 * 守卫：仅 待服务 / 已取消 可删（服务中 / 待客户确认 / 已完成 一律禁删，避免误删已计提成的服务记录）。
 * 可删时事务内级联删：service_commissions → service_items → service_reviews → service_orders。
 * 23503 兜底回滚。
 */
export const deleteServiceOrder = withPermission(
  'service:delete',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [svc] = await db
      .select({
        status: serviceOrders.status,
        serviceDate: serviceOrders.serviceDate,
        assignedEmployeeId: serviceOrders.assignedEmployeeId,
        commissionStatus: serviceOrders.commissionStatus,
      })
      .from(serviceOrders)
      .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), scopeCondition(session, serviceOrders.storeId)))
      .limit(1)

    if (!svc) {
      return { success: false, message: '服务单不存在或无权操作' }
    }
    if (svc.status !== '待服务' && svc.status !== '已取消') {
      return { success: false, message: '仅「待服务 / 已取消」服务单可删除（进行中或已完成不可删）' }
    }

    try {
      const txResult = await db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM service_commissions
          WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id = ${serviceOrderId})
        `)
        await tx.execute(sql`DELETE FROM service_items WHERE service_order_id = ${serviceOrderId}`)
        await tx.execute(sql`DELETE FROM service_reviews WHERE service_order_id = ${serviceOrderId}`)

        const result = await tx
          .delete(serviceOrders)
          .where(and(
            eq(serviceOrders.serviceOrderId, serviceOrderId),
            inArray(serviceOrders.status, ['待服务', '已取消']),
            scopeCondition(session, serviceOrders.storeId),
          ))
        if ((result as any).count === 0) {
          throw new Error('SERVICE_STATE_CHANGED')
        }
        return true
      })
      if (!txResult) {
        return { success: false, message: '服务单状态已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'SERVICE_STATE_CHANGED') {
        return { success: false, message: '服务单状态已变更，请刷新重试' }
      }
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '服务单存在关联业务数据，无法删除' }
      }
      throw e
    }

    await logOperation(session, 'service.delete', 'service_order', serviceOrderId, {
      snapshot: {
        status: svc.status,
        serviceDate: svc.serviceDate,
        assignedEmployeeId: svc.assignedEmployeeId,
        commissionStatus: svc.commissionStatus,
      },
    })

    revalidatePath('/services')
    revalidatePath('/allocations')
    return { success: true, message: '服务单已删除' }
  },
)

/** 管理后台创建服务单 */
export const createServiceOrder = withPermission(
  'service:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  clientUserId: string
  assignedEmployeeId: string
  serviceDate: string
  remark?: string | null
  items: Array<{
    saleItemId: string
    sessionUsed: number
  }>
    },
  ): Promise<{ success: boolean; message: string; serviceOrderId?: string }> => {
  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建服务单' }
  }
  if (await getInvalidEmployeeAssignmentId(
    [data.assignedEmployeeId],
    data.storeId,
    { requireServiceSkills: true },
  )) {
    return { success: false, message: '所选美容师不属于本门店' }
  }

  // 根据顾客成为会员客的时间戳判定服务单类型：
  // became_member_at 非空且 ≤ 当前时间 → 售后，否则 → 售前
  const [customerRow] = await db
    .select({ becameMemberAt: clientWechatUsers.becameMemberAt, boundStoreId: clientWechatUsers.boundStoreId })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  // 疗程卡使用限当前绑定门店：开单门店必须 == 顾客绑定门店（卡跟顾客走、只能用在绑定门店）
  if (customerRow?.boundStoreId !== data.storeId) {
    return { success: false, message: '顾客当前绑定门店非该门店，疗程卡只能在其绑定门店核销/开单' }
  }
  const serviceOrderType: '售前' | '售后' =
    customerRow?.becameMemberAt && customerRow.becameMemberAt <= new Date() ? '售后' : '售前'

  // 自动关联：查找该顾客在该门店已签到、且尚未关联服务单的最近预约
  const [pendingAppt] = await db
    .select({ appointmentId: appointments.appointmentId })
    .from(appointments)
    .where(
      and(
        eq(appointments.clientUserId, data.clientUserId),
        eq(appointments.storeId, data.storeId),
        eq(appointments.status, '已确认'),
        isNotNull(appointments.checkinAt),
        notExists(
          db.select({ id: serviceOrders.serviceOrderId })
            .from(serviceOrders)
            .where(eq(serviceOrders.appointmentId, appointments.appointmentId))
        ),
      )
    )
    .orderBy(desc(appointments.checkinAt))
    .limit(1)
  const resolvedAppointmentId = pendingAppt?.appointmentId ?? null

  // 先校验订单状态 + 剩余次数（事务外，只读查询）
  // 2026-05-20 ticket：放宽消费条件——只要"已支付/部分支付" + remainingSessions > 0 即可消费
  // 不再校验 paid_sessions 限额（之前的 D6=A 锁死规则已废止）
  // 注：退款冻结是独立守卫（与 D6 无关）——审批中拒绝整单，审批后按 paid_sessions 有效余量拒绝已退完的卡
  const saleItemSnapshots: Array<{
    saleItemId: string
    unitRealPrice: string
    isShengmei: boolean | null
    salesCategory: (typeof saleItems.$inferInsert)['salesCategory']
  }> = []
  for (const item of data.items) {
    const [saleItem] = await db
      .select({
        sessionCount: saleItems.sessionCount,
        remainingSessions: saleItems.remainingSessions,
        paidSessions: saleItems.paidSessions,
        unitRealPrice: saleItems.unitRealPrice,
        saleOrderType: saleOrders.saleOrderType,
        orderStatus: saleOrders.status,
        // service_items 快照源：优先 sale_items 行级值，NULL 时回查 product_skus / product_categories
        // （对齐 staff service.js 的 COALESCE 兜底，避免 admin 自建服务单两列为 NULL）
        isShengmei: sql<boolean | null>`COALESCE(${saleItems.isShengmei}, ${productSkus.isShengmei})`,
        salesCategory: sql<(typeof saleItems.$inferInsert)['salesCategory']>`COALESCE(${saleItems.salesCategory}, ${productCategories.salesCategory})`,
        hasPendingRefund: sql<boolean>`EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleOrders.saleOrderId} AND sop.change_type = '退款' AND sop.status = '待审批')`,
        hasApprovedRefund: sql<boolean>`EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleOrders.saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付')`,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(eq(saleItems.saleItemId, item.saleItemId))
      .limit(1)

    if (!saleItem) {
      return { success: false, message: `销售明细 ${item.saleItemId} 不存在` }
    }
    // orderStatus 显式不在白名单时拒绝（mock 中可能 undefined，按通过处理）
    if (saleItem.orderStatus && !['已支付', '部分支付'].includes(saleItem.orderStatus)) {
      return { success: false, message: `销售明细 ${item.saleItemId} 对应订单状态为 ${saleItem.orderStatus}，不可消费` }
    }
    // 在途退款冻结：原订单存在 '待审批' 退款时不可开单
    if (saleItem.hasPendingRefund) {
      return { success: false, message: `销售明细 ${item.saleItemId} 对应订单退款审批中，不可开单` }
    }
    // remainingSessions=null 视作无次数追踪（非疗程卡），跳过次数校验（保持旧行为）。
    // 否则收紧到「已付未用」(paidUnused) 口径，与 staff service-create consumable 对齐（推翻 2026-05-20 D6=A 放宽）。
    if (saleItem.remainingSessions != null) {
      const used = saleItem.sessionCount == null
        ? 0
        : Math.max(saleItem.sessionCount - saleItem.remainingSessions, 0)
      const paidUnused = saleItem.paidSessions == null
        ? saleItem.remainingSessions
        : Math.max(0, saleItem.paidSessions - used)
      if (paidUnused < item.sessionUsed) {
        return { success: false, message: `销售明细 ${item.saleItemId} 可用次数不足（已付未用 ${paidUnused}，需要 ${item.sessionUsed}）` }
      }
    }
    saleItemSnapshots.push({
      saleItemId: item.saleItemId,
      unitRealPrice: saleItem.unitRealPrice,
      isShengmei: saleItem.isShengmei ?? null,
      salesCategory: saleItem.salesCategory ?? null,
    })
  }

  // 事务：ID 生成 + 服务单 + 服务明细，原子提交
  let serviceOrderId: string
  try {
    serviceOrderId = await db.transaction(async (tx) => {
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('service_order_id_gen')::bigint)
        )
        SELECT 'FY-FW-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(service_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM service_orders
            WHERE service_order_id LIKE 'FY-FW-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as any[])[0]?.id as string
      if (!id) throw new ApiError('INVALID_STATE', '服务单号生成失败')

      await tx.insert(serviceOrders).values({
        serviceOrderId: id,
        status: '待服务',
        serviceOrderType,
        marketName: data.marketName,
        storeId: data.storeId,
        serviceDate: data.serviceDate,
        assignedEmployeeId: data.assignedEmployeeId,
        clientUserId: data.clientUserId,
        appointmentId: resolvedAppointmentId,
        remark: data.remark || null,
      })

      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i]
        const serviceItemId = `${id}-${String(i + 1).padStart(2, '0')}`
        const snapshot = saleItemSnapshots[i]

        await tx.insert(serviceItems).values({
          serviceItemId,
          serviceOrderId: id,
          saleItemId: item.saleItemId,
          sessionUsed: item.sessionUsed,
          unitRealPrice: snapshot.unitRealPrice || '0',
          employeeId: data.assignedEmployeeId,
          // 生美 / 销售分类快照（COALESCE sale_items → product_skus/product_categories）
          isShengmei: snapshot.isShengmei,
          salesCategory: snapshot.salesCategory,
        })
      }

      // 寄存单退款打标校验（M8）：service_items 已落库，反查是否含寄存卡。
      // remark 非必填：空备注按正常消耗计业绩（写提成 + 计消耗业绩，营业额分成按寄存单 sale_order 排除）。
      // 仅防误标：非寄存卡但误标「寄存单退款专用」预设 → 拒绝。
      const depositCheck = await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM service_items si
          JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
          JOIN sale_orders o ON o.sale_order_id = sli.sale_order_id
          WHERE si.service_order_id = ${id} AND o.sale_order_type = '寄存单'
        ) AS has_deposit
      `)
      const hasDeposit = ((depositCheck as any[])[0]?.has_deposit === true)
      const isDepositRefund = (data.remark || null) === DEPOSIT_REFUND_REMARK
      if (isDepositRefund && !hasDeposit) {
        throw new ApiError('INVALID_PARAMS', '非寄存卡不可标记为寄存单退款')
      }

      return id
    })
  } catch (err: any) {
    // PG 外键违反（storeId / clientUserId / assignedEmployeeId 不存在）
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '关联数据不存在，请检查员工或顾客信息' }
    }
    throw err
  }

  await logOperation(session, 'service.create', 'service_order', serviceOrderId, {
    storeId: data.storeId, itemCount: data.items.length,
  })

  revalidatePath('/services')
  return { success: true, message: '服务单创建成功', serviceOrderId }
  },
)
