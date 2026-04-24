'use server'

import { db } from '@/db'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { eq, and, or, desc, asc, inArray, sql, ilike, isNotNull, getTableColumns } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Customer, SaleOrder, SaleItem, Appointment } from '@/lib/types'
import { getSession, hasRole } from '@/lib/auth'
import { requirePermission, scopeCondition, isAdminScope, isInScope } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'

// 标量子查询 — 替代 3 个 LEFT JOIN（stores → storeNode → marketNode）
const storeName = sql<string | null>`(
  SELECT s.store_name FROM stores s WHERE s.store_id = ${clientWechatUsers.boundStoreId}
)`.as('store_name')

const marketName = sql<string | null>`(
  SELECT n.name FROM stores s
  JOIN org_nodes sn ON sn.id = s.org_node_id
  JOIN org_nodes n ON n.id = sn.parent_id
  WHERE s.store_id = ${clientWechatUsers.boundStoreId}
)`.as('market_name')

const customerColumns = {
  ...getTableColumns(clientWechatUsers),
  storeName,
  marketName,
}

type CustomerRow = typeof clientWechatUsers.$inferSelect & {
  storeName: string | null
  marketName: string | null
}

function serializeCustomer(row: CustomerRow): Customer {
  return {
    userId: row.userId,
    openid: row.openid,
    phone: row.phone,
    customerId: row.customerId,
    name: row.name,
    gender: row.gender,
    boundStoreId: row.boundStoreId,
    boundEmployeeId: row.boundEmployeeId,
    memberLevel: row.memberLevel,
    customerSource: row.customerSource,
    promoterEmployeeId: row.promoterEmployeeId,
    customerType: row.customerType,
    spendingTier: row.spendingTier,
    monthlyActivity: row.monthlyActivity,
    customerStatus: row.customerStatus,
    birthday: row.birthday,
    occupation: row.occupation,
    isMarried: row.isMarried,
    wechatName: row.wechatName,
    skinType: row.skinType,
    improvementFocus: row.improvementFocus,
    skinIssue: row.skinIssue,
    wellnessPreference: row.wellnessPreference,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    storeName: row.storeName ?? undefined,
    employeeName: row.boundEmployeeName ?? undefined,
    marketName: row.marketName ?? undefined,
  }
}

export async function searchCustomerByPhone(phone: string): Promise<Customer | null> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.phone, phone))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
}

/**
 * 模糊搜索顾客 — 按姓名或手机号 ILIKE 匹配，返回最多 20 条结果。
 * 用于开单页面的顾客搜索。
 */
export async function searchCustomers(keyword: string): Promise<Customer[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const trimmed = keyword.trim()
  if (!trimmed) return []

  const pattern = `%${trimmed}%`
  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(
      and(
        scopeCondition(session, clientWechatUsers.boundStoreId),
        isNotNull(clientWechatUsers.boundStoreId),
        or(
          ilike(clientWechatUsers.name, pattern),
          ilike(clientWechatUsers.phone, pattern),
        ),
      ),
    )
    // 例外：picker 字母序
    .orderBy(asc(clientWechatUsers.name))
    .limit(20)

  return rows.map(serializeCustomer)
}

export async function getCustomers(): Promise<Customer[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  // admin 不碰顾客数据（规范约束），但 scopeCondition 会返回 undefined（无过滤）
  // 非 admin 角色按 boundStoreId scope 过滤
  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(scopeCondition(session, clientWechatUsers.boundStoreId))
    // 例外：picker 字母序
    .orderBy(asc(clientWechatUsers.name))
    .limit(500)

  return rows.map(serializeCustomer)
}

