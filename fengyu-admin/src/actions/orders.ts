'use server'

import { db } from '@/db'
import { saleOrders, saleItems } from '@db/order'
import { userCoupons, couponTemplates } from '@db/coupon'
import { stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus, productCategories } from '@db/product'
import { prepaidCards, cardTransactions } from '@db/prepaid-card'
import { eq, desc, and, or, sql, ilike, gte, lt, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SaleOrder, SaleItem } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logOperation, logTransition } from '@/lib/operation-log'
import { calcCouponDiscount } from '@/lib/utils'
import { getMemberThreshold } from '@/lib/member-threshold'

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
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    clientPhone: r.order.clientPhone,
    customerName: r.order.customerName,
    totalAmount: r.order.totalAmount,
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
  }))
}

/** 订单列表筛选参数 */
export interface OrderFilters {
  status?: string
  type?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedOrders {
  data: SaleOrder[]
  total: number
}

/**
 * 服务端分页订单列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * 替代 getOrders() 的客户端过滤模式，支持大数据量下的高效分页。
 * 筛选条件通过 URL searchParams → Server Component → 此函数流转。
 */
export async function getOrdersPaginated(filters: OrderFilters = {}): Promise<PaginatedOrders> {
  const session = await getSession()
  requirePermission(session, 'sale_order:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE 条件（DB 级过滤）
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, saleOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(saleOrders.status, filters.status as typeof saleOrders.status.enumValues[number]))
  }
  if (filters.type) {
    conditions.push(eq(saleOrders.saleOrderType, filters.type as typeof saleOrders.saleOrderType.enumValues[number]))
  }
  if (filters.storeId) {
    conditions.push(eq(saleOrders.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    conditions.push(gte(saleOrders.saleOrderDatetime, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lt(saleOrders.saleOrderDatetime, new Date(filters.dateTo + 'T23:59:59.999')))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(saleOrders.saleOrderId, pattern),
        ilike(saleOrders.customerName, pattern),
        ilike(saleOrders.clientPhone, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  // COUNT 查询（与数据查询共用相同 WHERE）
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  // 数据查询 — JOIN + ORDER + LIMIT/OFFSET
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(whereClause)
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(pageSize)
    .offset(offset)

  const data = rows.map((r) => ({
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
  }))

  return { data, total }
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

  // Get items with SKU join (product_name from sale_items snapshot)
  const itemRows = await db
    .select({
      item: saleItems,
      skuName: productSkus.specName,
    })
    .from(saleItems)
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
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
    productName: ir.item.productName ?? undefined,
  }))

  return {
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
    items,
  }
}

/** C4: 确认线下收款 — WHERE status = '待确认收款' + scope 保障幂等 */
export async function confirmOfflinePayment(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({ customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  // 事务：确认收款 + 设置到期日，原子提交（AC-13）
  try {
    const txResult = await db.transaction(async (tx) => {
      const result = await tx
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

      if ((result as any).count === 0) {
        return { matched: false }
      }

      // 设置单品到期日（支付成功后 1 年）
      await tx.execute(sql`
        UPDATE sale_items
        SET expire_date = (NOW() + INTERVAL '1 year')::date,
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND expire_date IS NULL
      `)

      return { matched: true }
    })

    if (!txResult.matched) {
      return { success: false, message: '订单状态已变更，无法确认收款' }
    }
  } catch {
    return { success: false, message: '确认收款失败，请稍后重试' }
  }

  await logTransition(session, 'order.confirmPayment', 'sale_order', saleOrderId, '待确认收款', '已支付', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  return { success: true, message: '确认收款成功' }
}

/** C4: 关闭订单 — 仅待支付/支付失败可关闭，同时作废关联的分配记录 */
export async function closeOrder(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({ status: saleOrders.status, customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  // 事务：关闭订单 + 作废分配，原子提交
  try {
    const txResult = await db.transaction(async (tx) => {
      const result = await tx
        .update(saleOrders)
        .set({ status: '已关闭' })
        .where(and(
          eq(saleOrders.saleOrderId, saleOrderId),
          or(eq(saleOrders.status, '待支付'), eq(saleOrders.status, '支付失败')),
          scopeCondition(session, saleOrders.storeId),
        ))

      if ((result as any).count === 0) {
        return { matched: false }
      }

      // 作废关联的分配记录（规范：订单关闭时作废分配）
      await tx.execute(sql`
        UPDATE sale_allocations SET is_void = true, voided_at = NOW()
        WHERE sale_item_id IN (
          SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
        ) AND is_void = false
      `)

      return { matched: true }
    })

    if (!txResult.matched) {
      return { success: false, message: '订单状态已变更，无法关闭' }
    }
  } catch {
    return { success: false, message: '关闭订单失败，请稍后重试' }
  }

  await logTransition(session, 'order.close', 'sale_order', saleOrderId, orderCtx?.status ?? '待支付', '已关闭', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  revalidatePath('/allocations')
  return { success: true, message: '订单已关闭' }
}

/** C4: 重置支付失败 → 待支付（仅店长） */
export async function resetOrderFailed(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({ customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(saleOrders)
      .set({ status: '待支付' })
      .where(and(
        eq(saleOrders.saleOrderId, saleOrderId),
        eq(saleOrders.status, '支付失败'),
        scopeCondition(session, saleOrders.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '订单状态已变更，无法重置' }
  }

  await logTransition(session, 'order.resetFailed', 'sale_order', saleOrderId, '支付失败', '待支付', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

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
  paymentMethod: '微信' | '支付宝' | '线下'
  saleOrderType: '销售单' | '内部单' | '回款单' | '转换单' | '退款单'
  openedBy?: string
  preferredEmployeeId?: string
  remark?: string | null
  /** 可选：顾客选择使用的优惠券实例ID */
  couponId?: string | null
  items: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '院装产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice: string
    quantity: number
    /** 手动应付金额（可选，覆盖 unitRealPrice * quantity） */
    saleAmount?: string
    /** 手动实付金额（可选，覆盖 saleAmount） */
    received?: string
    salesCategory?: '自采自销' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
}): Promise<{ success: boolean; message: string; saleOrderId?: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:create')

  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }

  // 内部单自动半价：入口统一在事务前对 items 金额 ×0.5；unit_price（原价快照）保持不变。
  // 服务费 (service_fee) 不受半价影响，仍按 SKU 配置快照。
  if (data.saleOrderType === '内部单') {
    if (data.couponId) {
      return { success: false, message: '内部单不允许叠加优惠券' }
    }
    data = {
      ...data,
      items: data.items.map((item) => {
        const halve = (v: string) => (Number(v) / 2).toFixed(2)
        return {
          ...item,
          unitRealPrice: halve(item.unitRealPrice),
          saleAmount: item.saleAmount !== undefined ? halve(item.saleAmount) : undefined,
          received: item.received !== undefined ? halve(item.received) : undefined,
        }
      }),
    }
  }

  // 校验手动金额
  for (const item of data.items) {
    if (item.saleAmount !== undefined) {
      const sa = Number(item.saleAmount)
      if (isNaN(sa) || sa < 0) return { success: false, message: '应付金额无效' }
    }
    if (item.received !== undefined) {
      const rc = Number(item.received)
      if (isNaN(rc) || rc < 0) return { success: false, message: '实付金额无效' }
      const sa = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      if (rc > sa + 0.005) return { success: false, message: '实付金额不能超过应付金额' }
    }
  }

  // 计算商品总金额（基于 received 实收）
  const rawTotal = data.items.reduce((sum, item) => {
    const computed = Number(item.unitRealPrice) * item.quantity
    return sum + (item.received ? Number(item.received) : (item.saleAmount ? Number(item.saleAmount) : computed))
  }, 0)

  // 应付金额合计（用于优惠券 minSpend 校验）
  const saleAmountTotal = data.items.reduce((sum, item) => {
    return sum + (item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity)
  }, 0)

  // 提前校验优惠券（事务外查询，避免在事务内做复杂查询）
  let couponDiscount = 0
  if (data.couponId && data.clientUserId) {
    const [coupon] = await db
      .select({
        status: userCoupons.status,
        expireAt: userCoupons.expireAt,
        userId: userCoupons.userId,
        couponType: couponTemplates.couponType,
        discountValue: couponTemplates.discountValue,
        maxDiscount: couponTemplates.maxDiscount,
        minSpend: couponTemplates.minSpend,
        isActive: couponTemplates.isActive,
      })
      .from(userCoupons)
      .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
      .where(eq(userCoupons.couponId, data.couponId))
      .limit(1)

    if (!coupon) return { success: false, message: '优惠券不存在' }
    if (coupon.userId !== data.clientUserId) return { success: false, message: '优惠券不属于该顾客' }
    if (coupon.status !== '未使用') return { success: false, message: '优惠券已被使用或已失效' }
    if (coupon.expireAt < new Date()) return { success: false, message: '优惠券已过期' }
    if (!coupon.isActive) return { success: false, message: '该优惠券模板已停用' }
    const minSpend = parseFloat(coupon.minSpend ?? '0')
    if (saleAmountTotal < minSpend) {
      return { success: false, message: `订单金额未满足优惠券最低消费 ¥${minSpend.toFixed(2)}` }
    }
    couponDiscount = calcCouponDiscount(coupon.couponType, coupon.discountValue, coupon.maxDiscount ?? null, saleAmountTotal)
  }

  const totalAmount = Math.max(0, rawTotal - couponDiscount)
  const initialStatus = data.paymentMethod === '线下' ? '待确认收款' : '待支付'

  // 计算 document_type（售前/售后快照）
  let documentType: '售前' | '售后' = '售前'
  if (data.clientUserId) {
    const [client] = await db
      .select({ customerType: clientWechatUsers.customerType })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (client?.customerType === '会员客') {
      documentType = '售后'
    }
  }
  if (documentType === '售前') {
    const threshold = await getMemberThreshold()
    if (totalAmount >= threshold) {
      documentType = '售后'
    }
  }

  // 事务外批量查询本次涉及 sku 的 service_fee（固定手工费）
  // 用于 sale_items.service_fee 快照，开单后服务完成时参与提成计算
  const skuIdList = data.items.map(i => i.skuId).filter((s): s is string => !!s)
  const skuFeeMap = new Map<string, string>()
  if (skuIdList.length > 0) {
    const skuRows = await db
      .select({ skuId: productSkus.skuId, serviceFee: productSkus.serviceFee })
      .from(productSkus)
      .where(inArray(productSkus.skuId, skuIdList))
    for (const r of skuRows) skuFeeMap.set(r.skuId, r.serviceFee)
  }

  // 事务：ID 生成 + 优惠券核销 + 订单 + 明细，原子提交或全部回滚
  let saleOrderId: string
  try {
    saleOrderId = await db.transaction(async (tx) => {
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

      // 检查该顾客是否已有待支付订单（partial unique index 保护）
      if (initialStatus === '待支付' && data.clientUserId) {
        const existing = await tx
          .select({ saleOrderId: saleOrders.saleOrderId })
          .from(saleOrders)
          .where(
            and(
              eq(saleOrders.clientUserId, data.clientUserId),
              eq(saleOrders.status, '待支付')
            )
          )
          .limit(1)
        if (existing.length > 0) {
          throw new Error(`该顾客已有待支付订单 ${existing[0].saleOrderId}，请先关闭后再创建新订单`)
        }
      }

      await tx.insert(saleOrders).values({
        saleOrderId: id,
        status: initialStatus,
        saleOrderType: data.saleOrderType,
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        saleOrderDatetime: new Date(),
        clientUserId: data.clientUserId,
        clientPhone: data.clientPhone,
        customerName: data.customerName,
        totalAmount: totalAmount.toFixed(2),
        couponId: data.couponId ?? null,
        couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : '0',
        paymentMethod: data.paymentMethod,
        openedBy: data.openedBy || session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: '待分配',
        remark: data.remark || null,
      })

      // 原子核销优惠券：WHERE coupon_id = X AND status = '未使用' 防止重用
      // 必须在 insert sale_orders 之后，因为 used_sale_order_id 有外键约束
      if (data.couponId) {
        const voidResult = await tx
          .update(userCoupons)
          .set({ status: '已使用', usedSaleOrderId: id, usedAt: new Date() })
          .where(and(eq(userCoupons.couponId, data.couponId), eq(userCoupons.status, '未使用')))

        if ((voidResult as any).count === 0) {
          throw new Error('优惠券已被使用，请刷新后重试')
        }
      }

      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i]
        const saleItemId = `${id}-${String(i + 1).padStart(2, '0')}`
        const computedSaleAmount = (Number(item.unitRealPrice) * item.quantity).toFixed(2)
        const saleAmount = item.saleAmount ?? computedSaleAmount
        const received = item.received ?? saleAmount
        const unitRealPrice = item.saleAmount
          ? (Number(item.saleAmount) / item.quantity).toFixed(2)
          : item.unitRealPrice

        // 固定手工费快照 = product_skus.service_fee × quantity
        const skuServiceFee = Number(skuFeeMap.get(item.skuId) || 0)
        const serviceFee = (skuServiceFee * item.quantity).toFixed(2)

        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId: id,
          itemDirection: '购买',
          skuId: item.skuId,
          productName: item.productName,
          skuSpecName: item.skuSpecName,
          productType: item.productType,
          sessionCount: item.sessionCount,
          remainingSessions: item.sessionCount,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          unitRealPrice,
          saleAmount,
          received,
          salesCategory: item.salesCategory || null,
          serviceFee,
        })
      }

      return id
    })
  } catch (err: any) {
    // 事务内业务异常 → 友好消息
    if (err?.message === '订单号生成失败') {
      return { success: false, message: '订单号生成失败，请稍后重试' }
    }
    if (err?.message?.startsWith('该顾客已有待支付订单')) {
      return { success: false, message: err.message }
    }
    if (err?.message === '优惠券已被使用，请刷新后重试') {
      return { success: false, message: err.message }
    }
    // PG 外键违反（storeId / skuId / clientUserId 不存在）
    if (err?.code === '23503') {
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    // PG 唯一约束冲突（advisory lock 下极罕见）
    if (err?.code === '23505') {
      return { success: false, message: '订单号冲突，请稍后重试' }
    }
    return { success: false, message: '创建订单失败，请稍后重试' }
  }

  await logOperation(session, 'order.create', 'sale_order', saleOrderId, {
    storeId: data.storeId, totalAmount: totalAmount.toFixed(2), itemCount: data.items.length,
    couponId: data.couponId ?? null, couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : null,
  })

  revalidatePath('/orders')
  return { success: true, message: '订单创建成功', saleOrderId }
}

/**
 * 转换单 — 顾客持卡折抵换购
 *
 * 业务流程：
 * 1. 锁住 convertOutSaleItemIds 对应 sale_items 行（FOR UPDATE），校验 store_id / item_direction / 状态
 * 2. 计算转出折抵金额 totalOut = sum(unit_real_price × 可折抵数量)
 *    - 疗程卡：remaining_sessions
 *    - 单品：quantity - COALESCE(picked_up_quantity, 0)
 * 3. 计算转入应付金额 totalIn = sum(sku.price × quantity)
 * 4. priceDiff = totalIn - totalOut
 *    - priceDiff > 0：补现（paymentMethod），sale_orders.total_amount = priceDiff，status='待支付'/'待确认收款'
 *    - priceDiff = 0：不收款，status='已支付'
 *    - priceDiff < 0：差额 UPSERT 到 prepaid_cards，INSERT card_transactions('充值')
 * 5. 原子标记转出行已耗尽：疗程卡 remaining_sessions=0；单品 picked_up_quantity=quantity
 * 6. INSERT 转出行（sale_amount/received 为负折抵，item_direction='转出'，ref_sale_item_id）
 * 7. INSERT 转入行（item_direction='转入'，sale_amount/received=转入金额）
 */
export async function createConversionOrder(data: {
  storeId: string
  marketName: string
  /** 转换单必须实名顾客（要挂储值卡），不允许 manualPhone */
  clientUserId: string
  paymentMethod: '微信' | '支付宝' | '线下'
  preferredEmployeeId?: string
  remark?: string | null
  /** 转出：整张卡（不带数量，全部折抵） */
  convertOutSaleItemIds: string[]
  /** 转入项目（来自 Step 2 的购物车） */
  convertInItems: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '院装产品'
    sessionCount: number | null
    unitPrice: string
    quantity: number
    salesCategory?: '自采自销' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
}): Promise<{
  success: boolean
  message: string
  saleOrderId?: string
  totalIn?: number
  totalOut?: number
  priceDiff?: number
  prepaidCardCredit?: number
}> {
  const session = await getSession()
  requirePermission(session, 'sale_order:create')

  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }
  if (!data.clientUserId) {
    return { success: false, message: '转换单必须指定顾客' }
  }
  if (!data.convertOutSaleItemIds?.length) {
    return { success: false, message: '请选择至少一张折抵卡' }
  }
  if (!data.convertInItems?.length) {
    return { success: false, message: '请选择至少一个转入项目' }
  }

  // 查顾客基本信息（姓名快照 + phone 快照）
  const [client] = await db
    .select({
      userId: clientWechatUsers.userId,
      phone: clientWechatUsers.phone,
      name: clientWechatUsers.name,
      customerType: clientWechatUsers.customerType,
    })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  if (!client) {
    return { success: false, message: '顾客不存在' }
  }

  // 事务：锁转出行 + 校验 + 计算金额 + 插入订单 + 插入两段 items + 储值卡补差
  let result: {
    saleOrderId: string
    totalIn: number
    totalOut: number
    priceDiff: number
    prepaidCardCredit: number
  }

  try {
    result = await db.transaction(async (tx) => {
      // 1. 锁住转出候选行（FOR UPDATE）并 JOIN product_categories 以识别"体验卡单品"
      const heldRows = await tx.execute(sql`
        SELECT
          si.sale_item_id,
          si.store_id,
          si.item_direction,
          si.sku_id,
          si.product_name,
          si.sku_spec_name,
          si.product_type,
          si.session_count,
          si.remaining_sessions,
          si.quantity,
          si.picked_up_quantity,
          si.unit_price,
          si.unit_real_price,
          si.sales_category,
          si.service_fee,
          so.client_user_id,
          so.status AS order_status,
          pc.product_kind
        FROM sale_items si
        INNER JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
        LEFT JOIN product_skus psk ON psk.sku_id = si.sku_id
        LEFT JOIN product_categories pc ON pc.category_id = psk.category_id
        WHERE si.sale_item_id = ANY(${data.convertOutSaleItemIds})
        FOR UPDATE OF si
      `)

      const held = Array.from(heldRows as unknown as Iterable<Record<string, unknown>>)
      if (held.length !== data.convertOutSaleItemIds.length) {
        throw new Error('CARD_NOT_FOUND')
      }

      let totalOut = 0
      type OutItem = {
        refSaleItemId: string
        skuId: string | null
        productName: string | null
        skuSpecName: string | null
        productType: '疗程卡' | '单品' | '院装产品' | null
        sessionCount: number | null
        unitPrice: string
        unitRealPrice: string
        quantity: number
        amount: number
        salesCategory: string | null
        serviceFee: number
      }
      const outItems: OutItem[] = []

      for (const row of held) {
        // 归属校验：store_id / client_user_id / direction / 状态
        if (row.store_id !== data.storeId) throw new Error('CARD_STORE_MISMATCH')
        if (row.client_user_id !== data.clientUserId) throw new Error('CARD_OWNER_MISMATCH')
        if (row.item_direction !== '购买') throw new Error('CARD_DIRECTION_INVALID')
        if (row.order_status !== '已支付' && row.order_status !== '已完成') {
          throw new Error('CARD_ORDER_STATUS_INVALID')
        }

        const unit = Number(row.unit_real_price)
        const productType = row.product_type as string

        let qty = 0
        if (productType === '疗程卡') {
          const rem = Number(row.remaining_sessions ?? 0)
          if (rem <= 0) throw new Error('CARD_EXHAUSTED')
          qty = rem
        } else if (productType === '单品' && row.product_kind === '体验卡') {
          const remQty = Number(row.quantity) - Number(row.picked_up_quantity ?? 0)
          if (remQty <= 0) throw new Error('CARD_EXHAUSTED')
          qty = remQty
        } else {
          throw new Error('CARD_TYPE_INVALID')
        }

        const amount = Math.round(unit * qty * 100) / 100
        totalOut += amount
        // 按折抵数量比例扣减 service_fee（负值）
        const origServiceFee = Number(row.service_fee ?? 0)
        const origQty = Number(row.quantity) || 1
        const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

        outItems.push({
          refSaleItemId: row.sale_item_id as string,
          skuId: (row.sku_id as string) ?? null,
          productName: (row.product_name as string) ?? null,
          skuSpecName: (row.sku_spec_name as string) ?? null,
          productType: productType as OutItem['productType'],
          sessionCount: row.session_count !== null ? Number(row.session_count) : null,
          unitPrice: String(row.unit_price),
          unitRealPrice: String(row.unit_real_price),
          quantity: qty,
          amount,
          salesCategory: (row.sales_category as string) ?? null,
          serviceFee: outServiceFee,
        })
      }

      // 2. 加载转入 SKU 详情（price / service_fee / session_count / sales_category）
      const inSkuIds = data.convertInItems.map((i) => i.skuId)
      const skuRows = await tx
        .select({
          skuId: productSkus.skuId,
          price: productSkus.price,
          serviceFee: productSkus.serviceFee,
          sessionCount: productSkus.sessionCount,
          productType: productSkus.productType,
          salesCategory: productCategories.salesCategory,
        })
        .from(productSkus)
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(inArray(productSkus.skuId, inSkuIds))
      const skuMap = new Map(skuRows.map((r) => [r.skuId, r]))

      let totalIn = 0
      const inItems: Array<{
        item: (typeof data.convertInItems)[number]
        sku: typeof skuRows[number]
        amount: number
        serviceFee: number
      }> = []
      for (const inItem of data.convertInItems) {
        const sku = skuMap.get(inItem.skuId)
        if (!sku) throw new Error(`SKU_NOT_FOUND:${inItem.skuId}`)
        const amount = Math.round(Number(sku.price) * inItem.quantity * 100) / 100
        totalIn += amount
        const serviceFee = Math.round(Number(sku.serviceFee ?? 0) * inItem.quantity * 100) / 100
        inItems.push({ item: inItem, sku, amount, serviceFee })
      }

      const priceDiff = Math.round((totalIn - totalOut) * 100) / 100

      // 3. 生成订单号（advisory lock + 当日序号）
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
      const saleOrderId = (idRows as any[])[0]?.id as string
      if (!saleOrderId) throw new Error('ORDER_ID_GEN_FAILED')

      // 4. 计算 documentType（售前/售后）
      let documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'
      if (documentType === '售前') {
        const threshold = await getMemberThreshold()
        if (totalIn >= threshold) documentType = '售后'
      }

      // 5. 插入订单主表
      // 顾客补现场景：priceDiff > 0 → total_amount=priceDiff，status 按支付方式决定
      // 其他：total_amount=0 & status='已支付'
      const orderTotal = Math.max(0, priceDiff).toFixed(2)
      const orderStatus: typeof saleOrders.$inferInsert['status'] =
        priceDiff > 0 ? (data.paymentMethod === '线下' ? '待确认收款' : '待支付') : '已支付'

      await tx.insert(saleOrders).values({
        saleOrderId,
        status: orderStatus,
        saleOrderType: '转换单',
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        saleOrderDatetime: new Date(),
        clientUserId: data.clientUserId,
        clientPhone: client.phone ?? null,
        customerName: client.name ?? null,
        totalAmount: orderTotal,
        paymentMethod: data.paymentMethod,
        openedBy: session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: '待分配',
        remark: data.remark || null,
        paidAt: priceDiff > 0 ? null : new Date(),
      })

      // 6. 转出行 + 原子扣减原卡余量
      let seq = 1
      for (const out of outItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转出',
          refSaleItemId: out.refSaleItemId,
          skuId: out.skuId,
          productName: out.productName,
          skuSpecName: out.skuSpecName,
          productType: out.productType,
          sessionCount: out.sessionCount,
          unitPrice: out.unitPrice,
          quantity: out.quantity,
          unitRealPrice: out.unitRealPrice,
          saleAmount: (-out.amount).toFixed(2),
          received: (-out.amount).toFixed(2),
          salesCategory: (out.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ?? null,
          serviceFee: out.serviceFee.toFixed(2),
        })

        // 原子标记耗尽：疗程卡 remaining_sessions=0；单品 picked_up_quantity=quantity
        if (out.productType === '疗程卡') {
          const upd = await tx
            .update(saleItems)
            .set({ remainingSessions: 0 })
            .where(
              and(
                eq(saleItems.saleItemId, out.refSaleItemId),
                eq(saleItems.storeId, data.storeId),
                sql`COALESCE(${saleItems.remainingSessions}, 0) >= ${out.quantity}`,
              ),
            )
          if ((upd as any).count === 0) throw new Error('CARD_CONCURRENT_CHANGED')
        } else if (out.productType === '单品') {
          const upd = await tx
            .update(saleItems)
            .set({ pickedUpQuantity: sql`${saleItems.quantity}` })
            .where(
              and(
                eq(saleItems.saleItemId, out.refSaleItemId),
                eq(saleItems.storeId, data.storeId),
                sql`${saleItems.quantity} - COALESCE(${saleItems.pickedUpQuantity}, 0) >= ${out.quantity}`,
              ),
            )
          if ((upd as any).count === 0) throw new Error('CARD_CONCURRENT_CHANGED')
        }
      }

      // 7. 转入行
      for (const inRow of inItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        const unitPrice = inRow.sku.price
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转入',
          skuId: inRow.item.skuId,
          productName: inRow.item.productName,
          skuSpecName: inRow.item.skuSpecName,
          productType: inRow.item.productType,
          sessionCount: inRow.item.sessionCount,
          remainingSessions: inRow.item.sessionCount,
          unitPrice,
          quantity: inRow.item.quantity,
          unitRealPrice: unitPrice,
          saleAmount: inRow.amount.toFixed(2),
          received: inRow.amount.toFixed(2),
          salesCategory:
            (inRow.item.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
            (inRow.sku.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
            null,
          serviceFee: inRow.serviceFee.toFixed(2),
        })
      }

      // 8. 差额退余：priceDiff < 0 → UPSERT prepaid_cards + card_transactions
      let prepaidCardCredit = 0
      if (priceDiff < 0) {
        const creditAmount = Math.abs(priceDiff)
        prepaidCardCredit = creditAmount

        // UPSERT prepaid_cards (user_id, store_id) DO UPDATE balance += creditAmount
        const upsertRows = await tx.execute(sql`
          INSERT INTO prepaid_cards (card_id, user_id, store_id, balance)
          VALUES (gen_random_uuid()::text, ${data.clientUserId}, ${data.storeId}, ${creditAmount.toFixed(2)})
          ON CONFLICT (user_id, store_id) DO UPDATE
            SET balance = prepaid_cards.balance + EXCLUDED.balance,
                updated_at = NOW()
          RETURNING card_id
        `)
        const cardId = (upsertRows as any[])[0]?.card_id as string
        if (!cardId) throw new Error('PREPAID_CARD_UPSERT_FAILED')

        await tx.insert(cardTransactions).values({
          cardId,
          type: '充值',
          amount: creditAmount.toFixed(2),
          refOrderId: saleOrderId,
        })
      }

      return {
        saleOrderId,
        totalIn: Math.round(totalIn * 100) / 100,
        totalOut: Math.round(totalOut * 100) / 100,
        priceDiff,
        prepaidCardCredit,
      }
    })
  } catch (err: any) {
    const m = err?.message as string | undefined
    if (m === 'CARD_NOT_FOUND') return { success: false, message: '部分卡不存在或已失效' }
    if (m === 'CARD_STORE_MISMATCH') return { success: false, message: '所选卡不属于当前门店' }
    if (m === 'CARD_OWNER_MISMATCH') return { success: false, message: '所选卡不属于该顾客' }
    if (m === 'CARD_DIRECTION_INVALID') return { success: false, message: '所选行非购买行，不可折抵' }
    if (m === 'CARD_ORDER_STATUS_INVALID') return { success: false, message: '原订单状态不允许转换' }
    if (m === 'CARD_EXHAUSTED') return { success: false, message: '所选卡已耗尽，无法折抵' }
    if (m === 'CARD_TYPE_INVALID') return { success: false, message: '所选行类型不支持折抵' }
    if (m === 'CARD_CONCURRENT_CHANGED') return { success: false, message: '卡状态变化，请重试' }
    if (m === 'ORDER_ID_GEN_FAILED') return { success: false, message: '订单号生成失败，请稍后重试' }
    if (m === 'PREPAID_CARD_UPSERT_FAILED') return { success: false, message: '储值卡入账失败，请稍后重试' }
    if (m?.startsWith('SKU_NOT_FOUND:')) return { success: false, message: '转入 SKU 不存在' }
    if (err?.code === '23503') return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    if (err?.code === '23505') return { success: false, message: '订单号冲突，请稍后重试' }
    return { success: false, message: '转换单创建失败，请稍后重试' }
  }

  await logOperation(session, 'order.create_conversion', 'sale_order', result.saleOrderId, {
    storeId: data.storeId,
    saleOrderId: result.saleOrderId,
    convertOutSaleItemIds: data.convertOutSaleItemIds,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
  })

  revalidatePath('/orders')
  return {
    success: true,
    message:
      result.priceDiff > 0
        ? `转换单已创建，请收款 ¥${result.priceDiff.toFixed(2)}`
        : result.priceDiff < 0
          ? `转换单已完成，差额 ¥${result.prepaidCardCredit.toFixed(2)} 已充入储值卡`
          : '转换单已完成',
    saleOrderId: result.saleOrderId,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
  }
}

// ========== 小程序码生成 ==========

const WX_CLIENT_APPID = process.env.WX_CLIENT_APPID || 'wx811eb4ded3dfba3f'
const WX_CLIENT_SECRET = process.env.WX_CLIENT_SECRET
const WXACODE_ENV_VERSION = process.env.WXACODE_ENV_VERSION || 'release'

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getClientAccessToken(forceRefresh = false): Promise<string> {
  if (!WX_CLIENT_SECRET) {
    throw new Error('未配置 WX_CLIENT_SECRET 环境变量')
  }
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_CLIENT_APPID}&secret=${WX_CLIENT_SECRET}`
  const res = await fetch(url)
  const data = await res.json()
  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`)
  }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken!
}

/** 生成客户端小程序码，返回 base64 data URL */
export async function generateOrderWxacode(saleOrderId: string): Promise<{ success: boolean; dataUrl?: string; message?: string }> {
  if (!WX_CLIENT_SECRET) {
    return { success: false, message: '未配置小程序密钥' }
  }

  try {
    let token = await getClientAccessToken()
    let buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')

    // 响应小于 1000 字节可能是错误 JSON
    if (buffer.byteLength < 1000) {
      const text = new TextDecoder().decode(buffer)
      try {
        const errData = JSON.parse(text)
        if (errData.errcode === 42001 || errData.errcode === 40001) {
          token = await getClientAccessToken(true)
          buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')
          if (buffer.byteLength < 1000) {
            const retryErr = JSON.parse(new TextDecoder().decode(buffer))
            return { success: false, message: `生成失败: ${retryErr.errcode} ${retryErr.errmsg}` }
          }
        } else if (errData.errcode) {
          return { success: false, message: `生成失败: ${errData.errcode} ${errData.errmsg}` }
        }
      } catch {
        // 不是 JSON，当作正常图片
      }
    }

    const base64 = Buffer.from(buffer).toString('base64')
    return { success: true, dataUrl: `data:image/png;base64,${base64}` }
  } catch (err: any) {
    return { success: false, message: err.message || '生成小程序码失败' }
  }
}

async function requestWxacode(token: string, scene: string, page: string): Promise<ArrayBuffer> {
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene,
      page,
      check_path: false,
      env_version: WXACODE_ENV_VERSION,
      width: 430,
      auto_color: false,
      line_color: { r: 212, g: 167, b: 106 },
    }),
  })
  return res.arrayBuffer()
}
