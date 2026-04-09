'use server'

import { db } from '@/db'
import { pickupRecords } from '@db/pickup'
import { saleItems } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'

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
export async function getPickupRecordsPaginated(
  filters: PickupRecordFilters = {},
): Promise<PaginatedPickupRecords> {
  const session = await getSession()
  requirePermission(session, 'pickup_record:list')

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
    conditions.push(gte(pickupRecords.createdAt, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lte(pickupRecords.createdAt, new Date(filters.dateTo + 'T23:59:59')))
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
}

/**
 * 提货记录详情（单条）
 */
export async function getPickupRecordById(
  id: number,
): Promise<AdminPickupRecord | null> {
  const session = await getSession()
  requirePermission(session, 'pickup_record:list')

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
}
