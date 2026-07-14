'use server'

import { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'
import { saleOrders } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql, inArray } from 'drizzle-orm'
import { beijingBoundaryTs } from '@/lib/db-time'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import {
  recomputeCustomerTagsInTx,
  recomputeMemberLevelOnly,
} from '@/lib/recompute-customer-tags'
import {
  searchCustomersByPhone as wfSearchByPhone,
  searchCustomerByCustomerId as wfSearchByCustomerId,
  queryOrdersByCustomerId as wfQueryOrdersByCustomerId,
  type WorkfineCustomer,
  type WorkfineOrder,
} from '@/lib/workfine-mssql'


class LegacyOrderError extends Error {
  readonly digest: string
  constructor(message: string) {
    super(message)
    this.name = 'LegacyOrderError'
    this.digest = message
  }
}

export interface LegacyOrderFilters {
  phone?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  
  matched?: 'matched' | 'unmatched'
  page?: number
  pageSize?: number
}

export interface LegacyOrderRow {
  saleOrderId: string
  storeId: string
  storeName: string | null
  marketName: string
  clientPhone: string | null
  clientUserId: string | null
  clientName: string | null
  customerName: string | null
  saleOrderDatetime: string
  totalAmount: string
  legacyCustomerId: string | null
  legacyRawSnapshot: unknown
  updatedAt: string
  
  hasMiniprogramAccount: boolean
}

export interface PaginatedLegacyOrders {
  data: LegacyOrderRow[]
  total: number
}


export const listLegacyOrders = withPermission(
  'legacy_order:list',
  async (session, filters: LegacyOrderFilters = {}): Promise<PaginatedLegacyOrders> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = [
      eq(saleOrders.legacySource, 'workfine'),
      eq(saleOrders.status, '未审核'),
      scopeCondition(session, saleOrders.storeId),
    ]

    if (filters.phone) {
      const pattern = `%${filters.phone}%`
      conditions.push(
        or(ilike(saleOrders.clientPhone, pattern), ilike(saleOrders.customerName, pattern)),
      )
    }
    if (filters.storeId) {
      conditions.push(eq(saleOrders.storeId, filters.storeId))
    }
    if (filters.dateFrom) {
      
      
      conditions.push(gte(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
    }
    if (filters.dateTo) {
      conditions.push(lt(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateTo, '23:59:59')))
    }
    
    
    if (filters.matched === 'matched') {
      conditions.push(isNotNull(clientWechatUsers.openid))
    }
    if (filters.matched === 'unmatched') {
      conditions.push(isNull(clientWechatUsers.openid))
    }

    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(saleOrders)
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .where(whereClause)
    const total = countRow?.count ?? 0

    const rows = await db
      .select({
        order: saleOrders,
        storeName: stores.storeName,
        clientName: clientWechatUsers.name,
        clientAuthPhone: clientWechatUsers.phone,
        clientOpenid: clientWechatUsers.openid,
      })
      .from(saleOrders)
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .where(whereClause)
      
      .orderBy(desc(saleOrders.saleOrderDatetime))
      .limit(pageSize)
      .offset(offset)

    const data: LegacyOrderRow[] = rows.map((r) => ({
      saleOrderId: r.order.saleOrderId,
      storeId: r.order.storeId,
      storeName: r.storeName ?? null,
      marketName: r.order.marketName,
      
      clientPhone: r.clientAuthPhone || r.order.clientPhone || null,
      clientUserId: r.order.clientUserId,
      clientName: r.clientName ?? null,
      customerName: r.clientName || r.order.customerName || null,
      saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
      totalAmount: r.order.totalAmount,
      legacyCustomerId: r.order.legacyCustomerId,
      legacyRawSnapshot: r.order.legacyRawSnapshot,
      updatedAt: r.order.updatedAt.toISOString(),
      hasMiniprogramAccount: r.clientOpenid !== null,
    }))

    return { data, total }
  },
)


