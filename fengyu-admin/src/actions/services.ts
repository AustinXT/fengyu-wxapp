'use server'

import { db } from '@/db'
import { serviceOrders, serviceItems } from '@db/service'
import { saleItems, saleOrders } from '@db/order'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { appointments } from '@db/appointment'
import { eq, desc, and, or, sql, ilike, gte, lte, isNotNull, notExists } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceOrder } from '@/lib/types'
import { scopeCondition, isInScope, isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logTransition } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'

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
    .limit(500)

  return rows.map(serializeServiceOrder)
  },
)

/** 服务单列表筛选参数 */
export interface ServiceOrderFilters {
  status?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  /** 提成状态筛选（'待分配' | '已分配'，用于营业额分配页） */
  commissionStatus?: string
  page?: number
  pageSize?: number
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

  // 构建 WHERE 条件（DB 级过滤）
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, serviceOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(serviceOrders.status, filters.status as typeof serviceOrders.status.enumValues[number]))
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

  const whereClause = and(...conditions)

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

export const getServiceOrderById = withPermission(
  'service:list',
  async (session, serviceOrderId: string): Promise<ServiceOrder | null> => {
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
    .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), scopeCondition(session, serviceOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null
  return serializeServiceOrder(rows[0])
  },
)

export interface ServiceItemDetail {
  serviceItemId: string
  saleItemId: string
  sessionUsed: number
  unitRealPrice: string | null
  employeeName: string | null
  employeeId: string | null
  productName: string | null
  skuName: string | null
  salesCategory: string | null
  remainingSessions: number | null
  sessionCount: number | null
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
      sli.sku_spec_name AS sku_name,
      sli.sales_category,
      sli.remaining_sessions,
      sli.session_count,
      sli.quantity AS sli_quantity
    FROM service_items si
    LEFT JOIN staff_wechat_users e ON e.employee_id = si.employee_id
    LEFT JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
    WHERE si.service_order_id = ${serviceOrderId}
  `)

  return (rows as any[]).map((r: any) => ({
    serviceItemId: r.service_item_id,
    saleItemId: r.sale_item_id,
    sessionUsed: Number(r.session_used),
    unitRealPrice: r.unit_real_price,
    employeeName: r.employee_name,
    employeeId: r.employee_id,
    productName: r.product_name,
    skuName: r.sku_name,
    salesCategory: r.sales_category ?? null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
    quantity: r.sli_quantity !== null && r.sli_quantity !== undefined ? Number(r.sli_quantity) : null,
  }))
  },
)

/** 顾客可用服务项目（已支付订单中有剩余次数的疗程卡/单品） */
export interface AvailableSaleItem {
  saleItemId: string
  saleOrderId: string
  productName: string | null
  skuSpecName: string | null
  productType: string | null
  sessionCount: number | null
  remainingSessions: number | null
  unitRealPrice: string
  expireDate: string | null
}

export const getAvailableSaleItems = withPermission(
  'service:create',
  async (_session, clientUserId: string): Promise<AvailableSaleItem[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      si.product_name,
      si.sku_spec_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.unit_real_price,
      si.expire_date
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status = '已支付'
      AND si.item_direction = '购买'
      AND si.product_type IN ('疗程卡', '单品')
      AND si.remaining_sessions IS NOT NULL
      AND si.remaining_sessions > 0
      AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
    ORDER BY o.paid_at DESC, si.sale_item_id
  `)

  return (rows as any[]).map((r: any) => ({
    saleItemId: r.sale_item_id,
    saleOrderId: r.sale_order_id,
    productName: r.product_name,
    skuSpecName: r.sku_spec_name,
    productType: r.product_type,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    unitRealPrice: r.unit_real_price ?? '0',
    expireDate: r.expire_date,
  }))
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

  let result: any
  try {
    result = await db
      .update(serviceOrders)
      .set({ status: '服务中', startedAt: new Date() })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '待服务'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '开始服务失败，请稍后重试' }
  }

  if ((result as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法开始' }
  }

  await logTransition(session, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已开始' }
  },
)

