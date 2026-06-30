'use server'

import { db } from '@/db'
import {
  inventoryTransferOrders,
  inventoryTransferOrderItems,
} from '@db/inventory'
import { stores } from '@db/org'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { nowTs } from '@/lib/db-time'
import { generateInventoryDocNo } from './doc-no'
import type {
  InventoryItemDto,
  InventoryListFilters,
  InventoryOrderRow,
  InventoryTransferSubtype,
  PaginatedInventoryOrders,
} from './types'

export interface TransferOrderDetail extends InventoryOrderRow {
  docSubtype: InventoryTransferSubtype
  counterpartStoreId: string
  counterpartStoreName: string | null
  isDispatcher: boolean
  receiveQuantity: number | null
  items: TransferItemRow[]
}

export interface TransferItemRow extends InventoryItemDto {
  id: number
  orderId: string
  createdAt: string
}

export interface TransferCreateInput {
  docSubtype: InventoryTransferSubtype
  storeId: string
  counterpartStoreId: string
  docDate: string
  status?: '草稿' | '已完成'
  remark?: string | null
  items: InventoryItemDto[]
}

export interface TransferUpdateInput {
  id: string
  docSubtype?: InventoryTransferSubtype
  docDate?: string
  status?: '草稿' | '已完成' | '已取消'
  counterpartStoreId?: string
  remark?: string | null
  items?: InventoryItemDto[]
}

function sumQty(items: InventoryItemDto[]): number {
  return items.reduce((acc, it) => acc + Number(it.quantity || 0), 0)
}