export const approveLegacyOrder = withPermission(
  'legacy_order:approve',
  async (
    session,
    saleOrderId: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; clientUserId: string | null }> => {
    const clientUserId = await db.transaction(async (tx) => {
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET status = '已支付'::order_status,
               received = total_amount,
               paid_at = sale_order_datetime,
               audited_at = NOW(),
               audited_by = ${session.employeeId},
               updated_at = NOW()
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedUpdatedAt}
         RETURNING client_user_id
      `)
      const rows = updRes as unknown as Array<{ client_user_id: string | null }>
      if (rows.length === 0) {
        throw new LegacyOrderError('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }
      const uid = rows[0].client_user_id

      
      
      
      
      await tx.execute(sql`
        INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          status, source_end, operator_employee_id, paid_at, note
        )
        SELECT sale_order_id, '首次支付'::payment_change_type, total_amount, '无'::payment_method,
               '已支付'::payment_flow_status, 'admin'::payment_source_end, ${session.employeeId},
               sale_order_datetime, '历史订单核对通过补登'
          FROM sale_orders
         WHERE sale_order_id = ${saleOrderId} AND total_amount > 0
      `)

      if (uid) {
        await recomputeCustomerTagsInTx(tx, uid)
      }

      await logOperation(session, 'legacy_order.approve', 'sale_order', saleOrderId, {
        _v: 3,
        _t: 'transition',
        from: '未审核',
        to: '已支付',
        clientUserId: uid,
      })
      return uid
    })

    
    if (clientUserId) {
      try {
        await recomputeMemberLevelOnly(clientUserId)
      } catch (err) {
        console.error('[legacy_order.approve] member_level 重算失败（订单审核已完成）', err)
      }
    }

    revalidatePath('/legacy-orders')
    return { success: true, clientUserId }
  },
)


export const rejectLegacyOrder = withPermission(
  'legacy_order:reject',
  async (session, saleOrderId: string, expectedUpdatedAt: string): Promise<{ success: true }> => {
    const updRes = await db.execute(sql`
      UPDATE sale_orders
         SET status = '已作废'::order_status,
             audited_at = NOW(),
             audited_by = ${session.employeeId},
             updated_at = NOW()
       WHERE sale_order_id = ${saleOrderId}
         AND legacy_source = 'workfine'
         AND status = '未审核'
         AND date_trunc('milliseconds', updated_at) = ${expectedUpdatedAt}
    `)
    if (((updRes as { count?: number }).count ?? 0) === 0) {
      throw new LegacyOrderError('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
    }

    await logOperation(session, 'legacy_order.reject', 'sale_order', saleOrderId, {
      _v: 3,
      _t: 'transition',
      from: '未审核',
      to: '已作废',
    })
    revalidatePath('/legacy-orders')
    return { success: true }
  },
)


export const batchApproveLegacyOrders = withPermission(
  'legacy_order:approve',
  async (
    session,
    items: Array<{ saleOrderId: string; expectedUpdatedAt: string }>,
  ): Promise<{ success: true; approvedCount: number; affectedUserIds: string[] }> => {
    if (items.length === 0) return { success: true, approvedCount: 0, affectedUserIds: [] }
    if (items.length > 200) {
      throw new LegacyOrderError('INVALID_PARAMS: 单次批量上限 200 条')
    }

    const affectedUserIds = new Set<string>()

    await db.transaction(async (tx) => {
      for (const it of items) {
        const updRes = await tx.execute(sql`
          UPDATE sale_orders
             SET status = '已支付'::order_status,
                 received = total_amount,
                 paid_at = sale_order_datetime,
                 audited_at = NOW(),
                 audited_by = ${session.employeeId},
                 updated_at = NOW()
           WHERE sale_order_id = ${it.saleOrderId}
             AND legacy_source = 'workfine'
             AND status = '未审核'
             AND date_trunc('milliseconds', updated_at) = ${it.expectedUpdatedAt}
           RETURNING client_user_id
        `)
        const rows = updRes as unknown as Array<{ client_user_id: string | null }>
        if (rows.length === 0) {
          throw new LegacyOrderError(`CONFLICT: 订单 ${it.saleOrderId} 已被审核或状态变更，整批已回滚`)
        }
        if (rows[0].client_user_id) affectedUserIds.add(rows[0].client_user_id)

        
        await tx.execute(sql`
          INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method,
            status, source_end, operator_employee_id, paid_at, note
          )
          SELECT sale_order_id, '首次支付'::payment_change_type, total_amount, '无'::payment_method,
                 '已支付'::payment_flow_status, 'admin'::payment_source_end, ${session.employeeId},
                 sale_order_datetime, '历史订单核对通过补登'
            FROM sale_orders
           WHERE sale_order_id = ${it.saleOrderId} AND total_amount > 0
        `)

        await logOperation(session, 'legacy_order.approve', 'sale_order', it.saleOrderId, {
          _v: 3,
          _t: 'transition',
          from: '未审核',
          to: '已支付',
          batch: true,
          clientUserId: rows[0].client_user_id,
        })
      }

      
      for (const uid of affectedUserIds) {
        await recomputeCustomerTagsInTx(tx, uid)
      }
    })

    
    for (const uid of affectedUserIds) {
      try {
        await recomputeMemberLevelOnly(uid)
      } catch (err) {
        console.error('[legacy_order.batchApprove] member_level 重算失败 user=' + uid, err)
      }
    }

    revalidatePath('/legacy-orders')
    return { success: true, approvedCount: items.length, affectedUserIds: [...affectedUserIds] }
  },
)


export const updateLegacyOrderAmount = withPermission(
  'legacy_order:update_amount',
  async (
    session,
    saleOrderId: string,
    newAmount: number,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; from: string; to: string }> => {
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      throw new LegacyOrderError('INVALID_PARAMS: 金额必须为正数')
    }
    
    if (newAmount > 9999999.99) {
      throw new LegacyOrderError('INVALID_PARAMS: 金额过大')
    }
    const newAmountStr = newAmount.toFixed(2)

    const previousAmount = await db.transaction(async (tx) => {
      
      const oldRes = await tx.execute(sql`
        SELECT total_amount
          FROM sale_orders
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedUpdatedAt}
      `)
      const oldRows = oldRes as unknown as Array<{ total_amount: string }>
      if (oldRows.length === 0) {
        throw new LegacyOrderError('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }
      const prev = oldRows[0].total_amount

      
      
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET total_amount = ${newAmountStr}::numeric,
               payable_amount = ${newAmountStr}::numeric,
               legacy_raw_snapshot = jsonb_set(
                 COALESCE(legacy_raw_snapshot, '{}'::jsonb),
                 '{original_amount}',
                 CASE
                   WHEN legacy_raw_snapshot ? 'original_amount'
                     THEN legacy_raw_snapshot->'original_amount'
                   ELSE to_jsonb(total_amount)
                 END,
                 true
               ),
               updated_at = NOW()
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedUpdatedAt}
      `)
      if (rowsAffected(updRes) === 0) {
        throw new LegacyOrderError('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }
      return prev
    })

    await logOperation(session, 'legacy_order.update_amount', 'sale_order', saleOrderId, {
      _v: 3,
      _t: 'update',
      changes: { totalAmount: { from: previousAmount, to: newAmountStr } },
    })
    revalidatePath('/legacy-orders')
    return { success: true, from: previousAmount, to: newAmountStr }
  },
)


