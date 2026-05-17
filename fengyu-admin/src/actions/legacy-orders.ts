'use server'

import { db } from '@/db'
import { saleOrders } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import {
  recomputeCustomerTagsInTx,
  recomputeMemberLevelOnly,
} from '@/lib/recompute-customer-tags'

export interface LegacyOrderFilters {
  phone?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  /** 'matched' = client_user_id IS NOT NULL；'unmatched' = NULL；undefined = 不过滤 */
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
}

export interface PaginatedLegacyOrders {
  data: LegacyOrderRow[]
  total: number
}

/**
 * 列出未审核的历史订单（admin /legacy-orders 主入口）
 */
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
      conditions.push(gte(saleOrders.saleOrderDatetime, new Date(filters.dateFrom)))
    }
    if (filters.dateTo) {
      conditions.push(lt(saleOrders.saleOrderDatetime, new Date(filters.dateTo + 'T23:59:59.999')))
    }
    if (filters.matched === 'matched') {
      conditions.push(isNotNull(saleOrders.clientUserId))
    }
    if (filters.matched === 'unmatched') {
      conditions.push(isNull(saleOrders.clientUserId))
    }

    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(saleOrders)
      .where(whereClause)
    const total = countRow?.count ?? 0

    const rows = await db
      .select({
        order: saleOrders,
        storeName: stores.storeName,
        clientName: clientWechatUsers.name,
      })
      .from(saleOrders)
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .where(whereClause)
      // 例外：业务时间优先（历史订单按销售日期倒序，与"最近编辑浮顶"语义不符）
      .orderBy(desc(saleOrders.saleOrderDatetime))
      .limit(pageSize)
      .offset(offset)

    const data: LegacyOrderRow[] = rows.map((r) => ({
      saleOrderId: r.order.saleOrderId,
      storeId: r.order.storeId,
      storeName: r.storeName ?? null,
      marketName: r.order.marketName,
      clientPhone: r.order.clientPhone,
      clientUserId: r.order.clientUserId,
      clientName: r.clientName ?? null,
      customerName: r.order.customerName,
      saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
      totalAmount: r.order.totalAmount,
      legacyCustomerId: r.order.legacyCustomerId,
      legacyRawSnapshot: r.order.legacyRawSnapshot,
      updatedAt: r.order.updatedAt.toISOString(),
    }))

    return { data, total }
  },
)

/**
 * 核对通过：status → '已支付' + audited_at/by + 触发单顾客标签重算
 *
 * CAS 守卫：WHERE updated_at = expectedUpdatedAt；rowCount=0 → CONFLICT
 */
export const approveLegacyOrder = withPermission(
  'legacy_order:approve',
  async (
    session,
    saleOrderId: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; clientUserId: string | null }> => {
    const expectedDate = new Date(expectedUpdatedAt)

    const clientUserId = await db.transaction(async (tx) => {
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET status = '已支付'::order_status,
               audited_at = NOW(),
               audited_by = ${session.employeeId},
               updated_at = NOW()
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedDate}
         RETURNING client_user_id
      `)
      const rows = updRes as unknown as Array<{ client_user_id: string | null }>
      if (rows.length === 0) {
        throw new Error('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }
      const uid = rows[0].client_user_id

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

    // member_level 重算必须在事务外（processUpgrade/processDowngrade 含独立事务）
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

/**
 * 核对作废：status → '已作废' + audited_at/by
 */
export const rejectLegacyOrder = withPermission(
  'legacy_order:reject',
  async (session, saleOrderId: string, expectedUpdatedAt: string): Promise<{ success: true }> => {
    const expectedDate = new Date(expectedUpdatedAt)
    const updRes = await db.execute(sql`
      UPDATE sale_orders
         SET status = '已作废'::order_status,
             audited_at = NOW(),
             audited_by = ${session.employeeId},
             updated_at = NOW()
       WHERE sale_order_id = ${saleOrderId}
         AND legacy_source = 'workfine'
         AND status = '未审核'
         AND date_trunc('milliseconds', updated_at) = ${expectedDate}
    `)
    if (((updRes as { rowCount?: number }).rowCount ?? 0) === 0) {
      throw new Error('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
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

/**
 * 批量通过：事务内逐条 UPDATE，全部成功才提交。
 * member_level 重算逐顾客在事务外串行（避免长事务持锁过久）。
 */
export const batchApproveLegacyOrders = withPermission(
  'legacy_order:approve',
  async (
    session,
    items: Array<{ saleOrderId: string; expectedUpdatedAt: string }>,
  ): Promise<{ success: true; approvedCount: number; affectedUserIds: string[] }> => {
    if (items.length === 0) return { success: true, approvedCount: 0, affectedUserIds: [] }
    if (items.length > 200) {
      throw new Error('INVALID_PARAMS: 单次批量上限 200 条')
    }

    const affectedUserIds = new Set<string>()

    await db.transaction(async (tx) => {
      for (const it of items) {
        const expectedDate = new Date(it.expectedUpdatedAt)
        const updRes = await tx.execute(sql`
          UPDATE sale_orders
             SET status = '已支付'::order_status,
                 audited_at = NOW(),
                 audited_by = ${session.employeeId},
                 updated_at = NOW()
           WHERE sale_order_id = ${it.saleOrderId}
             AND legacy_source = 'workfine'
             AND status = '未审核'
             AND date_trunc('milliseconds', updated_at) = ${expectedDate}
           RETURNING client_user_id
        `)
        const rows = updRes as unknown as Array<{ client_user_id: string | null }>
        if (rows.length === 0) {
          throw new Error(`CONFLICT: 订单 ${it.saleOrderId} 已被审核或状态变更，整批已回滚`)
        }
        if (rows[0].client_user_id) affectedUserIds.add(rows[0].client_user_id)

        await logOperation(session, 'legacy_order.approve', 'sale_order', it.saleOrderId, {
          _v: 3,
          _t: 'transition',
          from: '未审核',
          to: '已支付',
          batch: true,
          clientUserId: rows[0].client_user_id,
        })
      }

      // 事务内只跑 customer_status / type / tier 重算（不调 processUpgrade，避免嵌套事务）
      for (const uid of affectedUserIds) {
        await recomputeCustomerTagsInTx(tx, uid)
      }
    })

    // 事务外重算 member_level
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

/**
 * 改手机号：WorkFine 上手机号错填场景，修正后自动尝试重新匹配 client_user_id
 */
export const updateLegacyOrderPhone = withPermission(
  'legacy_order:update_phone',
  async (
    session,
    saleOrderId: string,
    newPhone: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; matchedUserId: string | null }> => {
    if (!/^1\d{10}$/.test(newPhone)) {
      throw new Error('INVALID_PARAMS: 手机号格式不正确')
    }
    const expectedDate = new Date(expectedUpdatedAt)

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
           AND date_trunc('milliseconds', updated_at) = ${expectedDate}
      `)
      if (((updRes as { rowCount?: number }).rowCount ?? 0) === 0) {
        throw new Error('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
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