export const listTransferOrders = withPermission(
  'inventory:list',
  async (
    session,
    filters: InventoryListFilters = {},
  ): Promise<PaginatedInventoryOrders> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    // 调拨需要 OR 过滤：本门店是发起方 OR 本门店是接收方
    const scopeIds = session.permissions.scopeStoreIds
    const isAdminLike = session.roles.some((r) => r.role === 'admin')
    const conditions: (SQL | undefined)[] = []
    if (!isAdminLike) {
      if (scopeIds.length === 0) {
        conditions.push(sql`FALSE`)
      } else {
        conditions.push(
          or(
            sql`${inventoryTransferOrders.storeId} IN (${sql.join(
              scopeIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`${inventoryTransferOrders.counterpartStoreId} IN (${sql.join(
              scopeIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
      }
    }
    if (filters.storeId) {
      conditions.push(
        or(
          eq(inventoryTransferOrders.storeId, filters.storeId),
          eq(inventoryTransferOrders.counterpartStoreId, filters.storeId),
        ),
      )
    }
    if (filters.docSubtype) {
      conditions.push(
        eq(inventoryTransferOrders.docSubtype, filters.docSubtype as InventoryTransferSubtype),
      )
    }
    if (filters.status) conditions.push(eq(inventoryTransferOrders.status, filters.status))
    if (filters.startDate) conditions.push(gte(inventoryTransferOrders.docDate, filters.startDate))
    if (filters.endDate) conditions.push(lte(inventoryTransferOrders.docDate, filters.endDate))
    if (filters.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&')
      const pattern = `%${escaped}%`
      conditions.push(
        or(
          ilike(inventoryTransferOrders.id, pattern),
          ilike(inventoryTransferOrders.remark, pattern),
        ),
      )
    }
    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryTransferOrders)
      .where(whereClause)

    const rows = await db
      .select({
        order: inventoryTransferOrders,
        storeName: stores.storeName,
        counterpartStoreName: sql<string | null>`(SELECT store_name FROM stores WHERE store_id = ${inventoryTransferOrders.counterpartStoreId})`,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryTransferOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryTransferOrders.confirmedBy})`,
      })
      .from(inventoryTransferOrders)
      .leftJoin(stores, eq(inventoryTransferOrders.storeId, stores.storeId))
      .where(whereClause)
      .orderBy(desc(inventoryTransferOrders.docDate), desc(inventoryTransferOrders.createdAt))
      .limit(pageSize)
      .offset(offset)

    return {
      data: rows.map(({ order: o, storeName, counterpartStoreName, createdByName, confirmedByName }) => ({
        id: o.id,
        docSubtype: o.docSubtype,
        status: o.status,
        storeId: o.storeId,
        storeName,
        docDate: o.docDate,
        totalQuantity: o.totalQuantity == null ? null : Number(o.totalQuantity),
        createdBy: o.createdBy,
        createdByName,
        confirmedBy: o.confirmedBy,
        confirmedByName,
        confirmedAt: o.confirmedAt?.toISOString() ?? null,
        remark: o.remark,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        counterpartStoreId: o.counterpartStoreId,
        counterpartStoreName,
        isDispatcher: o.isDispatcher,
        receiveQuantity: o.receiveQuantity == null ? null : Number(o.receiveQuantity),
      })),
      total: countRow?.count ?? 0,
    }
  },
)

export const getTransferOrderById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<TransferOrderDetail | null> => {
    const scopeIds = session.permissions.scopeStoreIds
    const isAdminLike = session.roles.some((r) => r.role === 'admin')
    const conditions: (SQL | undefined)[] = [eq(inventoryTransferOrders.id, id)]
    if (!isAdminLike) {
      if (scopeIds.length === 0) {
        conditions.push(sql`FALSE`)
      } else {
        conditions.push(
          or(
            sql`${inventoryTransferOrders.storeId} IN (${sql.join(
              scopeIds.map((sid) => sql`${sid}`),
              sql`, `,
            )})`,
            sql`${inventoryTransferOrders.counterpartStoreId} IN (${sql.join(
              scopeIds.map((sid) => sql`${sid}`),
              sql`, `,
            )})`,
          ),
        )
      }
    }

    const [head] = await db
      .select({
        order: inventoryTransferOrders,
        storeName: stores.storeName,
        counterpartStoreName: sql<string | null>`(SELECT store_name FROM stores WHERE store_id = ${inventoryTransferOrders.counterpartStoreId})`,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryTransferOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryTransferOrders.confirmedBy})`,
      })
      .from(inventoryTransferOrders)
      .leftJoin(stores, eq(inventoryTransferOrders.storeId, stores.storeId))
      .where(and(...conditions))
      .limit(1)

    if (!head) return null

    const items = await db
      .select()
      .from(inventoryTransferOrderItems)
      .where(eq(inventoryTransferOrderItems.orderId, id))
      .orderBy(inventoryTransferOrderItems.id)

    const o = head.order
    return {
      id: o.id,
      docSubtype: o.docSubtype,
      status: o.status,
      storeId: o.storeId,
      storeName: head.storeName,
      docDate: o.docDate,
      totalQuantity: o.totalQuantity == null ? null : Number(o.totalQuantity),
      createdBy: o.createdBy,
      createdByName: head.createdByName,
      confirmedBy: o.confirmedBy,
      confirmedByName: head.confirmedByName,
      confirmedAt: o.confirmedAt?.toISOString() ?? null,
      remark: o.remark,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      counterpartStoreId: o.counterpartStoreId,
      counterpartStoreName: head.counterpartStoreName,
      isDispatcher: o.isDispatcher,
      receiveQuantity: o.receiveQuantity == null ? null : Number(o.receiveQuantity),
      items: items.map((it) => ({
        id: it.id,
        orderId: it.orderId,
        productCode: it.productCode,
        productName: it.productName,
        specName: it.specName,
        manufacturer: it.manufacturer,
        productSeries: it.productSeries,
        batchNo: it.batchNo,
        expiryDate: it.expiryDate,
        isGift: it.isGift,
        quantity: Number(it.quantity),
        stockOnHand: it.stockOnHand == null ? null : Number(it.stockOnHand),
        unitPrice: it.unitPrice == null ? null : Number(it.unitPrice),
        amount: it.amount == null ? null : Number(it.amount),
        remark: it.remark,
        createdAt: it.createdAt.toISOString(),
      })),
    }
  },
)

export const createTransferOrder = withPermission(
  'inventory:create',
  async (session, data: TransferCreateInput): Promise<{ id: string }> => {
    if (!data.storeId || !data.counterpartStoreId) {
      throw new ApiError('INVALID_PARAMS', '缺少发起或接收门店')
    }
    if (data.storeId === data.counterpartStoreId) {
      throw new ApiError('INVALID_PARAMS', '发起与接收门店必须不同')
    }
    if (!isInScope(session, data.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权代该门店发起调拨')
    }
    if (!data.items?.length) throw new ApiError('INVALID_PARAMS', '至少录入一条明细')
    if (data.items.some((it) => !it.productCode || !it.productName || !it.quantity)) {
      throw new ApiError('INVALID_PARAMS', '明细缺少产品或数量')
    }

    // 调拨出库 → isDispatcher=true；调拨入库 → false
    const isDispatcher = data.docSubtype === '调拨出库'

    const id = await db.transaction(async (tx) => {
      const docId = await generateInventoryDocNo(tx, 'transfer')
      await tx.insert(inventoryTransferOrders).values({
        id: docId,
        docSubtype: data.docSubtype,
        status: data.status ?? '已完成',
        storeId: data.storeId,
        counterpartStoreId: data.counterpartStoreId,
        isDispatcher,
        docDate: data.docDate,
        totalQuantity: String(sumQty(data.items)),
        remark: data.remark ?? null,
        createdBy: session.employeeId,
      })
      await tx.insert(inventoryTransferOrderItems).values(
        data.items.map((it) => ({
          orderId: docId,
          productCode: it.productCode,
          productName: it.productName,
          specName: it.specName ?? null,
          manufacturer: it.manufacturer ?? null,
          productSeries: it.productSeries ?? null,
          batchNo: it.batchNo ?? null,
          expiryDate: it.expiryDate ?? null,
          isGift: it.isGift ?? false,
          quantity: String(it.quantity),
          stockOnHand: it.stockOnHand == null ? null : String(it.stockOnHand),
          unitPrice: it.unitPrice == null ? null : String(it.unitPrice),
          amount: it.amount == null ? null : String(it.amount),
          remark: it.remark ?? null,
        })),
      )
      return docId
    })

    await logOperation(session, 'inventory.transfer.create', 'inventory_transfer', id, {
      docSubtype: data.docSubtype,
      storeId: data.storeId,
      counterpartStoreId: data.counterpartStoreId,
      itemCount: data.items.length,
    })
    revalidatePath('/inventory/transfer')
    return { id }
  },
)

export const updateTransferOrder = withPermission(
  'inventory:update',
  async (session, data: TransferUpdateInput): Promise<{ success: true }> => {
    const [existing] = await db
      .select()
      .from(inventoryTransferOrders)
      .where(eq(inventoryTransferOrders.id, data.id))
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '调拨单不存在')
    if (
      !isInScope(session, existing.storeId) &&
      !isInScope(session, existing.counterpartStoreId)
    ) {
      throw new ApiError('PERMISSION_DENIED', '无权修改该调拨单')
    }
    if (existing.status === '已取消') {
      throw new ApiError('INVALID_STATE', '已取消的单据不可修改')
    }

    await db.transaction(async (tx) => {
      // updatedAt 走 nowTs()（北京墙钟字面），$inferInsert 类型不接受 SQL 片段，故在 .set() 处合并。
      const patch: Partial<typeof inventoryTransferOrders.$inferInsert> = {}
      if (data.docSubtype !== undefined) {
        patch.docSubtype = data.docSubtype
        patch.isDispatcher = data.docSubtype === '调拨出库'
      }
      if (data.docDate !== undefined) patch.docDate = data.docDate
      if (data.status !== undefined) patch.status = data.status
      if (data.counterpartStoreId !== undefined) {
        if (data.counterpartStoreId === existing.storeId) {
          throw new ApiError('INVALID_PARAMS', '发起与接收门店必须不同')
        }
        patch.counterpartStoreId = data.counterpartStoreId
      }
      if (data.remark !== undefined) patch.remark = data.remark
      if (data.items !== undefined) patch.totalQuantity = String(sumQty(data.items))

      await tx
        .update(inventoryTransferOrders)
        .set({ ...patch, updatedAt: nowTs() })
        .where(eq(inventoryTransferOrders.id, data.id))

      if (data.items !== undefined) {
        await tx
          .delete(inventoryTransferOrderItems)
          .where(eq(inventoryTransferOrderItems.orderId, data.id))
        if (data.items.length > 0) {
          await tx.insert(inventoryTransferOrderItems).values(
            data.items.map((it) => ({
              orderId: data.id,
              productCode: it.productCode,
              productName: it.productName,
              specName: it.specName ?? null,
              manufacturer: it.manufacturer ?? null,
              productSeries: it.productSeries ?? null,
              batchNo: it.batchNo ?? null,
              expiryDate: it.expiryDate ?? null,
              isGift: it.isGift ?? false,
              quantity: String(it.quantity),
              stockOnHand: it.stockOnHand == null ? null : String(it.stockOnHand),
              unitPrice: it.unitPrice == null ? null : String(it.unitPrice),
              amount: it.amount == null ? null : String(it.amount),
              remark: it.remark ?? null,
            })),
          )
        }
      }
    })

    await logOperation(session, 'inventory.transfer.update', 'inventory_transfer', data.id, {
      changes: Object.keys(data).filter((k) => k !== 'id'),
    })
    revalidatePath('/inventory/transfer')
    revalidatePath(`/inventory/transfer/${data.id}`)
    return { success: true }
  },
)

/**
 * 接收方确认收货
 *
 * 接收门店的店长/管理员调用；记录 receiveQuantity（实际收到数量，可与发起数量不同）。
 * 一旦 confirmedAt 已写入，再次调用会抛 CONFLICT。
 */
export const confirmTransferReceive = withPermission(
  'inventory:update',
  async (
    session,
    data: { id: string; receiveQuantity: number },
  ): Promise<{ success: true }> => {
    const [existing] = await db
      .select()
      .from(inventoryTransferOrders)
      .where(eq(inventoryTransferOrders.id, data.id))
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '调拨单不存在')
    if (!isInScope(session, existing.counterpartStoreId)) {
      throw new ApiError('PERMISSION_DENIED', '只有接收门店可确认收货')
    }
    if (existing.confirmedAt) {
      throw new ApiError('CONFLICT', '调拨单已确认收货')
    }
    if (!Number.isFinite(data.receiveQuantity) || data.receiveQuantity <= 0) {
      throw new ApiError('INVALID_PARAMS', '收货数量必须为正数')
    }

    await db
      .update(inventoryTransferOrders)
      .set({
        confirmedBy: session.employeeId,
        confirmedAt: nowTs(),
        receiveQuantity: String(data.receiveQuantity),
        updatedAt: nowTs(),
      })
      .where(eq(inventoryTransferOrders.id, data.id))

    await logOperation(
      session,
      'inventory.transfer.confirm_receive',
      'inventory_transfer',
      data.id,
      { receiveQuantity: data.receiveQuantity },
    )
    revalidatePath('/inventory/transfer')
    revalidatePath(`/inventory/transfer/${data.id}`)
    return { success: true }
  },
)

export const deleteTransferOrder = withPermission(
  'inventory:delete',
  async (session, id: string): Promise<{ success: true }> => {
    const [existing] = await db
      .select({ storeId: inventoryTransferOrders.storeId })
      .from(inventoryTransferOrders)
      .where(eq(inventoryTransferOrders.id, id))
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '调拨单不存在')
    if (!isInScope(session, existing.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权删除该门店的调拨单')
    }
    await db.delete(inventoryTransferOrders).where(eq(inventoryTransferOrders.id, id))
    await logOperation(session, 'inventory.transfer.delete', 'inventory_transfer', id, {})
    revalidatePath('/inventory/transfer')
    return { success: true }
  },
)
