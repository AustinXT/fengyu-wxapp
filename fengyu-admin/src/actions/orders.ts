'use server'

import { db } from '@/db'
import { saleOrders, saleItems } from '@db/order'
import { stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { products } from '@db/product'
import { eq, desc, and, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SaleOrder, SaleItem } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

const opener = alias(staffWechatUsers, 'opener')

export async function getOrders(): Promise<SaleOrder[]> {
  const session = await getSession()
  requirePermission(session, 'sale_order:list')

  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(scopeCondition(session, saleOrders.storeId))
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(500)

  return rows.map((r) => ({
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
  }))
}

export async function getOrderById(saleOrderId: string): Promise<SaleOrder | null> {
  const session = await getSession()
  requirePermission(session, 'sale_order:list')

  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]

  // Get items with joins
  const itemRows = await db
    .select({
      item: saleItems,
      skuName: productSkus.specName,
      productName: products.name,
    })
    .from(saleItems)
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(products, eq(productSkus.productId, products.productId))
    .where(eq(saleItems.saleOrderId, saleOrderId))

  const items: SaleItem[] = itemRows.map((ir) => ({
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
  }))

  return {
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
    items,
  }
}

/** C4: 确认线下收款 — WHERE status = '待确认收款' + scope 保障幂等 */
export async function confirmOfflinePayment(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  const result = await db
    .update(saleOrders)
    .set({
      status: '已支付',
      paidAt: new Date(),
      offlineConfirmedBy: session.employeeId,
      offlineConfirmedAt: new Date(),
    })
    .where(and(
      eq(saleOrders.saleOrderId, saleOrderId),
      eq(saleOrders.status, '待确认收款'),
      scopeCondition(session, saleOrders.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '订单状态已变更，无法确认收款' }
  }

  // 设置单品到期日（支付成功后 1 年）
  await db.execute(sql`
    UPDATE sale_items
    SET expire_date = (NOW() + INTERVAL '1 year')::date,
        updated_at = NOW()
    WHERE sale_order_id = ${saleOrderId}
      AND expire_date IS NULL
  `)

  await logOperation(session, 'order.confirmPayment', 'sale_order', saleOrderId)

  revalidatePath('/orders')
  return { success: true, message: '确认收款成功' }
}

/** C4: 关闭订单 — 仅待支付/支付失败可关闭，同时作废关联的分配记录 */
export async function closeOrder(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  const result = await db
    .update(saleOrders)
    .set({ status: '已关闭' })
    .where(and(
      eq(saleOrders.saleOrderId, saleOrderId),
      or(eq(saleOrders.status, '待支付'), eq(saleOrders.status, '支付失败')),
      scopeCondition(session, saleOrders.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '订单状态已变更，无法关闭' }
  }

  // 作废关联的分配记录（规范：订单关闭时作废分配）
  await db.execute(sql`
    UPDATE sale_allocations SET is_void = true, voided_at = NOW()
    WHERE sale_item_id IN (
      SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
    ) AND is_void = false
  `)

  await logOperation(session, 'order.close', 'sale_order', saleOrderId)

  revalidatePath('/orders')
  revalidatePath('/allocations')
  return { success: true, message: '订单已关闭' }
}

/** C4: 重置支付失败 → 待支付（仅店长） */
export async function resetOrderFailed(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  const result = await db
    .update(saleOrders)
    .set({ status: '待支付' })
    .where(and(
      eq(saleOrders.saleOrderId, saleOrderId),
      eq(saleOrders.status, '支付失败'),
      scopeCondition(session, saleOrders.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '订单状态已变更，无法重置' }
  }

  await logOperation(session, 'order.resetFailed', 'sale_order', saleOrderId)

  revalidatePath('/orders')
  return { success: true, message: '已重置为待支付' }
}

/** 管理后台开单 — source='admin' */
export async function createOrder(data: {
  storeId: string
  marketName: string
  clientUserId: string | null
  clientPhone: string
  customerName: string
  paymentMethod: 'wechat' | 'alipay' | 'offline'
  saleOrderType: '普通' | '体验' | '内部' | '福利活动' | '回款' | '转换' | '退款'
  openedBy?: string
  preferredEmployeeId?: string
  remark?: string | null
  items: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '院装产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice: string
    quantity: number
    salesCategory?: '自采自销' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
}): Promise<{ success: boolean; message: string; saleOrderId?: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:create')

  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }

  // 计算总金额（事务外，纯计算）
  const totalAmount = data.items.reduce((sum, item) => {
    return sum + Number(item.unitRealPrice) * item.quantity
  }, 0)
  const initialStatus = data.paymentMethod === 'offline' ? '待确认收款' : '待支付'

  // 事务：ID 生成 + 订单 + 明细，原子提交或全部回滚
  const saleOrderId = await db.transaction(async (tx) => {
    // advisory lock 在事务内持有，直到 commit 才释放
    const idRows = await tx.execute(sql`
      WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
      )
      SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
        LPAD(
          (SELECT COALESCE(MAX(
            CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
          ), 0) + 1
          FROM sale_orders
          WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
          )::TEXT, 4, '0'
        ) AS id
      FROM lock
    `)
    const id = (idRows as any[])[0]?.id as string
    if (!id) throw new Error('订单号生成失败')

    await tx.insert(saleOrders).values({
      saleOrderId: id,
      status: initialStatus,
      saleOrderType: data.saleOrderType,
      marketName: data.marketName,
      storeId: data.storeId,
      saleOrderDatetime: new Date(),
      clientUserId: data.clientUserId,
      clientPhone: data.clientPhone,
      customerName: data.customerName,
      totalAmount: totalAmount.toFixed(2),
      paymentMethod: data.paymentMethod,
      saleOrderSource: 'admin',
      openedBy: data.openedBy || session.employeeId,
      preferredEmployeeId: data.preferredEmployeeId || null,
      allocationStatus: 'pending',
      remark: data.remark || null,
    })

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      const saleItemId = `${id}-${String(i + 1).padStart(2, '0')}`
      const saleAmount = (Number(item.unitRealPrice) * item.quantity).toFixed(2)

      await tx.insert(saleItems).values({
        saleItemId,
        saleOrderId: id,
        itemDirection: 'purchase',
        skuId: item.skuId,
        productName: item.productName,
        skuSpecName: item.skuSpecName,
        productType: item.productType,
        sessionCount: item.sessionCount,
        remainingSessions: item.sessionCount,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        unitRealPrice: item.unitRealPrice,
        saleAmount,
        received: saleAmount,
        salesCategory: item.salesCategory || null,
      })
    }

    return id
  })

  await logOperation(session, 'order.create', 'sale_order', saleOrderId, {
    storeId: data.storeId, totalAmount: totalAmount.toFixed(2), itemCount: data.items.length,
  })

  revalidatePath('/orders')
  return { success: true, message: '订单创建成功', saleOrderId }
}
