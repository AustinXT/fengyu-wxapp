'use server'

import { db } from '@/db'
import { saleOrders } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql, inArray } from 'drizzle-orm'
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

export interface LegacyOrderFilters {
  phone?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  /**
   * 'matched' = 该 phone 已在 client_wechat_users 中且 openid IS NOT NULL（真·小程序注册顾客）；
   * 'unmatched' = 未注册小程序（client_user_id 为空，或关联到 WorkFine 同步的 openid IS NULL 幽灵行）；
   * undefined = 不过滤
   */
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
  /** true = 该顾客已用此手机号注册小程序（client_wechat_users.openid IS NOT NULL） */
  hasMiniprogramAccount: boolean
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
    // 小程序匹配语义：client_wechat_users.openid IS NOT NULL 才算真·小程序注册顾客
    // （WorkFine 同步的幽灵顾客 openid 为 null，不算）
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
        clientOpenid: clientWechatUsers.openid,
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
      hasMiniprogramAccount: r.clientOpenid !== null,
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
 * 改金额：WorkFine 历史订单金额错误时核对前先修正。
 *
 * - CAS 守卫（updated_at）
 * - 同步更新 total_amount + payable_amount（导入时两者相等）
 * - 在 legacy_raw_snapshot.original_amount 留底（仅首次修改时写入；后续改不覆盖，保留最早值）
 * - **不**触发标签重算 — approve 时统一重算
 */
export const updateLegacyOrderAmount = withPermission(
  'legacy_order:update_amount',
  async (
    session,
    saleOrderId: string,
    newAmount: number,
    expectedUpdatedAt: string,
  ): Promise<{ success: true; from: string; to: string }> => {
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      throw new Error('INVALID_PARAMS: 金额必须为正数')
    }
    // 限制小数位数 + 上限，防错填
    if (newAmount > 9999999.99) {
      throw new Error('INVALID_PARAMS: 金额过大')
    }
    const newAmountStr = newAmount.toFixed(2)
    const expectedDate = new Date(expectedUpdatedAt)

    const previousAmount = await db.transaction(async (tx) => {
      // 读旧值（用作精确 from / to 审计；与 CAS 同条件，确保读到的就是即将被更新的行）
      const oldRes = await tx.execute(sql`
        SELECT total_amount
          FROM sale_orders
         WHERE sale_order_id = ${saleOrderId}
           AND legacy_source = 'workfine'
           AND status = '未审核'
           AND date_trunc('milliseconds', updated_at) = ${expectedDate}
      `)
      const oldRows = oldRes as unknown as Array<{ total_amount: string }>
      if (oldRows.length === 0) {
        throw new Error('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
      }
      const prev = oldRows[0].total_amount

      // legacy_raw_snapshot.original_amount: 首次修改时写入当前 total_amount（最早值）；
      // 后续修改保留早先 original_amount 不覆盖。
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
           AND date_trunc('milliseconds', updated_at) = ${expectedDate}
      `)
      if (((updRes as { rowCount?: number }).rowCount ?? 0) === 0) {
        throw new Error('CONFLICT: 订单已被审核或状态已变更，请刷新后重试')
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

// ============================================================================
// Manual pull workflow（admin /legacy-orders + /customers/[id] 顾客详情页入口）
// ============================================================================

export interface WorkfineCustomerCandidate extends WorkfineCustomer {
  /** 该 phone 或 customer_id 是否已在 PG client_wechat_users 中存在 */
  existsInPg: boolean
  /** 关联的 PG user_id（如果存在） */
  pgUserId: string | null
}

export interface WorkfineOrderPreview extends WorkfineOrder {
  /** 该 legacy_order_no 是否已在 PG sale_orders 中（无论状态） */
  alreadyImported: boolean
  /** 该 store_name 是否存在同名新系统门店（仅用于前端下拉默认值，不再作为勾选硬门槛） */
  storeMatched: boolean
}

/** 可映射的新系统门店（按操作员 scope 过滤） */
export interface AvailableStore {
  storeId: string
  storeName: string
  isClosed: boolean
}

/**
 * Step 1: 按手机号或 WorkFine 顾客编号搜索候选顾客
 * 至少传入 phone 或 customerId 之一
 */
export const searchWorkfineCustomer = withPermission(
  'legacy_order:pull',
  async (
    _session,
    params: { phone?: string; customerId?: string },
  ): Promise<WorkfineCustomerCandidate[]> => {
    const phone = params.phone?.trim()
    const customerId = params.customerId?.trim()
    if (!phone && !customerId) {
      throw new Error('INVALID_PARAMS: 手机号或顾客编号至少传一个')
    }

    let candidates: WorkfineCustomer[] = []
    if (customerId) {
      const one = await wfSearchByCustomerId(customerId)
      if (one) candidates = [one]
    } else if (phone) {
      candidates = await wfSearchByPhone(phone)
    }

    if (candidates.length === 0) return []

    // 标记 PG 命中：phone 或 customer_id 任一匹配即算
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
  },
)

/**
 * Step 2: 预览某 WorkFine 顾客的全部订单 + 标记 PG 状态
 */
export const previewWorkfineOrders = withPermission(
  'legacy_order:pull',
  async (
    session,
    params: { workfineCustomerId: string },
  ): Promise<{ orders: WorkfineOrderPreview[]; availableStores: AvailableStore[] }> => {
    const customerId = params.workfineCustomerId?.trim()
    if (!customerId) throw new Error('INVALID_PARAMS: workfineCustomerId 必传')

    // 可映射门店：按操作员 scope 过滤（admin 全部，manager 仅 scope 内）。
    // 闭店门店仍列出（历史单可能归属现已闭店门店），前端标注但不禁用。
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

    // 标记 alreadyImported（按 sale_order_id 命中）
    const orderNos = wfOrders.map((o) => o.legacyOrderNo)
    const existingRows = await db
      .select({ saleOrderId: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(inArray(saleOrders.saleOrderId, orderNos))
    const existingSet = new Set(existingRows.map((r) => r.saleOrderId))

    // 标记 storeMatched（按 store_name 反查 stores）
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

/**
 * Step 3: 把选中的 WorkFine 订单导入 PG（status='未审核'）
 *
 * 设计要点：
 * - 用 ON CONFLICT DO NOTHING 保证幂等
 * - 单顾客粒度（N 通常 < 100），lookup map 当场建
 * - storeMapping（WorkFine 门店名 → 新系统 storeId）由操作员在预览弹窗人工指派，
 *   默认同名匹配；未配映射或映射为空的行直接 skip 并计入 skippedNoStore
 * - 不触发标签重算（标签重算只在 approve 时跑，本 action 仅落库 unreviewed 行）
 */
export const importWorkfineOrdersByCustomer = withPermission(
  'legacy_order:pull',
  async (
    session,
    params: {
      workfineCustomerId: string
      selectedOrderNos: string[]
      /** WorkFine 门店名 → 新系统 storeId；缺失/空值的门店名对应订单会被跳过 */
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
    if (!customerId) throw new Error('INVALID_PARAMS: workfineCustomerId 必传')
    if (!Array.isArray(params.selectedOrderNos) || params.selectedOrderNos.length === 0) {
      throw new Error('INVALID_PARAMS: selectedOrderNos 至少 1 条')
    }
    if (params.selectedOrderNos.length > 500) {
      throw new Error('INVALID_PARAMS: 单次最多 500 条')
    }

    // 重新从 WorkFine 拉取以拿到最新数据（不信任前端传的预览快照）
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

    // 门店映射（WorkFine 门店名 → 新系统 storeId），人工指派，过滤空值
    const storeMapping = params.storeMapping ?? {}
    const mappedStoreIds = [
      ...new Set(Object.values(storeMapping).filter((id): id is string => !!id)),
    ]
    // 越权校验：每个被指派的 storeId 必须在操作员 scope 内（防伪造 request 绕过 UI 限制）
    for (const id of mappedStoreIds) {
      if (!isInScope(session, id)) {
        throw new Error('PERMISSION_DENIED: legacy_order:pull（门店不在数据权限范围）')
      }
    }
    // 存在性校验：被指派的 storeId 必须真实存在
    if (mappedStoreIds.length) {
      const existRows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(inArray(stores.storeId, mappedStoreIds))
      const existSet = new Set(existRows.map((r) => r.storeId))
      const missing = mappedStoreIds.filter((id) => !existSet.has(id))
      if (missing.length) {
        throw new Error(`INVALID_PARAMS: 门店不存在：${missing.join(', ')}`)
      }
    }

    // 建 lookup（单顾客粒度，几个唯一手机号）
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

        // 选 client_user_id：优先 phone，其次 WorkFine customer_id
        const clientUserId =
          (o.phone && phoneToUser.get(o.phone)) || customerIdToUser || null

        if (clientUserId && !primaryClientUserId) primaryClientUserId = clientUserId
        if (o.phone && !affectedPhone) affectedPhone = o.phone

        const marketName = o.marketName || '未知市场'
        const amount = Number.isFinite(o.amount) ? o.amount : 0
        const amountStr = amount.toFixed(2)

        const snapshot = {
          legacy_order_no: o.legacyOrderNo,
          phone: o.phone,
          store_name: o.storeName,
          amount,
          sale_date: o.saleDate,
          customer_id: o.legacyCustomerId,
          customer_name: o.customerName,
        }

        const insRes = await tx.execute(sql`
          INSERT INTO sale_orders (
            sale_order_id, status, sale_order_type, market_name, store_id,
            sale_order_datetime, client_user_id, client_phone, customer_name,
            total_amount, payable_amount, received, payment_method,
            legacy_source, legacy_customer_id, legacy_raw_snapshot
          ) VALUES (
            ${o.legacyOrderNo}, '未审核'::order_status, '销售单'::sale_order_type, ${marketName}, ${storeId},
            ${o.saleDate}::timestamp, ${clientUserId}, ${o.phone}, ${o.customerName},
            ${amountStr}::numeric, ${amountStr}::numeric, 0, '无',
            'workfine', ${o.legacyCustomerId}, ${JSON.stringify(snapshot)}::jsonb
          )
          ON CONFLICT (sale_order_id) DO NOTHING
        `)
        const rowCount = (insRes as { rowCount?: number }).rowCount ?? 0
        if (rowCount === 1) inserted++
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