/** 顾客列表筛选参数 */
export interface CustomerFilters {
  marketId?: string
  storeId?: string
  memberLevel?: string
  customerSource?: string
  customerType?: string
  spendingTier?: string
  monthlyActivity?: string
  customerStatus?: string
  search?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedCustomers {
  data: Customer[]
  total: number
}

/**
 * 服务端分页顾客列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * scope 基于 boundStoreId（顾客归属门店）。
 * 搜索支持：姓名、手机号（ILIKE）。
 */
export async function getCustomersPaginated(filters: CustomerFilters = {}): Promise<PaginatedCustomers> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, clientWechatUsers.boundStoreId),
  ]

  if (filters.marketId) {
    const sub = db.select({ storeId: stores.storeId }).from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, filters.marketId))
    conditions.push(inArray(clientWechatUsers.boundStoreId, sub))
  }
  if (filters.storeId) {
    conditions.push(eq(clientWechatUsers.boundStoreId, filters.storeId))
  }
  if (filters.memberLevel) {
    conditions.push(eq(clientWechatUsers.memberLevel, filters.memberLevel as typeof clientWechatUsers.memberLevel.enumValues[number]))
  }
  if (filters.customerSource) {
    conditions.push(eq(clientWechatUsers.customerSource, filters.customerSource as typeof clientWechatUsers.customerSource.enumValues[number]))
  }
  if (filters.customerType) {
    conditions.push(eq(clientWechatUsers.customerType, filters.customerType as typeof clientWechatUsers.customerType.enumValues[number]))
  }
  if (filters.spendingTier) {
    conditions.push(eq(clientWechatUsers.spendingTier, filters.spendingTier as typeof clientWechatUsers.spendingTier.enumValues[number]))
  }
  if (filters.monthlyActivity) {
    conditions.push(eq(clientWechatUsers.monthlyActivity, filters.monthlyActivity as typeof clientWechatUsers.monthlyActivity.enumValues[number]))
  }
  if (filters.customerStatus) {
    conditions.push(eq(clientWechatUsers.customerStatus, filters.customerStatus as typeof clientWechatUsers.customerStatus.enumValues[number]))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  const [[countRow], rows] = await Promise.all([
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(clientWechatUsers)
      .where(whereClause),
    db.select(customerColumns)
      .from(clientWechatUsers)
      .where(whereClause)
      // 例外：picker 字母序
      .orderBy(asc(clientWechatUsers.name))
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map(serializeCustomer),
    total: countRow?.count ?? 0,
  }
}

export async function getCustomerById(userId: string): Promise<Customer | null> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  // admin 纯角色不碰顾客数据（admin+manager 双角色可访问）
  const isAdminOnly = isAdminScope(session) && !hasRole(session, 'manager') && !hasRole(session, 'customer_mgr') && !hasRole(session, 'finance')
  if (isAdminOnly) return null

  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(and(eq(clientWechatUsers.userId, userId), scopeCondition(session, clientWechatUsers.boundStoreId)))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
}

