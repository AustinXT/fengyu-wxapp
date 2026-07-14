'use server'

import { db } from '@/db'
import {
  inventoryProcurementOrders,
  inventoryProcurementOrderItems,
} from '@db/inventory'
import { stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope, requireAdmin } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { nowTs } from '@/lib/db-time'
import { generateInventoryDocNo } from './doc-no'
import type {
  InventoryItemDto,
  InventoryListFilters,
  InventoryOrderRow,
  PaginatedInventoryOrders,
  InventoryProcurementSubtype,
} from './types'

export interface ProcurementOrderDetail extends InventoryOrderRow {
  docSubtype: InventoryProcurementSubtype
  isCompleted: boolean
  sourceDate: string | null
  sourceQuantity: number | null
  signatureUrl: string | null
  relatedDocNo: string | null
  items: ProcurementItemRow[]
}

export interface ProcurementItemRow extends InventoryItemDto {
  id: number
  orderId: string
  createdAt: string
}

export interface ProcurementCreateInput {
  docSubtype: InventoryProcurementSubtype
  storeId: string
  docDate: string
  status?: '草稿' | '已完成'
  isCompleted?: boolean
  sourceDate?: string | null
  sourceQuantity?: number | null
  signatureUrl?: string | null
  relatedDocNo?: string | null
  remark?: string | null
  items: InventoryItemDto[]
}

export interface ProcurementUpdateInput {
  id: string
  docSubtype?: InventoryProcurementSubtype
  docDate?: string
  status?: '草稿' | '已完成' | '已取消'
  isCompleted?: boolean
  sourceDate?: string | null
  sourceQuantity?: number | null
  signatureUrl?: string | null
  relatedDocNo?: string | null
  remark?: string | null
  confirm?: boolean
  items?: InventoryItemDto[]
}

function rowToOrder(r: {
  order: typeof inventoryProcurementOrders.$inferSelect
  storeName: string | null
  createdByName: string | null
  confirmedByName: string | null
}): InventoryOrderRow {
  const o = r.order
  return {
    id: o.id,
    docSubtype: o.docSubtype,
    status: o.status,
    storeId: o.storeId,
    storeName: r.storeName,
    docDate: o.docDate,
    totalQuantity: o.totalQuantity == null ? null : Number(o.totalQuantity),
    createdBy: o.createdBy,
    createdByName: r.createdByName,
    confirmedBy: o.confirmedBy,
    confirmedByName: r.confirmedByName,
    confirmedAt: o.confirmedAt?.toISOString() ?? null,
    remark: o.remark,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  }
}

function sumItemsQuantity(items: InventoryItemDto[]): number {
  return items.reduce((acc, it) => acc + Number(it.quantity || 0), 0)
}

