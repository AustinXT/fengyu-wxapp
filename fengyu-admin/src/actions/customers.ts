'use server'

import { db } from '@/db'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { stores } from '@db/org'
import { eq, and, or, desc, inArray, sql, ilike } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Customer, SaleOrder, SaleItem, Appointment } from '@/lib/types'
import { getSession, hasRole } from '@/lib/auth'
import { requirePermission, scopeCondition, isAdminScope, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

function serializeCustomer(row: {
  client_wechat_users: typeof clientWechatUsers.$inferSelect
  stores: typeof stores.$inferSelect | null
  staff_wechat_users: typeof staffWechatUsers.$inferSelect | null
}): Customer {
  const c = row.client_wechat_users
  return {
    userId: c.userId,
    openid: c.openid,
    phone: c.phone,
    customerId: c.customerId,
    name: c.name,
    boundStoreId: c.boundStoreId,
    boundEmployeeId: c.boundEmployeeId,
    memberLevel: c.memberLevel,
    customerSource: c.customerSource,
    category: c.category,
    birthday: c.birthday,
    occupation: c.occupation,
    isMarried: c.isMarried,
    wechatName: c.wechatName,
    skinType: c.skinType,
    improvementFocus: c.improvementFocus,
    skinIssue: c.skinIssue,
    wellnessPreference: c.wellnessPreference,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    storeName: row.stores?.storeName ?? undefined,
    employeeName: row.staff_wechat_users?.name ?? undefined,
  }
}

export async function searchCustomerByPhone(phone: string): Promise<Customer | null> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  const rows = await db
    .select()
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))
    .where(eq(clientWechatUsers.phone, phone))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
}

export async function getCustomers(): Promise<Customer[]> {
  const session = await getSession()
  requirePermission(session, 'customer:list')

  // admin 不碰顾客数据（规范约束），但 scopeCondition 会返回 undefined（无过滤）
  // 非 admin 角色按 boundStoreId scope 过滤
  const rows = await db
    .select()
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))
    .where(scopeCondition(session, clientWechatUsers.boundStoreId))
    .orderBy(clientWechatUsers.name)
    .limit(500)

  return rows.map(serializeCustomer)
}

/** 顾客列表筛选参数 */
export interface CustomerFilters {
  storeId?: string
  memberLevel?: string
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

  if (filters.storeId) {
    conditions.push(eq(clientWechatUsers.boundStoreId, filters.storeId))
  }
  if (filters.memberLevel) {
    conditions.push(eq(clientWechatUsers.memberLevel, filters.memberLevel))
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
    db.select()
      .from(clientWechatUsers)
      .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
      .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))
      .where(whereClause)
      .orderBy(clientWechatUsers.name)
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
    .select()
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))
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
  const { productSkus, products } = await import('@db/product')
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
    .orderBy(desc(saleOrders.saleOrderDatetime))

  // 批量查询所有订单的明细（避免 N+1）
  const orderIds = rows.map(r => r.order.saleOrderId)
  const allItemRows = orderIds.length > 0
    ? await db
        .select({
          item: saleItems,
          skuName: productSkus.specName,
          productName: products.name,
        })
        .from(saleItems)
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(products, eq(productSkus.productId, products.productId))
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
      refSaleOrderId: r.order.refSaleOrderId,
      marketName: r.order.marketName,
      storeId: r.order.storeId,
      saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
      clientUserId: r.order.clientUserId,
      clientPhone: r.order.clientPhone,
      customerName: r.order.customerName,
      totalAmount: r.order.totalAmount,
      paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
      saleOrderSource: r.order.saleOrderSource as SaleOrder['saleOrderSource'],
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
        productName: ir.productName ?? undefined,
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
    phone: string | null
    memberLevel: string | null
    customerSource: string | null
    category: string | null
    birthday: string | null
    occupation: string | null
    isMarried: boolean | null
    wechatName: string | null
    skinType: string | null
    improvementFocus: string | null
    skinIssue: string | null
    wellnessPreference: string | null
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

  const scopeCond = scopeCondition(session, clientWechatUsers.boundStoreId)
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(clientWechatUsers.userId, userId),
        eq(clientWechatUsers.updatedAt, new Date(expectedUpdatedAt)),
        scopeCond,
      )
    : and(eq(clientWechatUsers.userId, userId), scopeCond)

  let result: any
  try {
    result = await db.update(clientWechatUsers).set(data).where(whereConditions)
  } catch (err: any) {
    if (err?.code === '23505') {
      return { success: false, message: '该手机号已被其他顾客使用' }
    }
    throw err
  }

  if ((result as any).rowCount === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '顾客不存在或无权修改',
    }
  }

  await logOperation(session, 'customer.update', 'customer', userId, data)

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