/**
 * C1+C4: 完成服务 — 原子扣减 remaining_sessions + 状态推进
 * scope 通过预检查实现：非 admin 先验证服务单归属，再执行原子 SQL
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
    result = await db.execute(sql`
      WITH status_check AS (
        UPDATE service_orders
        SET status = '已完成', completed_at = NOW(), updated_at = NOW()
        WHERE service_order_id = ${serviceOrderId} AND status = '服务中'
        RETURNING service_order_id
      ),
      deduct AS (
        UPDATE sale_items
        SET remaining_sessions = remaining_sessions - si.session_used,
            updated_at = NOW()
        FROM service_items si
        WHERE sale_items.sale_item_id = si.sale_item_id
          AND si.service_order_id = ${serviceOrderId}
          AND sale_items.remaining_sessions >= si.session_used
          AND EXISTS (SELECT 1 FROM status_check)
        RETURNING sale_items.sale_item_id
      )
      SELECT
        (SELECT COUNT(*) FROM status_check) AS status_updated,
        (SELECT COUNT(*) FROM deduct) AS items_deducted
    `)
  } catch {
    return { success: false, message: '完成服务失败，请稍后重试' }
  }

  const row = (result as any[])[0]
  if (!row || Number(row.status_updated) === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }

  await logTransition(session, 'service.complete', 'service_order', serviceOrderId, '服务中', '已完成', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已完成' }
  },
)

/** C4: 取消服务 — WHERE status = '待服务'，不扣次数 */
export const cancelServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [svcCtx] = await db
    .select({ customerName: clientWechatUsers.name })
    .from(serviceOrders)
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  let cancelResult: any
  try {
    cancelResult = await db
      .update(serviceOrders)
      .set({ status: '已取消' })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '待服务'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '取消服务失败，请稍后重试' }
  }

  if ((cancelResult as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法取消' }
  }

  await logTransition(session, 'service.cancel', 'service_order', serviceOrderId, '待服务', '已取消', {
    customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已取消' }
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

  // 根据顾客成为会员客的时间戳判定服务单类型：
  // became_member_at 非空且 ≤ 当前时间 → 售后，否则 → 售前
  const [customerRow] = await db
    .select({ becameMemberAt: clientWechatUsers.becameMemberAt })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
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

  // 先校验剩余次数（事务外，只读查询）
  const saleItemSnapshots: Array<{ saleItemId: string; unitRealPrice: string }> = []
  for (const item of data.items) {
    const [saleItem] = await db
      .select({
        remainingSessions: saleItems.remainingSessions,
        unitRealPrice: saleItems.unitRealPrice,
        saleOrderType: saleOrders.saleOrderType,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .where(eq(saleItems.saleItemId, item.saleItemId))
      .limit(1)

    if (!saleItem) {
      return { success: false, message: `销售明细 ${item.saleItemId} 不存在` }
    }
    if (saleItem.remainingSessions !== null && saleItem.remainingSessions < item.sessionUsed) {
      return { success: false, message: `销售明细 ${item.saleItemId} 剩余次数不足（剩余 ${saleItem.remainingSessions}，需要 ${item.sessionUsed}）` }
    }
    saleItemSnapshots.push({
      saleItemId: item.saleItemId,
      unitRealPrice: saleItem.unitRealPrice,
    })
  }

  // 事务：ID 生成 + 服务单 + 服务明细，原子提交
  let serviceOrderId: string
  try {
    serviceOrderId = await db.transaction(async (tx) => {
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('service_order_id_gen'))
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
        })
      }

      return id
    })
  } catch (err: any) {
    // PG 外键违反（storeId / clientUserId / assignedEmployeeId 不存在）
    if (err?.code === '23503') {
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