export async function getCustomerOrders(userId: string): Promise<SaleOrder[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const { saleOrders, saleItems } = await import('@db/order')
  const { stores } = await import('@db/org')
  const { staffWechatUsers } = await import('@db/user')
  const { productSkus } = await import('@db/product')
  const { alias } = await import('drizzle-orm/pg-core')
  const { desc } = await import('drizzle-orm')

  const opener = alias(staffWechatUsers, 'opener')

  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(eq(saleOrders.clientUserId, userId))
    // 例外：详情页子列表，业务时间（订单日期）优先
    .orderBy(desc(saleOrders.saleOrderDatetime))

  // 批量查询所有订单的明细（避免 N+1）
  const orderIds = rows.map(r => r.order.saleOrderId)
  const allItemRows = orderIds.length > 0
    ? await db
        .select({
          item: saleItems,
          skuName: productSkus.specName,
        })
        .from(saleItems)
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .where(inArray(saleItems.saleOrderId, orderIds))
    : []

  // 按订单 ID 分组
  const itemsByOrderId = new Map<string, typeof allItemRows>()
  for (const ir of allItemRows) {
    const oid = ir.item.saleOrderId
    if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, [])
    itemsByOrderId.get(oid)!.push(ir)
  }

  const orders: SaleOrder[] = []
  for (const r of rows) {
    const itemRows = itemsByOrderId.get(r.order.saleOrderId) ?? []

    orders.push({
      saleOrderId: r.order.saleOrderId,
      status: r.order.status as SaleOrder['status'],
      saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
      documentType: r.order.documentType as SaleOrder['documentType'],
      refSaleOrderId: r.order.refSaleOrderId,
      marketName: r.order.marketName,
      storeId: r.order.storeId,
      saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
      clientUserId: r.order.clientUserId,
      clientPhone: r.order.clientPhone,
      customerName: r.order.customerName,
      totalAmount: r.order.totalAmount,
      prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
      paidAmount: r.order.paidAmount ?? '0',
      paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
      openedBy: r.order.openedBy,
      preferredEmployeeId: r.order.preferredEmployeeId,
      paidAt: r.order.paidAt?.toISOString() ?? null,
      allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
      couponId: r.order.couponId,
      couponDiscount: r.order.couponDiscount,
      remark: r.order.remark,
      createdAt: r.order.createdAt.toISOString(),
      updatedAt: r.order.updatedAt.toISOString(),
      storeName: r.storeName ?? undefined,
      openedByName: r.openedByName ?? undefined,
      items: itemRows.map((ir) => ({
        saleItemId: ir.item.saleItemId,
        saleOrderId: ir.item.saleOrderId,
        itemDirection: ir.item.itemDirection as SaleItem['itemDirection'],
        refSaleItemId: ir.item.refSaleItemId,
        skuId: ir.item.skuId,
        sessionCount: ir.item.sessionCount,
        remainingSessions: ir.item.remainingSessions,
        unitPrice: ir.item.unitPrice,
        quantity: ir.item.quantity,
        unitRealPrice: ir.item.unitRealPrice,
        saleAmount: ir.item.saleAmount,
        received: ir.item.received,
        expireDate: ir.item.expireDate,
        remark: ir.item.remark,
        salesCategory: ir.item.salesCategory as SaleItem['salesCategory'],
        createdAt: ir.item.createdAt.toISOString(),
        updatedAt: ir.item.updatedAt.toISOString(),
        skuName: ir.skuName ?? undefined,
        productName: ir.item.productName ?? undefined,
      })),
    })
  }

  return orders
}

export async function getCustomerAppointments(userId: string): Promise<Appointment[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const { appointments } = await import('@db/appointment')
  const { stores } = await import('@db/org')
  const { desc } = await import('drizzle-orm')

  const rows = await db
    .select({
      appointment: appointments,
      storeName: stores.storeName,
    })
    .from(appointments)
    .leftJoin(stores, eq(appointments.storeId, stores.storeId))
    .where(eq(appointments.clientUserId, userId))
    // 例外：详情页子列表，业务时间（预约时间）优先
    .orderBy(desc(appointments.appointmentTime))

  return rows.map((r) => {
    const a = r.appointment
    return {
      appointmentId: a.appointmentId,
      status: a.status as Appointment['status'],
      storeId: a.storeId,
      clientUserId: a.clientUserId,
      clientName: a.clientName,
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      saleItemId: a.saleItemId,
      appointmentTime: a.appointmentTime.toISOString(),
      checkinAt: a.checkinAt?.toISOString() ?? null,
      notes: a.notes,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      storeName: r.storeName ?? undefined,
    }
  })
}

