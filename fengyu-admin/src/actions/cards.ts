'use server'

import { db } from '@/db'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { stores, orgNodes } from '@db/org'
import { serviceItems, serviceOrders } from '@db/service'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { prepaidCards } from '@db/prepaid-card'
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { nowTs } from '@/lib/db-time'






export type CardTypeFilter = 'all' | '疗程卡' | '单次卡'


export type CardStatusFilter = 'active' | 'exhausted' | 'expired'


export interface CardFilters {
  marketId?: string
  storeId?: string
  type?: CardTypeFilter
  status?: CardStatusFilter
  search?: string
  page?: number
  pageSize?: number
}


export interface AdminCard {
  saleItemId: string
  saleOrderId: string
  
  productName: string | null
  
  sessionCount: number | null
  
  remainingSessions: number | null
  
  paidSessions: number | null
  
  paidUnusedSessions: number | null
  
  quantity: number
  
  expireDate: string | null
  
  paidAt: string | null
  storeId: string
  storeName: string | null
  marketName: string | null
  clientUserId: string | null
  clientName: string | null
  clientPhone: string | null
}


export interface PaginatedCards {
  data: AdminCard[]
  total: number
}




const paidUnusedSessionsExpr = sql<number>`CASE WHEN ${saleItems.paidSessions} IS NULL THEN ${saleItems.remainingSessions} ELSE GREATEST(COALESCE(${saleItems.paidSessions}, 0) - GREATEST(${saleItems.sessionCount} - ${saleItems.remainingSessions}, 0), 0) END`.as('paid_unused_sessions')

