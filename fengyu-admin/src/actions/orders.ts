'use server'

import { db } from '@/db'
import { saleOrders, saleItems } from '@db/order'
import { userCoupons, couponTemplates } from '@db/coupon'
import { stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { eq, desc, and, or, sql, ilike, gte, lt } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SaleOrder, SaleItem } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { calcCouponDiscount } from '@/lib/utils'

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

  await logOperation(session, 'order.confirmPayment', 'sale_order', saleOrderId)

  revalidatePath('/orders')
  return { success: true, message: '确认收款成功' }
}

/** C4: 关闭订单 — 仅待支付/支付失败可关闭，同时作废关联的分配记录 */
export async function closeOrder(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

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

  await logOperation(session, 'order.close', 'sale_order', saleOrderId)

  revalidatePath('/orders')
  revalidatePath('/allocations')
  return { success: true, message: '订单已关闭' }
}

/** C4: 重置支付失败 → 待支付（仅店长） */
export async function resetOrderFailed(saleOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sale_order:update')

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
  const initialStatus = data.paymentMethod === 'offline' ? '待确认收款' : '待支付'

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
        saleOrderSource: 'admin',
        openedBy: data.openedBy || session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: 'pending',
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
          unitRealPrice,
          saleAmount,
          received,
          salesCategory: item.salesCategory || null,
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