export async function updateCustomer(
  userId: string,
  data: Partial<{
    name: string | null
    gender: string | null
    phone: string | null
    memberLevel: string | null
    customerSource: string | null
    birthday: string | null
    occupation: string | null
    isMarried: boolean | null
    wechatName: string | null
    skinType: string | null
    improvementFocus: string | null
    skinIssue: string | null
    wellnessPreference: string | null
    notes: string | null
    promoterEmployeeId: string | null
    boundStoreId: string | null
    boundEmployeeId: string | null
  }>,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'customer:update')

  // 服务端输入校验
  if (data.phone !== undefined && data.phone !== null && !/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }

  // boundEmployeeId 变更时同步写入冗余姓名
  if ('boundEmployeeId' in data) {
    if (data.boundEmployeeId) {
      const { staffWechatUsers } = await import('@db/user')
      const [emp] = await db.select({ name: staffWechatUsers.name }).from(staffWechatUsers)
        .where(eq(staffWechatUsers.employeeId, data.boundEmployeeId)).limit(1)
      ;(data as any).boundEmployeeName = emp?.name ?? null
    } else {
      ;(data as any).boundEmployeeName = null
    }
  }

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(clientWechatUsers).where(eq(clientWechatUsers.userId, userId)).limit(1)

  const scopeCond = scopeCondition(session, clientWechatUsers.boundStoreId)
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(clientWechatUsers.userId, userId),
        sql`date_trunc('milliseconds', ${clientWechatUsers.updatedAt}) = ${expectedUpdatedAt}`,
        scopeCond,
      )
    : and(eq(clientWechatUsers.userId, userId), scopeCond)

  let result: any
  try {
    result = await db.update(clientWechatUsers).set(data as any).where(whereConditions)
  } catch (err: any) {
    if (err?.code === '23505') {
      return { success: false, message: '该手机号已被其他顾客使用' }
    }
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '顾客不存在或无权修改',
    }
  }

  await logUpdate(session, 'customer.update', 'customer', userId, before as Record<string, unknown>, data)

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  return { success: true, message: '顾客信息已更新' }
}

export async function createCustomer(data: {
  phone: string
  name: string
  boundStoreId?: string | null
  boundEmployeeId?: string | null
}): Promise<{ success: boolean; message: string; userId?: string }> {
  const session = await getSession()
  requirePermission(session, 'customer:create')

  // 服务端输入校验
  if (!data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  if (!data.phone?.trim()) {
    return { success: false, message: '请输入手机号' }
  }
  if (!/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }

  // scope 隔离：非 admin 只能在自己 scope 内的门店创建顾客
  if (data.boundStoreId && !isInScope(session, data.boundStoreId)) {
    return { success: false, message: '无权在该门店创建顾客' }
  }

  // 检查手机号是否已存在
  const existing = await db
    .select({ userId: clientWechatUsers.userId })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.phone, data.phone))
    .limit(1)

  if (existing.length > 0) {
    return { success: false, message: '该手机号已存在顾客记录' }
  }

  // 解析绑定美容师姓名
  let boundEmployeeName: string | null = null
  if (data.boundEmployeeId) {
    const { staffWechatUsers } = await import('@db/user')
    const [emp] = await db.select({ name: staffWechatUsers.name }).from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, data.boundEmployeeId)).limit(1)
    boundEmployeeName = emp?.name ?? null
  }

  // 服务端生成 userId
  const { randomBytes } = await import('crypto')
  const userId = `FYGK-${randomBytes(6).toString('hex')}`

  try {
    await db.insert(clientWechatUsers).values({
      userId,
      phone: data.phone,
      name: data.name,
      boundStoreId: data.boundStoreId ?? null,
      boundEmployeeId: data.boundEmployeeId ?? null,
      boundEmployeeName,
    })
  } catch (err: any) {
    if (err?.code === '23505') {
      return { success: false, message: '该手机号已被其他顾客使用' }
    }
    throw err
  }

  await logOperation(session, 'customer.create', 'customer', userId, { name: data.name, phone: data.phone })

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  return { success: true, message: '顾客创建成功', userId }
}

/* ============================================================
 * P1 — 手机号变更日志（顾客详情 Tab，只读）
 * ============================================================ */

export interface PhoneChangeLog {
  id: number
  createdAt: string
  oldPhone: string | null
  newPhone: string | null
  mergedOrders: number
  operatorLabel: string
  /** 'client'：顾客端 P0/P1 自助换绑历史；'admin'：管理后台代客修改 */
  source: 'client' | 'admin'
  /** 仅 admin 来源时填充：操作员姓名 */
  operatorName: string | null
}