export const getCardsPaginated = withPermission(
  'sale_item:list',
  async (session, filters: CardFilters = {}): Promise<PaginatedCards> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    
    eq(saleItems.itemDirection, '购买'),
    eq(saleItems.productType, '疗程卡'),
    isNotNull(saleItems.remainingSessions),
    
    
    sql`${saleItems.paidSessions} > 0`,
    
    scopeCondition(session, saleItems.storeId),
  ]

  
  if (filters.marketId) {
    const sub = db.select({ storeId: stores.storeId }).from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, filters.marketId))
    conditions.push(inArray(saleItems.storeId, sub))
  }
  
  if (filters.storeId) {
    conditions.push(eq(saleItems.storeId, filters.storeId))
  }
  
  if (filters.type === '疗程卡') {
    conditions.push(gte(saleItems.sessionCount, 2))
  } else if (filters.type === '单次卡') {
    conditions.push(eq(saleItems.sessionCount, 1))
  }
  
  if (filters.status === 'active') {
    conditions.push(sql`${saleItems.remainingSessions} > 0`)
    conditions.push(
      or(
        isNull(saleItems.expireDate),
        sql`${saleItems.expireDate} >= CURRENT_DATE`,
      ),
    )
  } else if (filters.status === 'exhausted') {
    conditions.push(eq(saleItems.remainingSessions, 0))
  } else if (filters.status === 'expired') {
    conditions.push(isNotNull(saleItems.expireDate))
    conditions.push(sql`${saleItems.expireDate} < CURRENT_DATE`)
  }
  
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&')
    const pattern = `%${escaped}%`
    conditions.push(
      or(
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  
  const marketNameExpr = sql<string | null>`(
    SELECT n.name FROM stores s
    JOIN org_nodes sn ON sn.id = s.org_node_id
    JOIN org_nodes n ON n.id = sn.parent_id
    WHERE s.store_id = ${saleItems.storeId}
  )`.as('market_name')

  
  const countQuery = db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleItems)
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)

  
  const dataQuery = db
    .select({
      saleItemId: saleItems.saleItemId,
      saleOrderId: saleItems.saleOrderId,
      productName: saleItems.productName,
      sessionCount: saleItems.sessionCount,
      remainingSessions: saleItems.remainingSessions,
      paidSessions: saleItems.paidSessions,
      paidUnusedSessions: paidUnusedSessionsExpr,
      quantity: saleItems.quantity,
      expireDate: saleItems.expireDate,
      paidAt: saleOrders.paidAt,
      storeId: saleItems.storeId,
      storeName: stores.storeName,
      marketName: marketNameExpr,
      clientUserId: saleOrders.clientUserId,
      clientName: clientWechatUsers.name,
      clientPhone: clientWechatUsers.phone,
    })
    .from(saleItems)
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(saleItems.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    
    .orderBy(desc(saleOrders.paidAt), desc(saleItems.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [[countRow], rows] = await Promise.all([countQuery, dataQuery])

  return {
    data: rows.map((r) => ({
      saleItemId: r.saleItemId,
      saleOrderId: r.saleOrderId,
      productName: r.productName ?? null,
      sessionCount: r.sessionCount ?? null,
      remainingSessions: r.remainingSessions ?? null,
      paidSessions: r.paidSessions ?? null,
      paidUnusedSessions: r.paidUnusedSessions ?? null,
      quantity: r.quantity ?? 1,
      expireDate: r.expireDate ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      storeId: r.storeId,
      storeName: r.storeName ?? null,
      marketName: r.marketName ?? null,
      clientUserId: r.clientUserId ?? null,
      clientName: r.clientName ?? null,
      clientPhone: r.clientPhone ?? null,
    })),
    total: countRow?.count ?? 0,
  }
  },
)









export interface CardDetail {
  
  saleItemId: string
  saleOrderId: string
  productName: string | null
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  
  paidUnusedSessions: number | null
  unitPrice: string
  unitRealPrice: string
  saleAmount: string
  received: string
  quantity: number
  expireDate: string | null
  itemDirection: string
  productType: '疗程卡' | '家居产品' | null
  
  storeId: string
  storeName: string | null
  marketName: string | null
  clientUserId: string | null
  clientName: string | null
  clientPhone: string | null
  
  paidAt: string | null
  orderCreatedAt: string | null
  orderStatus: string | null
}

export const getCardById = withPermission(
  'sale_item:list',
  async (session, saleItemId: string): Promise<CardDetail | null> => {
    if (!saleItemId) return null

    
    const marketNameExpr = sql<string | null>`(
      SELECT n.name FROM stores s
      JOIN org_nodes sn ON sn.id = s.org_node_id
      JOIN org_nodes n ON n.id = sn.parent_id
      WHERE s.store_id = ${saleItems.storeId}
    )`.as('market_name')

    const rows = await db
      .select({
        saleItemId: saleItems.saleItemId,
        saleOrderId: saleItems.saleOrderId,
        productName: saleItems.productName,
        sessionCount: saleItems.sessionCount,
        remainingSessions: saleItems.remainingSessions,
        paidSessions: saleItems.paidSessions,
        paidUnusedSessions: paidUnusedSessionsExpr,
        unitPrice: saleItems.unitPrice,
        unitRealPrice: saleItems.unitRealPrice,
        saleAmount: saleItems.saleAmount,
        received: saleItems.received,
        quantity: saleItems.quantity,
        expireDate: saleItems.expireDate,
        itemDirection: saleItems.itemDirection,
        productType: saleItems.productType,
        storeId: saleItems.storeId,
        storeName: stores.storeName,
        marketName: marketNameExpr,
        clientUserId: saleOrders.clientUserId,
        clientName: clientWechatUsers.name,
        clientPhone: clientWechatUsers.phone,
        paidAt: saleOrders.paidAt,
        orderCreatedAt: saleOrders.createdAt,
        orderStatus: saleOrders.status,
      })
      .from(saleItems)
      .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(stores, eq(saleItems.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .where(
        and(
          eq(saleItems.saleItemId, saleItemId),
          eq(saleItems.itemDirection, '购买'),
          scopeCondition(session, saleItems.storeId),
        ),
      )
      .limit(1)

    if (rows.length === 0) return null
    const r = rows[0]

    return {
      saleItemId: r.saleItemId,
      saleOrderId: r.saleOrderId,
      productName: r.productName ?? null,
      sessionCount: r.sessionCount ?? null,
      remainingSessions: r.remainingSessions ?? null,
      paidSessions: r.paidSessions ?? null,
      paidUnusedSessions: r.paidUnusedSessions ?? null,
      unitPrice: r.unitPrice,
      unitRealPrice: r.unitRealPrice,
      saleAmount: r.saleAmount,
      received: r.received,
      quantity: r.quantity ?? 1,
      expireDate: r.expireDate ?? null,
      itemDirection: r.itemDirection,
      productType: (r.productType as '疗程卡' | '家居产品' | null) ?? null,
      storeId: r.storeId,
      storeName: r.storeName ?? null,
      marketName: r.marketName ?? null,
      clientUserId: r.clientUserId ?? null,
      clientName: r.clientName ?? null,
      clientPhone: r.clientPhone ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      orderCreatedAt: r.orderCreatedAt?.toISOString() ?? null,
      orderStatus: r.orderStatus ?? null,
    }
  },
)

export interface CardTransaction {
  serviceItemId: string
  serviceOrderId: string
  serviceDate: string
  serviceOrderStatus: string
  sessionUsed: number
  unitRealPriceSnapshot: string | null
  employeeId: string | null
  employeeName: string | null
}

export const getCardTransactions = withPermission(
  'sale_item:list',
  async (_session, saleItemId: string): Promise<CardTransaction[]> => {
    if (!saleItemId) return []

    const rows = await db
      .select({
        serviceItemId: serviceItems.serviceItemId,
        serviceOrderId: serviceItems.serviceOrderId,
        serviceDate: serviceOrders.serviceDate,
        serviceOrderStatus: serviceOrders.status,
        sessionUsed: serviceItems.sessionUsed,
        unitRealPriceSnapshot: serviceItems.unitRealPrice,
        employeeId: serviceItems.employeeId,
        employeeName: staffWechatUsers.name,
      })
      .from(serviceItems)
      .innerJoin(serviceOrders, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
      .leftJoin(staffWechatUsers, eq(serviceItems.employeeId, staffWechatUsers.employeeId))
      .where(eq(serviceItems.saleItemId, saleItemId))
      .orderBy(desc(serviceOrders.serviceDate), desc(serviceItems.createdAt))

    return rows.map((r) => ({
      serviceItemId: r.serviceItemId,
      serviceOrderId: r.serviceOrderId,
      serviceDate: r.serviceDate,
      serviceOrderStatus: r.serviceOrderStatus,
      sessionUsed: r.sessionUsed,
      unitRealPriceSnapshot: r.unitRealPriceSnapshot ?? null,
      employeeId: r.employeeId ?? null,
      employeeName: r.employeeName ?? null,
    }))
  },
)






export interface HeldCardCandidate {
  saleItemId: string
  productName: string | null
  productType: '疗程卡' | '家居产品'
  
  remainingSessions: number | null
  
  remainingQty: number | null
  unitRealPrice: string
  
  deductibleAmount: string
}

export const getCustomerHeldCards = withPermission(
  'sale_order:list',
  async (
    session,
    clientUserId: string,
    storeId: string,
  ): Promise<HeldCardCandidate[]> => {
  if (!clientUserId || !storeId) return []
  
  if (!isInScope(session, storeId)) return []

  const rows = await db
    .select({
      saleItemId: saleItems.saleItemId,
      productName: saleItems.productName,
      productType: saleItems.productType,
      remainingSessions: saleItems.remainingSessions,
      quantity: saleItems.quantity,
      pickedUpQuantity: saleItems.pickedUpQuantity,
      unitRealPrice: saleItems.unitRealPrice,
      productKind: productCategories.productKind,
    })
    .from(saleItems)
    .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(
      and(
        eq(saleItems.storeId, storeId),
        eq(saleOrders.clientUserId, clientUserId),
        eq(saleItems.itemDirection, '购买'),
        or(eq(saleOrders.status, '已支付'), eq(saleOrders.status, '已完成')),
        
        eq(saleItems.productType, '疗程卡'),
        sql`COALESCE(${saleItems.remainingSessions}, 0) > 0`,
        
        sql`NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '待审批')`,
        
        sql`(NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付') OR ${saleItems.paidSessions} IS NULL OR ${saleItems.paidSessions} > (${saleItems.sessionCount} - ${saleItems.remainingSessions}))`,
      ),
    )

  
  return rows.map((r) => {
    const unit = Number(r.unitRealPrice)
    const remSess = r.remainingSessions ?? 0
    return {
      saleItemId: r.saleItemId,
      productName: r.productName,
      productType: '疗程卡' as const,
      remainingSessions: remSess,
      remainingQty: null,
      unitRealPrice: r.unitRealPrice,
      deductibleAmount: (unit * remSess).toFixed(2),
    }
  })
  },
)








import { loadRechargeConfig, matchTier, type RechargeTier, type RechargeConfig } from '@/lib/recharge'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { revalidatePath } from 'next/cache'


export interface RechargeCardTier {
  
  faceValue: number
  
  payAmount: number
  
  bonus: number
  
  discount: number
}


export const getRechargeCardTiers = withPermission(
  'sale_order:create',
  async (_session): Promise<RechargeCardTier[]> => {
    const cfg = await loadRechargeConfig()
    return cfg.tiers.map((t: RechargeTier) => {
      const discount = t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1
      return {
        faceValue: t.faceValue,
        payAmount: t.payAmount,
        bonus: Math.round((t.faceValue - t.payAmount) * 100) / 100,
        discount,
      }
    })
  },
)


export const getCustomerCardBalance = withPermission(
  'sale_order:create',
  async (_session, clientUserId: string): Promise<number> => {
    if (!clientUserId) return 0
    const rows = await db
      .select({ balance: prepaidCards.balance })
      .from(prepaidCards)
      .where(eq(prepaidCards.userId, clientUserId))
      .limit(1)
    if (!rows.length) return 0
    const n = Number(rows[0].balance)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
  },
)


export const getRechargeConfig = withPermission(
  'sale_order:create',
  async (_session): Promise<RechargeConfig> => {
    const cfg = await loadRechargeConfig()
    return {
      tiers: cfg.tiers.map((t: RechargeTier) => ({
        faceValue: t.faceValue,
        payAmount: t.payAmount,
      })),
      minAmount: cfg.minAmount,
      maxAmount: cfg.maxAmount,
    }
  },
)


export const createRechargeOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      clientUserId: string
      storeId: string
      faceValue: number
      paymentMethod: '微信' | '支付宝' | '线下'
      remark?: string | null
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string; payAmount?: number }> => {
    if (!data.clientUserId) return { success: false, message: '请选择顾客' }
    if (!data.storeId) return { success: false, message: '请选择入账门店' }
    if (!Number.isFinite(data.faceValue) || data.faceValue <= 0) {
      return { success: false, message: '充值金额无效' }
    }
    if (!['微信', '支付宝', '线下'].includes(data.paymentMethod)) {
      return { success: false, message: '支付方式无效' }
    }
    if (!isInScope(session, data.storeId)) {
      return { success: false, message: '无权在该门店创建充值订单' }
    }

    let payAmount: number
    try {
      const cfg = await loadRechargeConfig()
      const matched = matchTier(data.faceValue, cfg)
      payAmount = matched.payAmount
    } catch (err: any) {
      return { success: false, message: (err?.message || '档位匹配失败').replace(/^[A-Z_]+:\s*/, '') }
    }

    
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        customerType: clientWechatUsers.customerType,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) return { success: false, message: '顾客不存在' }
    const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

    
    const storeRows = (await db.execute(sql`
      SELECT s.store_id, pm.name AS market_name
      FROM stores s
      LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
      LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
      WHERE s.store_id = ${data.storeId}
      LIMIT 1
    `)) as unknown as Array<{ store_id: string; market_name: string | null }>
    if (storeRows.length === 0) return { success: false, message: '入账门店不存在' }
    const marketName = storeRows[0].market_name || ''

    
    const existing = await db
      .select({ saleOrderId: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(and(eq(saleOrders.clientUserId, data.clientUserId), eq(saleOrders.status, '待支付')))
      .limit(1)
    if (existing.length > 0) {
      return {
        success: false,
        message: `该顾客已有待支付订单 ${existing[0].saleOrderId}，请先完成或关闭后再充值`,
      }
    }

    
    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
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
        const id = (idRows as unknown as Array<{ id: string }>)[0]?.id
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '待支付',
          saleOrderType: '充值单',
          documentType,
          marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || '',
          customerName: client.name || '',
          totalAmount: data.faceValue.toFixed(2),
          prepaidCardAmount: '0',
          payableAmount: payAmount.toFixed(2),
          received: '0',
          firstPaymentAmount: null,
          couponId: null,
          couponDiscount: '0',
          paymentMethod: data.paymentMethod,
          openedBy: session.employeeId,
          preferredEmployeeId: null,
          allocationStatus: '待分配',
          remark: data.remark || null,
          paidAt: null,
        })

        return id
      })
    } catch (err: any) {
      const msg = err?.message || '充值订单创建失败'
      return { success: false, message: msg.replace(/^[A-Z_]+:\s*/, '') }
    }

    await logOperation(session, 'sale_order.create_recharge', 'sale_order', saleOrderId, {
      clientUserId: data.clientUserId,
      storeId: data.storeId,
      faceValue: data.faceValue,
      payAmount,
      paymentMethod: data.paymentMethod,
    })

    revalidatePath('/orders')
    revalidatePath(`/customers/${data.clientUserId}`)

    return { success: true, message: '充值订单已创建', saleOrderId, payAmount }
  },
)