export const listProcurementOrders = withPermission(
  'inventory:list',
  async (
    session,
    filters: InventoryListFilters = {},
  ): Promise<PaginatedInventoryOrders> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, inventoryProcurementOrders.storeId),
    ]
    if (filters.storeId) {
      conditions.push(eq(inventoryProcurementOrders.storeId, filters.storeId))
    }
    if (filters.docSubtype) {
      conditions.push(
        eq(
          inventoryProcurementOrders.docSubtype,
          filters.docSubtype as InventoryProcurementSubtype,
        ),
      )
    }
    if (filters.status) {
      conditions.push(eq(inventoryProcurementOrders.status, filters.status))
    }
    if (filters.startDate) {
      conditions.push(gte(inventoryProcurementOrders.docDate, filters.startDate))
    }
    if (filters.endDate) {
      conditions.push(lte(inventoryProcurementOrders.docDate, filters.endDate))
    }
    if (filters.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&')
      const pattern = `%${escaped}%`
      conditions.push(
        or(
          ilike(inventoryProcurementOrders.id, pattern),
          ilike(inventoryProcurementOrders.relatedDocNo, pattern),
          ilike(inventoryProcurementOrders.remark, pattern),
        ),
      )
    }
    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryProcurementOrders)
      .where(whereClause)

    const rows = await db
      .select({
        order: inventoryProcurementOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryProcurementOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryProcurementOrders.confirmedBy})`,
      })
      .from(inventoryProcurementOrders)
      .leftJoin(stores, eq(inventoryProcurementOrders.storeId, stores.storeId))
      .where(whereClause)
      
      .orderBy(
        desc(inventoryProcurementOrders.docDate),
        desc(inventoryProcurementOrders.createdAt),
      )
      .limit(pageSize)
      .offset(offset)

    return {
      data: rows.map(rowToOrder),
      total: countRow?.count ?? 0,
    }
  },
)

export const getProcurementOrderById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<ProcurementOrderDetail | null> => {
    const [head] = await db
      .select({
        order: inventoryProcurementOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryProcurementOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryProcurementOrders.confirmedBy})`,
      })
      .from(inventoryProcurementOrders)
      .leftJoin(stores, eq(inventoryProcurementOrders.storeId, stores.storeId))
      .where(
        and(
          eq(inventoryProcurementOrders.id, id),
          scopeCondition(session, inventoryProcurementOrders.storeId),
        ),
      )
      .limit(1)

    if (!head) return null

    const items = await db
      .select()
      .from(inventoryProcurementOrderItems)
      .where(eq(inventoryProcurementOrderItems.orderId, id))
      .orderBy(inventoryProcurementOrderItems.id)

    const base = rowToOrder(head)
    return {
      ...base,
      docSubtype: head.order.docSubtype,
      isCompleted: head.order.isCompleted,
      sourceDate: head.order.sourceDate,
      sourceQuantity:
        head.order.sourceQuantity == null ? null : Number(head.order.sourceQuantity),
      signatureUrl: head.order.signatureUrl,
      relatedDocNo: head.order.relatedDocNo,
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
        requestQuantity:
          it.requestQuantity == null ? null : Number(it.requestQuantity),
        remark: it.remark,
        createdAt: it.createdAt.toISOString(),
      })),
    }
  },
)

export const createProcurementOrder = withPermission(
  'inventory:create',
  async (
    session,
    data: ProcurementCreateInput,
  ): Promise<{ id: string }> => {
    if (!data.storeId) throw new ApiError('INVALID_PARAMS', '缺少门店')
    if (!isInScope(session, data.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权在该门店创建库存单据')
    }
    if (!data.items || data.items.length === 0) {
      throw new ApiError('INVALID_PARAMS', '至少录入一条明细')
    }
    if (data.items.some((it) => !it.productCode || !it.productName || !it.quantity)) {
      throw new ApiError('INVALID_PARAMS', '明细缺少产品或数量')
    }

    const id = await db.transaction(async (tx) => {
      const docId = await generateInventoryDocNo(tx, 'procurement')
      await tx.insert(inventoryProcurementOrders).values({
        id: docId,
        docSubtype: data.docSubtype,
        status: data.status ?? '已完成',
        storeId: data.storeId,
        docDate: data.docDate,
        totalQuantity: String(sumItemsQuantity(data.items)),
        isCompleted: data.isCompleted ?? false,
        sourceDate: data.sourceDate ?? null,
        sourceQuantity:
          data.sourceQuantity == null ? null : String(data.sourceQuantity),
        signatureUrl: data.signatureUrl ?? null,
        relatedDocNo: data.relatedDocNo ?? null,
        remark: data.remark ?? null,
        createdBy: session.employeeId,
      })

      await tx.insert(inventoryProcurementOrderItems).values(
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
          requestQuantity:
            it.requestQuantity == null ? null : String(it.requestQuantity),
          remark: it.remark ?? null,
        })),
      )

      return docId
    })

    await logOperation(session, 'inventory.procurement.create', 'inventory_procurement', id, {
      docSubtype: data.docSubtype,
      storeId: data.storeId,
      itemCount: data.items.length,
    })

    revalidatePath('/inventory/procurement')
    return { id }
  },
)

