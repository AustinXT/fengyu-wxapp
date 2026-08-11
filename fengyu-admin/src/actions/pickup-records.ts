'use server'

import { db } from '@/db'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { pickupRecords } from '@db/pickup'
import { saleItems } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import { beijingBoundaryTs } from '@/lib/db-time'
import { shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import type { SQL } from 'drizzle-orm'
import { isInScope, scopeCondition, requireAdmin } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { hasPendingRefund } from '@/lib/refund-cascade'
import { revalidatePath } from 'next/cache'
import { storeInMarketCondition } from '@/lib/market-store-sql'

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
  marketId?: string
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = any

async function generatePickupInventoryDocNo(tx: AnyTx): Promise<string> {
  const prefix = 'GCK'
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`store_inventory_docs:${prefix}:${ymd}`})::bigint)`)
  const rows = (await tx.execute(sql`
    SELECT id
      FROM store_inventory_docs
     WHERE id LIKE ${`${prefix}-${ymd}-%`}
  ORDER BY id DESC
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  const latest = rows[0]?.id
  const seq = latest ? Number(latest.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function createPickupInventoryDoc(
  tx: AnyTx,
  session: { employeeId: string },
  data: {
    storeId: string
    saleItemId: string
    saleOrderId: string
    skuId: string
    productName: string | null
    clientUserId: string | null
    customerName: string | null
    pickupQuantity: number
    remark?: string | null
    idempotencyKey?: string | null
  },
): Promise<string> {
  const stockRows = (await tx.execute(sql`
    SELECT id, store_id, sku_id, sku_name, batch_no, expiry_date, quantity_on_hand
      FROM store_inventory_stocks
     WHERE store_id = ${data.storeId}
       AND sku_id = ${data.skuId}
       AND quantity_on_hand > 0
  ORDER BY expiry_date NULLS LAST, id
     FOR UPDATE
  `)) as unknown as Array<{
    id: number
    store_id: string
    sku_id: string
    sku_name: string | null
    batch_no: string | null
    expiry_date: string | null
    quantity_on_hand: string | number
  }>

  const available = stockRows.reduce((acc, row) => acc + Number(row.quantity_on_hand), 0)
  if (available < data.pickupQuantity) {
    throw new ApiError('INVALID_STATE', `门店库存不足，当前可用 ${available}`)
  }

  const docId = await generatePickupInventoryDocNo(tx)
  await tx.execute(sql`
    INSERT INTO store_inventory_docs (
      id, doc_type, status, store_id, doc_date, total_quantity,
      related_sale_order_id, client_user_id, customer_name,
      remark, created_by, confirmed_by, confirmed_at
    )
    VALUES (
      ${docId}, '院顾客产品出库', '已完成', ${data.storeId}, ${shanghaiToday()}, ${data.pickupQuantity},
      ${data.saleOrderId}, ${data.clientUserId}, ${data.customerName},
      ${data.remark?.trim() || null}, ${session.employeeId}, ${session.employeeId}, NOW()
    )
  `)

  let remaining = data.pickupQuantity
  let itemSeq = 0
  for (const stock of stockRows) {
    if (remaining <= 0) break
    const before = Number(stock.quantity_on_hand)
    const deduct = Math.min(before, remaining)
    const after = before - deduct
    const inserted = (await tx.execute(sql`
      INSERT INTO store_inventory_doc_items (
        doc_id, stock_id, sku_id, sale_item_id, sku_name, batch_no, expiry_date,
        quantity, stock_snapshot, remark
      )
      VALUES (
        ${docId}, ${stock.id}, ${stock.sku_id}, ${data.saleItemId},
        ${stock.sku_name || data.productName || data.skuId}, ${stock.batch_no || ''}, ${stock.expiry_date},
        ${deduct}, ${before}, ${data.remark?.trim() || null}
      )
      RETURNING id
    `)) as unknown as Array<{ id: number }>
    const docItemId = inserted[0].id
    await tx.execute(sql`
      UPDATE store_inventory_stocks
         SET quantity_on_hand = ${after},
             updated_at = NOW()
       WHERE id = ${stock.id}
    `)
    await tx.execute(sql`
      INSERT INTO store_inventory_movements (
        movement_key, stock_id, store_id, sku_id, doc_id, doc_item_id,
        sale_order_id, sale_item_id, direction, quantity_delta,
        quantity_before, quantity_after, created_by, remark
      )
      VALUES (
        ${`pickup:${data.saleItemId}:${data.idempotencyKey || docId}:${itemSeq++}`},
        ${stock.id}, ${data.storeId}, ${stock.sku_id}, ${docId}, ${docItemId},
        ${data.saleOrderId}, ${data.saleItemId}, '出库', ${-deduct},
        ${before}, ${after}, ${session.employeeId}, ${data.remark?.trim() || null}
      )
    `)
    remaining -= deduct
  }

  return docId
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

  if (filters.marketId) conditions.push(storeInMarketCondition(pickupRecords.storeId, filters.marketId))
  if (filters.storeId) conditions.push(eq(pickupRecords.storeId, filters.storeId))
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
    conditions.push(gte(pickupRecords.createdAt, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    conditions.push(lte(pickupRecords.createdAt, beijingBoundaryTs(filters.dateTo, '23:59:59')))
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
  saleItemGroupId: string | null
  sourceSaleItemIds: string[]
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
      COALESCE(si.sale_item_group_id, si.sale_item_id) AS sale_item_group_id,
      MIN(si.sale_item_id) AS sale_item_id,
      ARRAY_AGG(si.sale_item_id ORDER BY si.sale_item_id) AS source_sale_item_ids,
      MIN(si.sale_order_id) AS sale_order_id,
      MIN(si.product_name) AS product_name,
      SUM(si.quantity)::int AS quantity,
      SUM(COALESCE(si.picked_up_quantity, 0))::int AS picked_up_quantity,
      MIN(si.unit_real_price) AS unit_real_price,
      MIN(o.store_id) AS store_id,
      MIN(s.store_name) AS store_name
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN stores s ON s.store_id = o.store_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status = '已支付'
      AND si.item_direction = '购买'
      AND si.product_type = '家居产品'
      AND si.quantity > COALESCE(si.picked_up_quantity, 0)
    GROUP BY COALESCE(si.sale_item_group_id, si.sale_item_id)
    ORDER BY MAX(o.paid_at) DESC, MIN(si.sale_item_id)
  `)

  // 不按原订单门店过滤：提货店可能与原销售店不同（顾客跨店提货），
  // scope 约束在 createPickupRecord 对"实际提货门店"生效。
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    saleItemId: r.sale_item_id as string,
    saleItemGroupId: (r.sale_item_group_id as string | null) ?? null,
    sourceSaleItemIds: (r.source_sale_item_ids as string[] | null) ?? [r.sale_item_id as string],
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

async function createGroupedPickupRecord(
  session: { employeeId: string },
  data: {
    saleItemIds: string[]
    pickupQuantity: number
    storeId: string
    clientUserId: string | null
    remark?: string | null
    idempotencyKey?: string | null
  },
): Promise<{ pickupRecordId: number; inventoryDocId: string; selectedSaleItemIds: string[] }> {
  const sourceIds = [...new Set(data.saleItemIds.filter(Boolean))].sort()
  if (sourceIds.length < 2 || data.pickupQuantity > sourceIds.length) {
    throw new ApiError('INVALID_PARAMS', '合并提货数量或来源明细不合法')
  }
  const sourceIdList = sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)
  const idemKey = data.idempotencyKey?.trim() || null

  return db.transaction(async (tx) => {
    if (idemKey) {
      const replay = (await tx.execute(sql`
        SELECT id, sale_item_id
          FROM pickup_records
         WHERE sale_item_id IN (${sourceIdList})
           AND store_id = ${data.storeId}
           AND idempotency_key = ${idemKey}
      ORDER BY sale_item_id
      `)) as unknown as Array<{ id: number; sale_item_id: string }>
      if (replay.length > 0) {
        return {
          pickupRecordId: replay[0].id,
          inventoryDocId: '',
          selectedSaleItemIds: replay.map((row) => row.sale_item_id),
        }
      }
    }

    const locked = (await tx.execute(sql`
      SELECT si.sale_item_id, si.sale_item_group_id, si.sale_order_id, si.sku_id,
             si.product_name, si.quantity, COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity,
             o.client_user_id, o.customer_name
        FROM sale_items si
        JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       WHERE si.sale_item_id IN (${sourceIdList})
       FOR UPDATE OF si
    `)) as unknown as Array<{
      sale_item_id: string
      sale_item_group_id: string | null
      sale_order_id: string
      sku_id: string | null
      product_name: string | null
      quantity: number
      picked_up_quantity: number
      client_user_id: string | null
      customer_name: string | null
    }>
    if (locked.length !== sourceIds.length) {
      throw new ApiError('CONFLICT', '部分家居产品已更新，请刷新后重试')
    }
    const first = locked[0]
    if (!first?.sku_id || locked.some((row) =>
      row.sale_order_id !== first.sale_order_id
      || row.sku_id !== first.sku_id
      || (row.sale_item_group_id || row.sale_item_id) !== (first.sale_item_group_id || first.sale_item_id)
      || Number(row.quantity) !== 1
      || Number(row.picked_up_quantity) !== 0,
    )) {
      throw new ApiError('CONFLICT', '家居产品状态已更新，请刷新后重试')
    }
    const invalid = (await tx.execute(sql`
      SELECT count(*)::int AS count
        FROM sale_items
       WHERE sale_item_id IN (${sourceIdList})
         AND (product_type <> '家居产品' OR item_direction <> '购买')
    `)) as unknown as Array<{ count: number }>
    if (Number(invalid[0]?.count ?? 0) > 0) {
      throw new ApiError('INVALID_PARAMS', '来源明细不是可提货家居产品')
    }
    if (await hasPendingRefund(tx, first.sale_order_id)) {
      throw new ApiError('INVALID_STATE', '该订单退款审批中，暂不可提货')
    }

    const selected = locked.slice(0, data.pickupQuantity)
    const stockRows = (await tx.execute(sql`
      SELECT id, sku_id, sku_name, batch_no, expiry_date, quantity_on_hand
        FROM store_inventory_stocks
       WHERE store_id = ${data.storeId}
         AND sku_id = ${first.sku_id}
         AND quantity_on_hand > 0
    ORDER BY expiry_date NULLS LAST, id
       FOR UPDATE
    `)) as unknown as Array<{
      id: number
      sku_id: string
      sku_name: string | null
      batch_no: string | null
      expiry_date: string | null
      quantity_on_hand: string | number
    }>
    if (stockRows.reduce((sum, row) => sum + Number(row.quantity_on_hand), 0) < selected.length) {
      throw new ApiError('INVALID_STATE', '门店库存不足')
    }

    const docId = await generatePickupInventoryDocNo(tx)
    await tx.execute(sql`
      INSERT INTO store_inventory_docs (
        id, doc_type, status, store_id, doc_date, total_quantity,
        related_sale_order_id, client_user_id, customer_name, remark,
        created_by, confirmed_by, confirmed_at
      ) VALUES (
        ${docId}, '院顾客产品出库', '已完成', ${data.storeId}, ${shanghaiToday()}, ${selected.length},
        ${first.sale_order_id}, ${data.clientUserId ?? first.client_user_id}, ${first.customer_name},
        ${data.remark?.trim() || null}, ${session.employeeId}, ${session.employeeId}, NOW()
      )
    `)

    let stockIndex = 0
    const pickupRecordIds: number[] = []
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index]
      while (Number(stockRows[stockIndex]?.quantity_on_hand ?? 0) <= 0) stockIndex++
      const stock = stockRows[stockIndex]
      const before = Number(stock.quantity_on_hand)
      const after = before - 1
      const docItem = (await tx.execute(sql`
        INSERT INTO store_inventory_doc_items (
          doc_id, stock_id, sku_id, sale_item_id, sku_name, batch_no, expiry_date,
          quantity, stock_snapshot, remark
        ) VALUES (
          ${docId}, ${stock.id}, ${stock.sku_id}, ${item.sale_item_id},
          ${stock.sku_name || item.product_name || stock.sku_id}, ${stock.batch_no || ''}, ${stock.expiry_date},
          1, ${before}, ${data.remark?.trim() || null}
        ) RETURNING id
      `)) as unknown as Array<{ id: number }>
      await tx.execute(sql`
        UPDATE store_inventory_stocks
           SET quantity_on_hand = ${after}, updated_at = NOW()
         WHERE id = ${stock.id}
      `)
      stock.quantity_on_hand = after
      await tx.execute(sql`
        INSERT INTO store_inventory_movements (
          movement_key, stock_id, store_id, sku_id, doc_id, doc_item_id,
          sale_order_id, sale_item_id, direction, quantity_delta,
          quantity_before, quantity_after, created_by, remark
        ) VALUES (
          ${`pickup:${item.sale_item_id}:${idemKey || docId}:${index}`}, ${stock.id}, ${data.storeId}, ${stock.sku_id},
          ${docId}, ${docItem[0].id}, ${first.sale_order_id}, ${item.sale_item_id}, '出库', -1,
          ${before}, ${after}, ${session.employeeId}, ${data.remark?.trim() || null}
        )
      `)
      await tx.execute(sql`
        UPDATE sale_items
           SET picked_up_quantity = 1, updated_at = NOW()
         WHERE sale_item_id = ${item.sale_item_id}
           AND COALESCE(picked_up_quantity, 0) = 0
      `)
      const inserted = await tx.insert(pickupRecords).values({
        saleItemId: item.sale_item_id,
        pickupQuantity: 1,
        storeId: data.storeId,
        clientUserId: data.clientUserId ?? first.client_user_id,
        confirmedBy: session.employeeId,
        remark: data.remark?.trim() || null,
        idempotencyKey: idemKey,
      }).returning({ id: pickupRecords.id })
      pickupRecordIds.push(inserted[0]?.id ?? 0)
    }

    return {
      pickupRecordId: pickupRecordIds[0] ?? 0,
      inventoryDocId: docId,
      selectedSaleItemIds: selected.map((item) => item.sale_item_id),
    }
  })
}

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
      saleItemIds?: string[]
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

  const groupedSourceIds = [...new Set((data.saleItemIds || []).filter(Boolean))].sort()
  if (groupedSourceIds.length > 1) {
    try {
      const created = await createGroupedPickupRecord(session, {
        saleItemIds: groupedSourceIds,
        pickupQuantity: data.pickupQuantity,
        storeId: data.storeId,
        clientUserId: data.clientUserId,
        remark: data.remark,
        idempotencyKey: data.idempotencyKey,
      })
      await logOperation(session, 'create', 'pickup_record_group', created.inventoryDocId || String(created.pickupRecordId), {
        saleItemIds: created.selectedSaleItemIds,
        pickupQuantity: created.selectedSaleItemIds.length,
        storeId: data.storeId,
        clientUserId: data.clientUserId,
        inventoryDocId: created.inventoryDocId || null,
      })
      revalidatePath('/pickup-records')
      return { success: true, message: created.inventoryDocId ? '提货记录创建成功' : '提货记录已存在（幂等）', createdId: created.pickupRecordId }
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : '创建失败' }
    }
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
        RETURNING sale_item_id, sale_order_id, sku_id, product_name, quantity, picked_up_quantity
      `)
      const updatedRows = updated as unknown as Array<{
        sale_item_id: string
        sale_order_id: string
        sku_id: string | null
        product_name: string | null
        quantity: number
        picked_up_quantity: number
      }>
      if (updatedRows.length === 0) {
        throw new ApiError('INVALID_STATE', '销售明细不存在、非家居产品或超出可提数量')
      }
      const updatedItem = updatedRows[0]
      if (!updatedItem.sku_id) {
        throw new ApiError('INVALID_STATE', '销售明细缺少 SKU，无法扣减门店库存')
      }

      const orderRows = (await tx.execute(sql`
        SELECT client_user_id, customer_name
          FROM sale_orders
         WHERE sale_order_id = ${updatedItem.sale_order_id}
         LIMIT 1
      `)) as unknown as Array<{ client_user_id: string | null; customer_name: string | null }>
      const orderInfo = orderRows[0] ?? { client_user_id: data.clientUserId, customer_name: null }

      const inventoryDocId = await createPickupInventoryDoc(tx, session, {
        storeId: data.storeId,
        saleItemId: updatedItem.sale_item_id,
        saleOrderId: updatedItem.sale_order_id,
        skuId: updatedItem.sku_id,
        productName: updatedItem.product_name,
        clientUserId: data.clientUserId ?? orderInfo.client_user_id,
        customerName: orderInfo.customer_name,
        pickupQuantity: data.pickupQuantity,
        remark: data.remark,
        idempotencyKey: idemKey,
      })

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

        return { pickupRecordId: inserted[0]?.id ?? 0, inventoryDocId }
      } catch (err: unknown) {
        if (pgErrorCode(err) === '23505' && pgErrorConstraint(err) === 'uq_pickup_idempotency') {
          throw new ApiError('CONFLICT', '提货请求重复，请勿重复提交')
        }
        throw err
      }
    })

    await logOperation(session, 'create', 'pickup_record', String(createdId.pickupRecordId), {
      saleItemId: data.saleItemId,
      pickupQuantity: data.pickupQuantity,
      storeId: data.storeId,
      clientUserId: data.clientUserId,
      inventoryDocId: createdId.inventoryDocId,
    })

    return { success: true, message: '提货记录创建成功', createdId: createdId.pickupRecordId }
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
    requireAdmin(session)
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