export const updateLegacyOrderPhone = withPermission(
  'legacy_order:update_phone',
  async (
    session,
    saleOrderId: string,
    newPhone: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; matchedUserId: string | null }> => {
    if (!/^1\d{10}$/.test(newPhone)) {
      throw new LegacyOrderError('INVALID_PARAMS: 手机号格式不正确')
    }
    const matchedUserId = await db.transaction(async (tx) => {
      const matchRes = await tx.execute(sql`
        SELECT user_id FROM client_wechat_users WHERE phone = ${newPhone} LIMIT 1
      `)
      const matchRows = matchRes as unknown as Array<{ user_id: string }>
      const uid = matchRows[0]?.user_id ?? null

      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET client_phone = ${newPhone},
               client_user_id = ${uid},
               updated_at = NOW()
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedUpdatedAt}
      `)
      if (rowsAffected(updRes) === 0) {
        throw new LegacyOrderError('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }

      await logOperation(session, 'legacy_order.update_phone', 'sale_order', saleOrderId, {
        _v: 3,
        _t: 'update',
        changes: { clientPhone: { to: newPhone }, clientUserId: { to: uid } },
      })
      return uid
    })

    revalidatePath('/legacy-orders')
    return { success: true, matchedUserId }
  },
)





export interface WorkfineCustomerCandidate extends WorkfineCustomer {
  
  existsInPg: boolean
  
  pgUserId: string | null
}

export interface WorkfineOrderPreview extends WorkfineOrder {
  
  alreadyImported: boolean
  
  storeMatched: boolean
}


export interface AvailableStore {
  storeId: string
  storeName: string
  isClosed: boolean
}


export const searchWorkfineCustomer = withPermission(
  'legacy_order:pull',
  async (
    _session,
    params: { phone?: string; customerId?: string },
  ): Promise<WorkfineCustomerCandidate[]> => {
    const phone = params.phone?.trim()
    const customerId = params.customerId?.trim()
    if (!phone && !customerId) {
      throw new LegacyOrderError('INVALID_PARAMS: 手机号或顾客编号至少传一个')
    }

    try {
      let candidates: WorkfineCustomer[] = []
      if (customerId) {
        const one = await wfSearchByCustomerId(customerId)
        if (one) candidates = [one]
      } else if (phone) {
        candidates = await wfSearchByPhone(phone)
      }

      if (candidates.length === 0) return []

      
      const phones = candidates.map((c) => c.phone).filter((p): p is string => !!p)
      const customerIds = candidates.map((c) => c.customerId)

      const phoneHits = phones.length
        ? await db
            .select({ userId: clientWechatUsers.userId, phone: clientWechatUsers.phone })
            .from(clientWechatUsers)
            .where(inArray(clientWechatUsers.phone, phones))
        : []
      const customerIdHits = customerIds.length
        ? await db
            .select({ userId: clientWechatUsers.userId, customerId: clientWechatUsers.customerId })
            .from(clientWechatUsers)
            .where(inArray(clientWechatUsers.customerId, customerIds))
        : []

      const phoneToUser = new Map(phoneHits.map((r) => [r.phone, r.userId] as const))
      const customerIdToUser = new Map(
        customerIdHits.map((r) => [r.customerId, r.userId] as const),
      )

      return candidates.map((c) => {
        const pgUserId =
          (c.phone && phoneToUser.get(c.phone)) ||
          customerIdToUser.get(c.customerId) ||
          null
        return { ...c, existsInPg: pgUserId !== null, pgUserId }
      })
    } catch (err) {
      
      
      
      console.error(
        `[searchWorkfineCustomer] failed phone=${phone ?? '-'} customerId=${customerId ?? '-'}`,
        err,
      )
      throw err
    }
  },
)


export const previewWorkfineOrders = withPermission(
  'legacy_order:pull',
  async (
    session,
    params: { workfineCustomerId: string },
  ): Promise<{ orders: WorkfineOrderPreview[]; availableStores: AvailableStore[] }> => {
    const customerId = params.workfineCustomerId?.trim()
    if (!customerId) throw new LegacyOrderError('INVALID_PARAMS: workfineCustomerId 必传')

    
    
    const availableStores: AvailableStore[] = await db
      .select({
        storeId: stores.storeId,
        storeName: stores.storeName,
        isClosed: stores.isClosed,
      })
      .from(stores)
      .where(scopeCondition(session, stores.storeId))
      .orderBy(stores.storeName)

    const wfOrders = await wfQueryOrdersByCustomerId(customerId)
    if (wfOrders.length === 0) return { orders: [], availableStores }

    
    const orderNos = wfOrders.map((o) => o.legacyOrderNo)
    const existingRows = await db
      .select({ saleOrderId: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(inArray(saleOrders.saleOrderId, orderNos))
    const existingSet = new Set(existingRows.map((r) => r.saleOrderId))

    
    const storeNames = [...new Set(wfOrders.map((o) => o.storeName).filter((s): s is string => !!s))]
    const storeRows = storeNames.length
      ? await db
          .select({ storeName: stores.storeName })
          .from(stores)
          .where(inArray(stores.storeName, storeNames))
      : []
    const storeSet = new Set(storeRows.map((r) => r.storeName))

    return {
      orders: wfOrders.map((o) => ({
        ...o,
        alreadyImported: existingSet.has(o.legacyOrderNo),
        storeMatched: !!o.storeName && storeSet.has(o.storeName),
      })),
      availableStores,
    }
  },
)


export const importWorkfineOrdersByCustomer = withPermission(
  'legacy_order:pull',
  async (
    session,
    params: {
      workfineCustomerId: string
      selectedOrderNos: string[]
      
      storeMapping?: Record<string, string>
    },
  ): Promise<{
    success: true
    insertedCount: number
    skippedAlreadyExist: number
    skippedNoStore: number
    affectedPhone: string | null
  }> => {
    const customerId = params.workfineCustomerId?.trim()
    if (!customerId) throw new LegacyOrderError('INVALID_PARAMS: workfineCustomerId 必传')
    if (!Array.isArray(params.selectedOrderNos) || params.selectedOrderNos.length === 0) {
      throw new LegacyOrderError('INVALID_PARAMS: selectedOrderNos 至少 1 条')
    }
    if (params.selectedOrderNos.length > 500) {
      throw new LegacyOrderError('INVALID_PARAMS: 单次最多 500 条')
    }

    
    const wfOrders = await wfQueryOrdersByCustomerId(customerId)
    const selectedSet = new Set(params.selectedOrderNos)
    const toImport = wfOrders.filter((o) => selectedSet.has(o.legacyOrderNo))

    if (toImport.length === 0) {
      return {
        success: true,
        insertedCount: 0,
        skippedAlreadyExist: 0,
        skippedNoStore: 0,
        affectedPhone: null,
      }
    }

    
    const storeMapping = params.storeMapping ?? {}
    const mappedStoreIds = [
      ...new Set(Object.values(storeMapping).filter((id): id is string => !!id)),
    ]
    
    for (const id of mappedStoreIds) {
      if (!isInScope(session, id)) {
        throw new LegacyOrderError('PERMISSION_DENIED: legacy_order:pull（门店不在数据权限范围）')
      }
    }
    
    if (mappedStoreIds.length) {
      const existRows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(inArray(stores.storeId, mappedStoreIds))
      const existSet = new Set(existRows.map((r) => r.storeId))
      const missing = mappedStoreIds.filter((id) => !existSet.has(id))
      if (missing.length) {
        throw new LegacyOrderError(`INVALID_PARAMS: 门店不存在：${missing.join(', ')}`)
      }
    }

    
    const phones = [...new Set(toImport.map((o) => o.phone).filter((p): p is string => !!p))]

    const phoneRows = phones.length
      ? await db
          .select({ userId: clientWechatUsers.userId, phone: clientWechatUsers.phone })
          .from(clientWechatUsers)
          .where(inArray(clientWechatUsers.phone, phones))
      : []
    const phoneToUser = new Map(phoneRows.map((r) => [r.phone, r.userId] as const))

    const customerIdRows = await db
      .select({ userId: clientWechatUsers.userId, customerId: clientWechatUsers.customerId })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.customerId, customerId))
    const customerIdToUser = customerIdRows[0]?.userId ?? null

    let skippedNoStore = 0
    let skippedAlreadyExist = 0
    let inserted = 0
    let affectedPhone: string | null = null
    let primaryClientUserId: string | null = null

    await db.transaction(async (tx) => {
      for (const o of toImport) {
        const storeId = o.storeName ? storeMapping[o.storeName] : undefined
        if (!storeId) {
          skippedNoStore++
          continue
        }

        
        const clientUserId =
          (o.phone && phoneToUser.get(o.phone)) || customerIdToUser || null

        if (clientUserId && !primaryClientUserId) primaryClientUserId = clientUserId
        if (o.phone && !affectedPhone) affectedPhone = o.phone

        const marketName = o.marketName || '未知市场'
        const amount = Number.isFinite(o.amount) ? o.amount : 0
        const amountStr = amount.toFixed(2)

        const snapshot = {
          legacy_order_no: o.legacyOrderNo,
          
          
          source_type: o.sourceType,
          phone: o.phone,
          store_name: o.storeName,
          amount,
          sale_date: o.saleDate,
          customer_id: o.legacyCustomerId,
          customer_name: o.customerName,
          
          ...(o.originalOrderNo ? { original_order_no: o.originalOrderNo } : {}),
        }

        const insRes = await tx.execute(sql`
          INSERT INTO sale_orders (
            sale_order_id, status, sale_order_type, market_name, store_id, store_name,
            sale_order_datetime, client_user_id, client_phone, customer_name,
            total_amount, payable_amount, received, payment_method,
            legacy_source, legacy_customer_id, legacy_raw_snapshot
          ) VALUES (
            ${o.legacyOrderNo}, '未审核'::order_status, '销售单'::sale_order_type, ${marketName}, ${storeId}, ${o.storeName},
            ${o.saleDate}::timestamp AT TIME ZONE 'Asia/Shanghai', ${clientUserId}, ${o.phone}, ${o.customerName},
            ${amountStr}::numeric, ${amountStr}::numeric, 0, '无',
            'workfine', ${o.legacyCustomerId}, ${JSON.stringify(snapshot)}::jsonb
          )
          ON CONFLICT (sale_order_id) DO NOTHING
        `)
        const insertedRows = rowsAffected(insRes)
        if (insertedRows === 1) inserted++
        else skippedAlreadyExist++
      }

      await logOperation(
        session,
        'legacy_order.pull',
        'client_user',
        primaryClientUserId ?? customerId,
        {
          _v: 3,
          _t: 'create',
          workfineCustomerId: customerId,
          ordersRequested: params.selectedOrderNos.length,
          ordersFound: toImport.length,
          inserted,
          skippedAlreadyExist,
          skippedNoStore,
          affectedPhone,
        },
      )
    })

    revalidatePath('/legacy-orders')
    return {
      success: true,
      insertedCount: inserted,
      skippedAlreadyExist,
      skippedNoStore,
      affectedPhone,
    }
  },
)
