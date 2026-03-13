'use server'

import { db } from '@/db'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { stores } from '@db/org'
import { eq } from 'drizzle-orm'
import type { Customer, SaleOrder, SaleItem, Appointment } from '@/lib/types'

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
  const rows = await db
    .select()
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))

  return rows.map(serializeCustomer)
}

export async function getCustomerById(userId: string): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(clientWechatUsers.boundEmployeeId, staffWechatUsers.employeeId))
    .where(eq(clientWechatUsers.userId, userId))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
}

export async function getCustomerOrders(userId: string): Promise<SaleOrder[]> {
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

  const orders: SaleOrder[] = []
  for (const r of rows) {
    const itemRows = await db
      .select({
        item: saleItems,
        skuName: productSkus.specName,
        productName: products.name,
      })
      .from(saleItems)
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(products, eq(productSkus.productId, products.productId))
      .where(eq(saleItems.saleOrderId, r.order.saleOrderId))

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
  }>
) {
  await db
    .update(clientWechatUsers)
    .set(data)
    .where(eq(clientWechatUsers.userId, userId))
}