/**
 * 读取指定顾客的手机号变更记录
 *
 * 数据源（合并展示）：
 *   1. action='auth.rebindPhone' AND target_type='client_user'
 *      （P0/P1 客户端自助换绑历史，2026-04-16 已下线，仅供历史回看）
 *      detail 形如 { oldPhone, newPhone, clientUserId, mergedOrders }（P0 已脱敏）
 *   2. action='customer.update' AND target_type='customer'
 *      （admin-only 改 phone，detail 由 logUpdate 写入）
 *      detail 形如 { _v: 2, _t: 'update', changes: { phone: { from, to }, ... } }
 *      仅 changes.phone 存在的记录被纳入
 */
export async function getCustomerPhoneChangeLogs(userId: string): Promise<PhoneChangeLog[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const { operationLogs } = await import('@db/operation-log')

  // scope 保护：非 admin 需确认顾客在其 scope 内（复用 getCustomerById 的 scope 过滤）
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const rows = await db
    .select({
      id: operationLogs.id,
      createdAt: operationLogs.createdAt,
      action: operationLogs.action,
      detail: operationLogs.detail,
      source: operationLogs.source,
      operatorEmployeeId: operationLogs.operatorEmployeeId,
      operatorName: operationLogs.operatorName,
    })
    .from(operationLogs)
    .where(
      or(
        and(
          eq(operationLogs.action, 'auth.rebindPhone'),
          eq(operationLogs.targetType, 'client_user'),
          eq(operationLogs.targetId, userId),
        ),
        and(
          eq(operationLogs.action, 'customer.update'),
          eq(operationLogs.targetType, 'customer'),
          eq(operationLogs.targetId, userId),
          // 仅当 detail.changes 中包含 phone 字段时才计入（admin 改了非 phone 字段的更新不应进入手机号变更 Tab）
          sql`(${operationLogs.detail} -> 'changes' ? 'phone')`,
        ),
      ),
    )
    // 例外：流水型表无 updatedAt 列（operation_logs）
    .orderBy(desc(operationLogs.createdAt))
    .limit(200)

  return rows.map((r) => {
    if (r.action === 'customer.update') {
      // logUpdate 写入的 diff 结构：{ _v: 2, _t: 'update', changes: { phone: { from, to } } }
      const detail = (r.detail ?? {}) as {
        changes?: { phone?: { from?: string | null; to?: string | null } }
      }
      const phoneDiff = detail.changes?.phone ?? {}
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        oldPhone: phoneDiff.from ?? null,
        newPhone: phoneDiff.to ?? null,
        mergedOrders: 0,
        operatorLabel: r.operatorName ?? r.operatorEmployeeId ?? '—',
        source: 'admin',
        operatorName: r.operatorName ?? null,
      }
    }

    // auth.rebindPhone 历史记录
    const detail = (r.detail ?? {}) as { oldPhone?: string; newPhone?: string; clientUserId?: string; mergedOrders?: number }
    // operator_employee_id 为 null + detail.clientUserId 存在 → 顾客自助
    const operatorLabel = r.operatorEmployeeId
      ? (r.operatorName ?? r.operatorEmployeeId)
      : (detail.clientUserId ? '顾客自助' : (r.operatorName ?? '—'))
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      oldPhone: detail.oldPhone ?? null,
      newPhone: detail.newPhone ?? null,
      mergedOrders: detail.mergedOrders ?? 0,
      operatorLabel,
      source: 'client',
      operatorName: r.operatorEmployeeId ? (r.operatorName ?? null) : null,
    }
  })
}

/* ============================================================
 * P1 — 顾客合并工具（孤儿档案认领）
 * ============================================================ */

export interface OrphanProfile {
  userId: string
  customerId: string | null
  name: string | null
  gender: string | null
  memberLevel: string | null
  spendingTier: string | null
  pointsBalance: number
  skinType: string | null
  notes: string | null
  createdAt: string
}

