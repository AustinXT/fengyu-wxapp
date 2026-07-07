'use server'

import { db } from '@/db'
import { inventoryScrapOrders, inventoryScrapOrderItems } from '@db/inventory'
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
  PaginatedInventoryOrders,
} from './types'

export interface ScrapOrderDetail extends InventoryOrderRow {
  items: ScrapItemRow[]
}

export interface ScrapItemRow extends InventoryItemDto {
  id: number
  orderId: string
  createdAt: string
}

export interface ScrapCreateInput {
  storeId: string
  docDate: string
  status?: '草稿' | '已完成'
  remark?: string | null
  items: InventoryItemDto[]
}

export interface ScrapUpdateInput {
  id: string
  docDate?: string
  status?: '草稿' | '已完成' | '已取消'
  remark?: string | null
  confirm?: boolean
  items?: InventoryItemDto[]
}

function sumQty(items: InventoryItemDto[]): number {
  return items.reduce((acc, it) => acc + Number(it.quantity || 0), 0)
}

export const listScrapOrders = withPermission(
  'inventory:list',
  async (
    session,
    filters: InventoryListFilters = {},
  ): Promise<PaginatedInventoryOrders> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, inventoryScrapOrders.storeId),
    ]
    if (filters.storeId) conditions.push(eq(inventoryScrapOrders.storeId, filters.storeId))
    if (filters.status) conditions.push(eq(inventoryScrapOrders.status, filters.status))
    if (filters.startDate) conditions.push(gte(inventoryScrapOrders.docDate, filters.startDate))
    if (filters.endDate) conditions.push(lte(inventoryScrapOrders.docDate, filters.endDate))
    if (filters.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&')
      const pattern = `%${escaped}%`
      conditions.push(
        or(ilike(inventoryScrapOrders.id, pattern), ilike(inventoryScrapOrders.remark, pattern)),
      )
    }
    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryScrapOrders)
      .where(whereClause)

    const rows = await db
      .select({
        order: inventoryScrapOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryScrapOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryScrapOrders.confirmedBy})`,
      })
      .from(inventoryScrapOrders)
      .leftJoin(stores, eq(inventoryScrapOrders.storeId, stores.storeId))
      .where(whereClause)
      .orderBy(desc(inventoryScrapOrders.docDate), desc(inventoryScrapOrders.createdAt))
      .limit(pageSize)
      .offset(offset)

    return {
      data: rows.map(({ order: o, storeName, createdByName, confirmedByName }) => ({
        id: o.id,
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
      })),
      total: countRow?.count ?? 0,
    }
  },
)

export const getScrapOrderById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<ScrapOrderDetail | null> => {
    const [head] = await db
      .select({
        order: inventoryScrapOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryScrapOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventoryScrapOrders.confirmedBy})`,
      })
      .from(inventoryScrapOrders)
      .leftJoin(stores, eq(inventoryScrapOrders.storeId, stores.storeId))
      .where(
        and(
          eq(inventoryScrapOrders.id, id),
          scopeCondition(session, inventoryScrapOrders.storeId),
        ),
      )
      .limit(1)

    if (!head) return null

    const items = await db
      .select()
      .from(inventoryScrapOrderItems)
      .where(eq(inventoryScrapOrderItems.orderId, id))
      .orderBy(inventoryScrapOrderItems.id)

    const o = head.order
    return {
      id: o.id,
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
        scrapReason: it.scrapReason,
        itemUsage: it.itemUsage,
        remark: it.remark,
        createdAt: it.createdAt.toISOString(),
      })),
    }
  },
)

