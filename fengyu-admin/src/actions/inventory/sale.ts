'use server'

import { db } from '@/db'
import { inventorySaleOrders, inventorySaleOrderItems } from '@db/inventory'
import { stores } from '@db/org'
import { clientWechatUsers } from '@db/user'
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
  InventorySaleSubtype,
  PaginatedInventoryOrders,
} from './types'

export interface SaleOrderDetail extends InventoryOrderRow {
  docSubtype: InventorySaleSubtype
  clientUserId: string | null
  customerName: string | null
  relatedSaleOrderId: string | null
  items: SaleItemRow[]
}

export interface SaleItemRow extends InventoryItemDto {
  id: number
  orderId: string
  createdAt: string
}

export interface SaleCreateInput {
  docSubtype: InventorySaleSubtype
  storeId: string
  docDate: string
  status?: '草稿' | '已完成'
  clientUserId?: string | null
  customerName?: string | null
  relatedSaleOrderId?: string | null
  remark?: string | null
  items: InventoryItemDto[]
}

export interface SaleUpdateInput {
  id: string
  docSubtype?: InventorySaleSubtype
  docDate?: string
  status?: '草稿' | '已完成' | '已取消'
  clientUserId?: string | null
  customerName?: string | null
  relatedSaleOrderId?: string | null
  remark?: string | null
  confirm?: boolean
  items?: InventoryItemDto[]
}

function sumQty(items: InventoryItemDto[]): number {
  return items.reduce((acc, it) => acc + Number(it.quantity || 0), 0)
}

export const listSaleOrders = withPermission(
  'inventory:list',
  async (
    session,
    filters: InventoryListFilters = {},
  ): Promise<PaginatedInventoryOrders> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, inventorySaleOrders.storeId),
    ]
    if (filters.storeId) conditions.push(eq(inventorySaleOrders.storeId, filters.storeId))
    if (filters.docSubtype) {
      conditions.push(
        eq(inventorySaleOrders.docSubtype, filters.docSubtype as InventorySaleSubtype),
      )
    }
    if (filters.status) conditions.push(eq(inventorySaleOrders.status, filters.status))
    if (filters.startDate) conditions.push(gte(inventorySaleOrders.docDate, filters.startDate))
    if (filters.endDate) conditions.push(lte(inventorySaleOrders.docDate, filters.endDate))
    if (filters.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&')
      const pattern = `%${escaped}%`
      conditions.push(
        or(
          ilike(inventorySaleOrders.id, pattern),
          ilike(inventorySaleOrders.customerName, pattern),
          ilike(inventorySaleOrders.relatedSaleOrderId, pattern),
        ),
      )
    }
    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventorySaleOrders)
      .where(whereClause)

    const rows = await db
      .select({
        order: inventorySaleOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventorySaleOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventorySaleOrders.confirmedBy})`,
      })
      .from(inventorySaleOrders)
      .leftJoin(stores, eq(inventorySaleOrders.storeId, stores.storeId))
      .where(whereClause)
      .orderBy(desc(inventorySaleOrders.docDate), desc(inventorySaleOrders.createdAt))
      .limit(pageSize)
      .offset(offset)

    return {
      data: rows.map(({ order: o, storeName, createdByName, confirmedByName }) => ({
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
        customerName: o.customerName,
      })),
      total: countRow?.count ?? 0,
    }
  },
)

export const getSaleOrderById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<SaleOrderDetail | null> => {
    const [head] = await db
      .select({
        order: inventorySaleOrders,
        storeName: stores.storeName,
        createdByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventorySaleOrders.createdBy})`,
        confirmedByName: sql<string | null>`(SELECT name FROM staff_wechat_users WHERE employee_id = ${inventorySaleOrders.confirmedBy})`,
        clientName: clientWechatUsers.name,
      })
      .from(inventorySaleOrders)
      .leftJoin(stores, eq(inventorySaleOrders.storeId, stores.storeId))
      .leftJoin(
        clientWechatUsers,
        eq(inventorySaleOrders.clientUserId, clientWechatUsers.userId),
      )
      .where(
        and(
          eq(inventorySaleOrders.id, id),
          scopeCondition(session, inventorySaleOrders.storeId),
        ),
      )
      .limit(1)

    if (!head) return null

    const items = await db
      .select()
      .from(inventorySaleOrderItems)
      .where(eq(inventorySaleOrderItems.orderId, id))
      .orderBy(inventorySaleOrderItems.id)

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
      clientUserId: o.clientUserId,
      customerName: o.customerName ?? head.clientName ?? null,
      relatedSaleOrderId: o.relatedSaleOrderId,
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
        saleFlowNo: it.saleFlowNo,
        customerRemaining:
          it.customerRemaining == null ? null : Number(it.customerRemaining),
        verificationName: it.verificationName,
        verificationCode: it.verificationCode,
        remark: it.remark,
        createdAt: it.createdAt.toISOString(),
      })),
    }
  },
)