/**
 * 查询与当前顾客同手机号的"孤儿档案"（openid IS NULL 且 user_id 不同）
 *
 * 用于顾客详情页展示"合并历史档案"入口。
 */
export async function getOrphanProfilesByUserId(userId: string): Promise<OrphanProfile[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  // 先拿到当前行（受 scope 限制）
  const current = await getCustomerById(userId)
  if (!current || !current.phone) return []

  const rows = await db
    .select({
      userId: clientWechatUsers.userId,
      customerId: clientWechatUsers.customerId,
      name: clientWechatUsers.name,
      gender: clientWechatUsers.gender,
      memberLevel: clientWechatUsers.memberLevel,
      spendingTier: clientWechatUsers.spendingTier,
      pointsBalance: clientWechatUsers.pointsBalance,
      skinType: clientWechatUsers.skinType,
      notes: clientWechatUsers.notes,
      createdAt: clientWechatUsers.createdAt,
      openid: clientWechatUsers.openid,
    })
    .from(clientWechatUsers)
    .where(
      and(
        eq(clientWechatUsers.phone, current.phone),
        sql`${clientWechatUsers.openid} IS NULL`,
        sql`${clientWechatUsers.userId} <> ${userId}`,
      ),
    )
    .limit(10)

  return rows.map((r) => ({
    userId: r.userId,
    customerId: r.customerId,
    name: r.name,
    gender: r.gender,
    memberLevel: r.memberLevel,
    spendingTier: r.spendingTier,
    pointsBalance: r.pointsBalance,
    skinType: r.skinType,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }))
}

/**
 * 合并客户档案（孤儿行 → 活跃行）
 *
 * 条件：
 *   - 目标（source）必须是活跃行（openid NOT NULL）
 *   - 来源（orphan）必须是孤儿行（openid IS NULL）
 *   - 权限：仅店长（manager）/ admin
 *
 * 事务内：
 *   1. 把孤儿行的档案字段填入活跃行（活跃行已有非空字段**不覆盖**）
 *   2. 重挂 sale_orders / user_coupons / point_transactions / prepaid_cards /
 *      card_transactions / appointments / messages / service_orders
 *      的 client_user_id = orphan → source
 *   3. DELETE 孤儿行
 *   4. 审计日志 admin.mergeClientProfile
 */