export const updateProcurementOrder = withPermission(
  'inventory:update',
  async (
    session,
    data: ProcurementUpdateInput,
  ): Promise<{ success: true }> => {
    const [existing] = await db
      .select()
      .from(inventoryProcurementOrders)
      .where(
        and(
          eq(inventoryProcurementOrders.id, data.id),
          scopeCondition(session, inventoryProcurementOrders.storeId),
        ),
      )
      .limit(1)

    if (!existing) throw new ApiError('NOT_FOUND', '库存单据不存在或无权限')
    if (existing.status === '已取消') {
      throw new ApiError('INVALID_STATE', '已取消的单据不可修改')
    }

    await db.transaction(async (tx) => {
      
      const masterPatch: Partial<typeof inventoryProcurementOrders.$inferInsert> = {}
      if (data.docSubtype !== undefined) masterPatch.docSubtype = data.docSubtype
      if (data.docDate !== undefined) masterPatch.docDate = data.docDate
      if (data.status !== undefined) masterPatch.status = data.status
      if (data.isCompleted !== undefined) masterPatch.isCompleted = data.isCompleted
      if (data.sourceDate !== undefined) masterPatch.sourceDate = data.sourceDate
      if (data.sourceQuantity !== undefined) {
        masterPatch.sourceQuantity =
          data.sourceQuantity == null ? null : String(data.sourceQuantity)
      }
      if (data.signatureUrl !== undefined) masterPatch.signatureUrl = data.signatureUrl
      if (data.relatedDocNo !== undefined) masterPatch.relatedDocNo = data.relatedDocNo
      if (data.remark !== undefined) masterPatch.remark = data.remark
      const confirmPatch = data.confirm
        ? { confirmedBy: session.employeeId, confirmedAt: nowTs() }
        : {}
      if (data.items !== undefined) {
        masterPatch.totalQuantity = String(sumItemsQuantity(data.items))
      }

      await tx
        .update(inventoryProcurementOrders)
        .set({ ...masterPatch, ...confirmPatch, updatedAt: nowTs() })
        .where(eq(inventoryProcurementOrders.id, data.id))

      
      if (data.items !== undefined) {
        await tx
          .delete(inventoryProcurementOrderItems)
          .where(eq(inventoryProcurementOrderItems.orderId, data.id))
        if (data.items.length > 0) {
          await tx.insert(inventoryProcurementOrderItems).values(
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
              requestQuantity:
                it.requestQuantity == null ? null : String(it.requestQuantity),
              remark: it.remark ?? null,
            })),
          )
        }
      }
    })

    await logOperation(session, 'inventory.procurement.update', 'inventory_procurement', data.id, {
      changes: Object.keys(data).filter((k) => k !== 'id'),
    })
    revalidatePath('/inventory/procurement')
    revalidatePath(`/inventory/procurement/${data.id}`)
    return { success: true }
  },
)

export const deleteProcurementOrder = withPermission(
  'inventory:delete',
  async (session, id: string): Promise<{ success: true }> => {
    requireAdmin(session)
    const [existing] = await db
      .select({ storeId: inventoryProcurementOrders.storeId })
      .from(inventoryProcurementOrders)
      .where(eq(inventoryProcurementOrders.id, id))
      .limit(1)

    if (!existing) throw new ApiError('NOT_FOUND', '库存单据不存在')
    if (!isInScope(session, existing.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权删除该门店的库存单据')
    }

    await db.delete(inventoryProcurementOrders).where(eq(inventoryProcurementOrders.id, id))

    await logOperation(session, 'inventory.procurement.delete', 'inventory_procurement', id, {})
    revalidatePath('/inventory/procurement')
    return { success: true }
  },
)
