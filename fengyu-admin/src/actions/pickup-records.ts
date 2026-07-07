'use server'

import { db } from '@/db'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { pickupRecords } from '@db/pickup'
import { saleItems } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { isInScope, scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { hasPendingRefund } from '@/lib/refund-cascade'
import { revalidatePath } from 'next/cache'

export interface AdminPickupRecord {
  id: number
  saleItemId: string
  pickupQuantity: number
  storeId: string
  clientUserId: string | null
  confirmedBy: string
  remark: string | null
  createdAt: string
  // joined
  storeName?: string
  clientName?: string
  clientPhone?: string
  confirmedByName?: string
  /** SKU 完整名称，已包含商品名和规格（如"蜜语水润嫩肤护理 10次卡"） */
  skuName?: string
  saleOrderId?: string
  itemQuantity?: number
  itemPickedUpQuantity?: number
}

export interface PickupRecordFilters {
  storeId?: string
  /** 搜索：saleItemId / 顾客姓名 / 员工姓名 / SKU 名称 */
  search?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

export interface PaginatedPickupRecords {
  data: AdminPickupRecord[]
  total: number
}

/**
 * 服务端分页提货记录列表
 *
 * scope 基于 pickup_records.store_id（提货门店）。
 * JOIN sale_items/stores/client/staff/product/sku 拼接展示信息。
 */
export const getPickupRecordsPaginated = withPermission(
  'pickup_record:list',
  async (
    session,
    filters: PickupRecordFilters = {},
  ): Promise<PaginatedPickupRecords> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, pickupRecords.storeId),
  ]

  if (filters.storeId) {
    conditions.push(eq(pickupRecords.storeId, filters.storeId))
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&')
    const pattern = `%${escaped}%`
    conditions.push(
      or(
        ilike(pickupRecords.saleItemId, pattern),
        ilike(clientWechatUsers.name, pattern),
        ilike(staffWechatUsers.name, pattern),
        ilike(productSkus.specName, pattern),
      ),
    )
  }
  if (filters.dateFrom) {
    // 日期串拼北京字面 timestamp（created_at 库存北京字面）；不经 new Date（date-only 串 UTC 午夜解析→+8h）。
    conditions.push(gte(pickupRecords.createdAt, sql`${`${filters.dateFrom} 00:00:00`}::timestamp AT TIME ZONE 'Asia/Shanghai'`))
  }
  if (filters.dateTo) {
    conditions.push(lte(pickupRecords.createdAt, sql`${`${filters.dateTo} 23:59:59`}::timestamp AT TIME ZONE 'Asia/Shanghai'`))
  }

  const whereClause = and(...conditions)

  // COUNT 查询（同样需要 JOIN，因为 search 命中了被 JOIN 的列）
  const countQuery = db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(pickupRecords)
    .leftJoin(clientWechatUsers, eq(pickupRecords.clientUserId, clientWechatUsers.userId))
    .leftJoin(staffWechatUsers, eq(pickupRecords.confirmedBy, staffWechatUsers.employeeId))
    .leftJoin(saleItems, eq(pickupRecords.saleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(whereClause)

  // 数据查询（多一个 stores JOIN 用于展示门店名）
  const dataQuery = db
    .select({
      record: pickupRecords,
      storeName: stores.storeName,
      clientName: clientWechatUsers.name,
      clientPhone: clientWechatUsers.phone,
      confirmedByName: staffWechatUsers.name,
      skuName: productSkus.specName,
      saleOrderId: saleItems.saleOrderId,
      itemQuantity: saleItems.quantity,
      itemPickedUpQuantity: saleItems.pickedUpQuantity,
    })
    .from(pickupRecords)
    .leftJoin(stores, eq(pickupRecords.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(pickupRecords.clientUserId, clientWechatUsers.userId))
    .leftJoin(staffWechatUsers, eq(pickupRecords.confirmedBy, staffWechatUsers.employeeId))
    .leftJoin(saleItems, eq(pickupRecords.saleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(whereClause)
    // 例外：提货流水型表无 updatedAt 列
    .orderBy(desc(pickupRecords.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [[countRow], rows] = await Promise.all([countQuery, dataQuery])

  return {
    data: rows.map((r) => ({
      id: r.record.id,
      saleItemId: r.record.saleItemId,
      pickupQuantity: r.record.pickupQuantity,
      storeId: r.record.storeId,
      clientUserId: r.record.clientUserId,
      confirmedBy: r.record.confirmedBy,
      remark: r.record.remark,
      createdAt: r.record.createdAt.toISOString(),
      storeName: r.storeName ?? undefined,
      clientName: r.clientName ?? undefined,
      clientPhone: r.clientPhone ?? undefined,
      confirmedByName: r.confirmedByName ?? undefined,
      skuName: r.skuName ?? undefined,
      saleOrderId: r.saleOrderId ?? undefined,
      itemQuantity: r.itemQuantity ?? undefined,
      itemPickedUpQuantity: r.itemPickedUpQuantity ?? undefined,
    })),
    total: countRow?.count ?? 0,
  }
  },
)

/**
 * 提货记录详情（单条）
 */
export const getPickupRecordById = withPermission(
  'pickup_record:list',
  async (
    session,
    id: number,
  ): Promise<AdminPickupRecord | null> => {
  const rows = await db
    .select({
      record: pickupRecords,
      storeName: stores.storeName,
      clientName: clientWechatUsers.name,
      clientPhone: clientWechatUsers.phone,
      confirmedByName: staffWechatUsers.name,
      skuName: productSkus.specName,
      saleOrderId: saleItems.saleOrderId,
      itemQuantity: saleItems.quantity,
      itemPickedUpQuantity: saleItems.pickedUpQuantity,
    })
    .from(pickupRecords)
    .leftJoin(stores, eq(pickupRecords.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(pickupRecords.clientUserId, clientWechatUsers.userId))
    .leftJoin(staffWechatUsers, eq(pickupRecords.confirmedBy, staffWechatUsers.employeeId))
    .leftJoin(saleItems, eq(pickupRecords.saleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(
      and(eq(pickupRecords.id, id), scopeCondition(session, pickupRecords.storeId)),
    )
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]
  return {
    id: r.record.id,
    saleItemId: r.record.saleItemId,
    pickupQuantity: r.record.pickupQuantity,
    storeId: r.record.storeId,
    clientUserId: r.record.clientUserId,
    confirmedBy: r.record.confirmedBy,
    remark: r.record.remark,
    createdAt: r.record.createdAt.toISOString(),
    storeName: r.storeName ?? undefined,
    clientName: r.clientName ?? undefined,
    clientPhone: r.clientPhone ?? undefined,
    confirmedByName: r.confirmedByName ?? undefined,
    skuName: r.skuName ?? undefined,
    saleOrderId: r.saleOrderId ?? undefined,
    itemQuantity: r.itemQuantity ?? undefined,
    itemPickedUpQuantity: r.itemPickedUpQuantity ?? undefined,
  }
  },
)

/**
 * 顾客可提货的家居产品销售明细
 *
 * 筛选条件：
 * - 订单已支付
 * - item_direction = '购买'
 * - product_type = '家居产品'
 * - 可提数量 = quantity - COALESCE(picked_up_quantity, 0) > 0
 */
export interface AvailablePickupItem {
  saleItemId: string
  saleOrderId: string
  productName: string | null
  quantity: number
  pickedUpQuantity: number
  remaining: number
  unitRealPrice: string
  storeId: string
  storeName: string | null
}

export const getAvailablePickupItems = withPermission(
  'pickup_record:create',
  async (
    _session,
    clientUserId: string,
  ): Promise<AvailablePickupItem[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      si.product_name,
      si.quantity,
      COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity,
      si.unit_real_price,
      o.store_id,
      s.store_name
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN stores s ON s.store_id = o.store_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status = '已支付'
      AND si.item_direction = '购买'
      AND si.product_type = '家居产品'
      AND si.quantity > COALESCE(si.picked_up_quantity, 0)
    ORDER BY o.paid_at DESC, si.sale_item_id
  `)

  // 不按原订单门店过滤：提货店可能与原销售店不同（顾客跨店提货），
  // scope 约束在 createPickupRecord 对"实际提货门店"生效。
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    saleItemId: r.sale_item_id as string,
    saleOrderId: r.sale_order_id as string,
    productName: (r.product_name as string | null) ?? null,
    quantity: Number(r.quantity),
    pickedUpQuantity: Number(r.picked_up_quantity ?? 0),
    remaining: Number(r.quantity) - Number(r.picked_up_quantity ?? 0),
    unitRealPrice: (r.unit_real_price as string) ?? '0',
    storeId: r.store_id as string,
    storeName: (r.store_name as string | null) ?? null,
  }))
  },
)

/**
 * 创建提货记录
 *
 * 事务内原子累加 sale_items.picked_up_quantity 并插入 pickup_records。
 * 使用 UPDATE ... WHERE 中的条件保证并发安全：
 *   (COALESCE(picked_up_quantity, 0) + $1) <= quantity
 * 若超出可提数量，UPDATE 返回 0 行，事务回滚。
 */
export const createPickupRecord = withPermission(
  'pickup_record:create',
  async (
    session,
    data: {
      saleItemId: string
      pickupQuantity: number
      storeId: string
      clientUserId: string | null
      remark?: string | null
      idempotencyKey?: string | null
    },
  ): Promise<{ success: boolean; message: string; createdId?: number }> => {
  // 基础参数校验
  if (!data.saleItemId) {
    return { success: false, message: '缺少销售明细号' }
  }
  if (!Number.isInteger(data.pickupQuantity) || data.pickupQuantity <= 0) {
    return { success: false, message: '提货数量必须为正整数' }
  }
  if (!data.storeId) {
    return { success: false, message: '缺少提货门店' }
  }
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建提货记录' }
  }

  // 冻结闭环（Bug I）：该明细所属订单有待审批退款时禁止提货（与 staff createPickup 对齐；
  // 退款 cascade 通道5 会回滚 picked_up_quantity，待审批期提货会被随后 approve 静默回滚 → 提货账漂移）
  const ordRows = (await db.execute(sql`
    SELECT sale_order_id FROM sale_items WHERE sale_item_id = ${data.saleItemId} LIMIT 1
  `)) as unknown as Array<{ sale_order_id: string }>
  if (ordRows.length > 0 && (await hasPendingRefund(db, ordRows[0].sale_order_id))) {
    return { success: false, message: '该订单退款审批中，暂不可提货' }
  }

  // 幂等前置：若传 idempotencyKey 且已存在对应行，直接返回当前 ID（不再 UPDATE/INSERT）
  // 配合 DB 层 uq_pickup_idempotency 兜底 sub-ms 并发
  const idemKey = data.idempotencyKey?.trim() || null
  if (idemKey) {
    const existing = (await db.execute(sql`
      SELECT id FROM pickup_records
       WHERE sale_item_id = ${data.saleItemId} AND idempotency_key = ${idemKey}
       LIMIT 1
    `)) as unknown as Array<{ id: number }>
    if (existing.length > 0) {
      return { success: true, message: '提货记录已存在（幂等）', createdId: existing[0].id }
    }
  }

  try {
    const createdId = await db.transaction(async (tx) => {
      // 1. 原子累加 picked_up_quantity，仅家居产品，超量会被 WHERE 拦截
      const updated = await tx.execute(sql`
        UPDATE sale_items
           SET picked_up_quantity = COALESCE(picked_up_quantity, 0) + ${data.pickupQuantity},
               updated_at = NOW()
         WHERE sale_item_id = ${data.saleItemId}
           AND product_type = '家居产品'
           AND item_direction = '购买'
           AND (COALESCE(picked_up_quantity, 0) + ${data.pickupQuantity}) <= quantity
        RETURNING sale_item_id, quantity, picked_up_quantity
      `)
      const updatedRows = updated as unknown as Array<{
        sale_item_id: string
        quantity: number
        picked_up_quantity: number
      }>
      if (updatedRows.length === 0) {
        throw new ApiError('INVALID_STATE', '销售明细不存在、非家居产品或超出可提数量')
      }

      // 2. 插入 pickup_records；DB 层 uq_pickup_idempotency 兜底 race，命中即整事务回滚防 UPDATE 重复累加
      try {
        const inserted = await tx
          .insert(pickupRecords)
          .values({
            saleItemId: data.saleItemId,
            pickupQuantity: data.pickupQuantity,
            storeId: data.storeId,
            clientUserId: data.clientUserId,
            confirmedBy: session.employeeId,
            remark: data.remark?.trim() || null,
            idempotencyKey: idemKey,
          })
          .returning({ id: pickupRecords.id })

        return inserted[0]?.id ?? 0
      } catch (err: unknown) {
        if (pgErrorCode(err) === '23505' && pgErrorConstraint(err) === 'uq_pickup_idempotency') {
          throw new ApiError('CONFLICT', '提货请求重复，请勿重复提交')
        }
        throw err
      }
    })

    await logOperation(session, 'create', 'pickup_record', String(createdId), {
      saleItemId: data.saleItemId,
      pickupQuantity: data.pickupQuantity,
      storeId: data.storeId,
      clientUserId: data.clientUserId,
    })

    return { success: true, message: '提货记录创建成功', createdId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '创建失败'
    if (msg.startsWith('OVER_QUANTITY:')) {
      return { success: false, message: msg.slice('OVER_QUANTITY:'.length).trim() }
    }
    if (msg.startsWith('PERMISSION_DENIED:')) {
      throw err
    }
    return { success: false, message: msg }
  }
  },
)

/**
 * 物理删除提货记录（仅系统管理员；数据治理用）。
 *
 * 关键：提货记录创建时原子累加了 sale_items.picked_up_quantity，
 * 删除必须在同事务内回退该计数（GREATEST 防越界为负），否则"可提数量"虚低。
 * pickup_records 无任何 inbound FK，无级联。
 */
export const deletePickupRecord = withPermission(
  'pickup_record:delete',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
    const [rec] = await db
      .select({
        saleItemId: pickupRecords.saleItemId,
        pickupQuantity: pickupRecords.pickupQuantity,
        storeId: pickupRecords.storeId,
        clientUserId: pickupRecords.clientUserId,
        confirmedBy: pickupRecords.confirmedBy,
      })
      .from(pickupRecords)
      .where(and(eq(pickupRecords.id, id), scopeCondition(session, pickupRecords.storeId)))
      .limit(1)

    if (!rec) {
      return { success: false, message: '提货记录不存在或无权操作' }
    }

    try {
      const ok = await db.transaction(async (tx) => {
        const result = await tx
          .delete(pickupRecords)
          .where(and(eq(pickupRecords.id, id), scopeCondition(session, pickupRecords.storeId)))
        if ((result as any).count === 0) {
          throw new Error('PICKUP_ROW_GONE')
        }
        // 回退已提数量（不低于 0）
        await tx.execute(sql`
          UPDATE sale_items
             SET picked_up_quantity = GREATEST(COALESCE(picked_up_quantity, 0) - ${rec.pickupQuantity}, 0),
                 updated_at = NOW()
           WHERE sale_item_id = ${rec.saleItemId}
        `)
        return true
      })
      if (!ok) {
        return { success: false, message: '提货记录已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'PICKUP_ROW_GONE') {
        return { success: false, message: '提货记录已变更，请刷新重试' }
      }
      throw e
    }

    await logOperation(session, 'pickup_record.delete', 'pickup_record', String(id), {
      snapshot: {
        saleItemId: rec.saleItemId,
        pickupQuantity: rec.pickupQuantity,
        storeId: rec.storeId,
        clientUserId: rec.clientUserId,
        confirmedBy: rec.confirmedBy,
      },
    })

    revalidatePath('/pickup-records')
    return { success: true, message: '提货记录已删除' }
  },
)