export async function mergeClientProfile(
  sourceUserId: string,
  orphanUserId: string,
): Promise<{ success: boolean; message: string; fieldsMigrated?: string[]; ordersReassigned?: number }> {
  const session = await getSession()
  requirePermission(session, 'customer:update')

  // 仅店长 / admin 允许合并
  if (!hasRole(session, 'manager') && !isAdminScope(session)) {
    return { success: false, message: '仅店长或管理员可执行顾客合并' }
  }

  if (!sourceUserId || !orphanUserId || sourceUserId === orphanUserId) {
    return { success: false, message: '源顾客与目标孤儿档案必须是两个不同的 userId' }
  }

  // 校验两边状态
  const [sourceRow] = await db
    .select()
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, sourceUserId))
    .limit(1)
  const [orphanRow] = await db
    .select()
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, orphanUserId))
    .limit(1)

  if (!sourceRow) return { success: false, message: '活跃顾客不存在' }
  if (!orphanRow) return { success: false, message: '孤儿档案不存在' }
  if (!sourceRow.openid) return { success: false, message: '源顾客缺少 openid（并非活跃账户），不能作为合并目标' }
  if (orphanRow.openid) return { success: false, message: '目标档案 openid 非空（并非孤儿档案），拒绝合并' }
  if (sourceRow.phone && orphanRow.phone && sourceRow.phone !== orphanRow.phone) {
    return { success: false, message: '两条档案手机号不一致，请先核实' }
  }

  // 非 admin 需 scope 允许访问活跃顾客所属门店
  if (!isAdminScope(session)) {
    if (sourceRow.boundStoreId && !isInScope(session, sourceRow.boundStoreId)) {
      return { success: false, message: '无权对该门店的顾客执行合并' }
    }
  }

  // 可迁移字段（源行**缺失**才从孤儿行搬）
  const migratable: Array<keyof typeof clientWechatUsers.$inferSelect> = [
    'customerId', 'memberLevel', 'spendingTier', 'pointsBalance', 'skinType',
    'name', 'gender', 'notes', 'birthday', 'occupation', 'customerSource',
    'customerType', 'improvementFocus', 'skinIssue', 'wellnessPreference',
    'boundStoreId', 'boundEmployeeId', 'boundEmployeeName', 'wechatName', 'isMarried',
  ]
  const patch: Record<string, unknown> = {}
  const fieldsMigrated: string[] = []
  for (const field of migratable) {
    const currentVal = (sourceRow as Record<string, unknown>)[field as string]
    const orphanVal = (orphanRow as Record<string, unknown>)[field as string]
    const currentEmpty = currentVal === null || currentVal === undefined || currentVal === '' ||
      (field === 'pointsBalance' && currentVal === 0)
    if (currentEmpty && orphanVal !== null && orphanVal !== undefined && orphanVal !== '') {
      patch[field as string] = orphanVal
      fieldsMigrated.push(field as string)
    }
  }

  let ordersReassigned = 0
  try {
    await db.transaction(async (tx) => {
      const { saleOrders } = await import('@db/order')
      const { userCoupons } = await import('@db/coupon')
      const { pointTransactions } = await import('@db/points')
      const { prepaidCards } = await import('@db/prepaid-card')
      const { appointments } = await import('@db/appointment')
      const { messages } = await import('@db/message')
      const { serviceOrders } = await import('@db/service')
      const { pickupRecords } = await import('@db/pickup')

      // 1. 档案字段回填（仅缺失项）
      if (Object.keys(patch).length > 0) {
        await tx.update(clientWechatUsers)
          .set(patch as any)
          .where(eq(clientWechatUsers.userId, sourceUserId))
      }

      // 2. 业务引用重挂（各表列名不同：order/appointment/service 用 clientUserId，
      //    coupon/points/prepaid 用 userId，messages 用 recipientType+recipientId）
      const reassignCol = async (table: any, col: any, setObj: Record<string, unknown>) => {
        const res: any = await tx.update(table).set(setObj as any).where(eq(col, orphanUserId))
        return (res?.count ?? res?.rowCount ?? 0) as number
      }
      ordersReassigned = await reassignCol(saleOrders, saleOrders.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(userCoupons, userCoupons.userId, { userId: sourceUserId })
      await reassignCol(pointTransactions, pointTransactions.userId, { userId: sourceUserId })
      await reassignCol(prepaidCards, prepaidCards.userId, { userId: sourceUserId })
      // card_transactions 通过 card_id → prepaid_cards 间接关联，无需直接迁移
      await reassignCol(appointments, appointments.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(serviceOrders, serviceOrders.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(pickupRecords, pickupRecords.clientUserId, { clientUserId: sourceUserId })
      // messages: recipientType='客户' AND recipient_id = orphan
      await tx.update(messages)
        .set({ recipientId: sourceUserId })
        .where(and(eq(messages.recipientType, '客户'), eq(messages.recipientId, orphanUserId)))

      // 3. 删除孤儿行
      await tx.delete(clientWechatUsers).where(eq(clientWechatUsers.userId, orphanUserId))
    })
  } catch (err: any) {
    return { success: false, message: `合并失败：${err?.message ?? 'unknown'}` }
  }

  await logOperation(session, 'admin.mergeClientProfile', 'client_user', sourceUserId, {
    sourceUserId,
    orphanUserId,
    fieldsMigrated,
    ordersReassigned,
  })

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  revalidatePath(`/customers/${sourceUserId}`)

  return { success: true, message: `已合并 ${fieldsMigrated.length} 个字段，${ordersReassigned} 笔订单归属已更新`, fieldsMigrated, ordersReassigned }
}