export const createSaleOrder = withPermission(
  'inventory:create',
  async (session, data: SaleCreateInput): Promise<{ id: string }> => {
    if (!data.storeId) throw new ApiError('INVALID_PARAMS', '缺少门店')
    if (!isInScope(session, data.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权在该门店创建库存单据')
    }
    if (!data.items?.length) throw new ApiError('INVALID_PARAMS', '至少录入一条明细')
    if (data.items.some((it) => !it.productCode || !it.productName || !it.quantity)) {
      throw new ApiError('INVALID_PARAMS', '明细缺少产品或数量')
    }

    const id = await db.transaction(async (tx) => {
      const docId = await generateInventoryDocNo(tx, 'sale')
      await tx.insert(inventorySaleOrders).values({
        id: docId,
        docSubtype: data.docSubtype,
        status: data.status ?? '已完成',
        storeId: data.storeId,
        docDate: data.docDate,
        totalQuantity: String(sumQty(data.items)),
        clientUserId: data.clientUserId ?? null,
        customerName: data.customerName ?? null,
        relatedSaleOrderId: data.relatedSaleOrderId ?? null,
        remark: data.remark ?? null,
        createdBy: session.employeeId,
      })
      await tx.insert(inventorySaleOrderItems).values(
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
          saleFlowNo: it.saleFlowNo ?? null,
          customerRemaining:
            it.customerRemaining == null ? null : String(it.customerRemaining),
          verificationName: it.verificationName ?? null,
          verificationCode: it.verificationCode ?? null,
          remark: it.remark ?? null,
        })),
      )
      return docId
    })

    await logOperation(session, 'inventory.sale.create', 'inventory_sale', id, {
      docSubtype: data.docSubtype,
      storeId: data.storeId,
      clientUserId: data.clientUserId,
      itemCount: data.items.length,
    })
    revalidatePath('/inventory/sale')
    return { id }
  },
)

export const updateSaleOrder = withPermission(
  'inventory:update',
  async (session, data: SaleUpdateInput): Promise<{ success: true }> => {
    const [existing] = await db
      .select()
      .from(inventorySaleOrders)
      .where(
        and(
          eq(inventorySaleOrders.id, data.id),
          scopeCondition(session, inventorySaleOrders.storeId),
        ),
      )
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '库存单据不存在或无权限')
    if (existing.status === '已取消') {
      throw new ApiError('INVALID_STATE', '已取消的单据不可修改')
    }

    await db.transaction(async (tx) => {
      // updatedAt/confirmedAt 走 nowTs()（北京墙钟字面），$inferInsert 类型不接受 SQL 片段，故在 .set() 处合并。
      const patch: Partial<typeof inventorySaleOrders.$inferInsert> = {}
      if (data.docSubtype !== undefined) patch.docSubtype = data.docSubtype
      if (data.docDate !== undefined) patch.docDate = data.docDate
      if (data.status !== undefined) patch.status = data.status
      if (data.clientUserId !== undefined) patch.clientUserId = data.clientUserId
      if (data.customerName !== undefined) patch.customerName = data.customerName
      if (data.relatedSaleOrderId !== undefined) {
        patch.relatedSaleOrderId = data.relatedSaleOrderId
      }
      if (data.remark !== undefined) patch.remark = data.remark
      const confirmPatch = data.confirm
        ? { confirmedBy: session.employeeId, confirmedAt: nowTs() }
        : {}
      if (data.items !== undefined) patch.totalQuantity = String(sumQty(data.items))

      await tx
        .update(inventorySaleOrders)
        .set({ ...patch, ...confirmPatch, updatedAt: nowTs() })
        .where(eq(inventorySaleOrders.id, data.id))

      if (data.items !== undefined) {
        await tx.delete(inventorySaleOrderItems).where(eq(inventorySaleOrderItems.orderId, data.id))
        if (data.items.length > 0) {
          await tx.insert(inventorySaleOrderItems).values(
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
              saleFlowNo: it.saleFlowNo ?? null,
              customerRemaining:
                it.customerRemaining == null ? null : String(it.customerRemaining),
              verificationName: it.verificationName ?? null,
              verificationCode: it.verificationCode ?? null,
              remark: it.remark ?? null,
            })),
          )
        }
      }
    })

    await logOperation(session, 'inventory.sale.update', 'inventory_sale', data.id, {
      changes: Object.keys(data).filter((k) => k !== 'id'),
    })
    revalidatePath('/inventory/sale')
    revalidatePath(`/inventory/sale/${data.id}`)
    return { success: true }
  },
)

export const deleteSaleOrder = withPermission(
  'inventory:delete',
  async (session, id: string): Promise<{ success: true }> => {
    requireAdmin(session)
    const [existing] = await db
      .select({ storeId: inventorySaleOrders.storeId })
      .from(inventorySaleOrders)
      .where(eq(inventorySaleOrders.id, id))
      .limit(1)
    if (!existing) throw new ApiError('NOT_FOUND', '库存单据不存在')
    if (!isInScope(session, existing.storeId)) {
      throw new ApiError('PERMISSION_DENIED', '无权删除该门店的库存单据')
    }
    await db.delete(inventorySaleOrders).where(eq(inventorySaleOrders.id, id))
    await logOperation(session, 'inventory.sale.delete', 'inventory_sale', id, {})
    revalidatePath('/inventory/sale')
    return { success: true }
  },
)