export const createScrapOrder = withPermission(
  'inventory:create',
  async (session, data: ScrapCreateInput): Promise<{ id: string }> => {
    if (!data.storeId) throw new ApiError('INVALID_PARAMS', '缺少门店')
    if (!isInScope(session, data.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权在该门店创建库存单据')
    }
    if (!data.items?.length) throw new ApiError('INVALID_PARAMS', '至少录入一条明细')
    if (
      data.items.some(
        (it) => !it.productCode || !it.productName || !it.quantity || !it.scrapReason,
      )
    ) {
      throw new ApiError('INVALID_PARAMS', '报损明细必须含产品/数量/原因')
    }

    const id = await db.transaction(async (tx) => {
      const docId = await generateInventoryDocNo(tx, 'scrap')
      await tx.insert(inventoryScrapOrders).values({
        id: docId,
        status: data.status ?? '已完成',
        storeId: data.storeId,
        docDate: data.docDate,
        totalQuantity: String(sumQty(data.items)),
        remark: data.remark ?? null,
        createdBy: session.employeeId,
      })
      await tx.insert(inventoryScrapOrderItems).values(
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
          scrapReason: it.scrapReason!,
          itemUsage: it.itemUsage ?? null,
          remark: it.remark ?? null,
        })),
      )
      return docId
    })

    await logOperation(session, 'inventory.scrap.create', 'inventory_scrap', id, {
      storeId: data.storeId,
      itemCount: data.items.length,
    })
    revalidatePath('/inventory/scrap')
    return { id }
  },
)

export const updateScrapOrder = withPermission(
  'inventory:update',
  async (session, data: ScrapUpdateInput): Promise<{ success: true }> => {
    const [existing] = await db
      .select()
      .from(inventoryScrapOrders)
      .where(
        and(
          eq(inventoryScrapOrders.id, data.id),
          scopeCondition(session, inventoryScrapOrders.storeId),
        ),
      )
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '报损单不存在或无权限')
    if (existing.status === '已取消') {
      throw new ApiError('INVALID_STATE', '已取消的单据不可修改')
    }

    await db.transaction(async (tx) => {
      
      
      const patch: Partial<typeof inventoryScrapOrders.$inferInsert> = {}
      if (data.docDate !== undefined) patch.docDate = data.docDate
      if (data.status !== undefined) patch.status = data.status
      if (data.remark !== undefined) patch.remark = data.remark
      const confirmPatch = data.confirm
        ? { confirmedBy: session.employeeId, confirmedAt: nowTs() }
        : {}
      if (data.items !== undefined) patch.totalQuantity = String(sumQty(data.items))

      await tx
        .update(inventoryScrapOrders)
        .set({ ...patch, ...confirmPatch, updatedAt: nowTs() })
        .where(eq(inventoryScrapOrders.id, data.id))

      if (data.items !== undefined) {
        await tx
          .delete(inventoryScrapOrderItems)
          .where(eq(inventoryScrapOrderItems.orderId, data.id))
        if (data.items.length > 0) {
          await tx.insert(inventoryScrapOrderItems).values(
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
              scrapReason: it.scrapReason!,
              itemUsage: it.itemUsage ?? null,
              remark: it.remark ?? null,
            })),
          )
        }
      }
    })

    await logOperation(session, 'inventory.scrap.update', 'inventory_scrap', data.id, {
      changes: Object.keys(data).filter((k) => k !== 'id'),
    })
    revalidatePath('/inventory/scrap')
    revalidatePath(`/inventory/scrap/${data.id}`)
    return { success: true }
  },
)

export const deleteScrapOrder = withPermission(
  'inventory:delete',
  async (session, id: string): Promise<{ success: true }> => {
    const [existing] = await db
      .select({ storeId: inventoryScrapOrders.storeId })
      .from(inventoryScrapOrders)
      .where(eq(inventoryScrapOrders.id, id))
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '报损单不存在')
    if (!isInScope(session, existing.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权删除该门店的报损单')
    }
    await db.delete(inventoryScrapOrders).where(eq(inventoryScrapOrders.id, id))
    await logOperation(session, 'inventory.scrap.delete', 'inventory_scrap', id, {})
    revalidatePath('/inventory/scrap')
    return { success: true }
  },
)
