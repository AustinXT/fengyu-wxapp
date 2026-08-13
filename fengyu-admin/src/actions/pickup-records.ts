'use server'

import { db } from '@/db'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { pickupRecords } from '@db/pickup'
import { saleItems } from '@db/order'
import { stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus } from '@db/product'
import { inventorySkus } from '@db/inventory'
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
  /** 实际从库存扣减的 SKU；历史提货记录可能为空。 */
  inventorySkuId?: string
  inventorySkuName?: string
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

type AnyTx = any

interface PickupCompositionComponent {
  inventorySkuId: string
  productCode: string
  productName: string
  specName: string | null
  quantityPerSaleUnit: number
}

function parseCompositionSnapshot(value: unknown): PickupCompositionComponent[] | null {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const snapshot = parsed as { version?: unknown; components?: unknown }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.components) || snapshot.components.length === 0) return null
  const components: PickupCompositionComponent[] = []
  for (const raw of snapshot.components) {
    if (!raw || typeof raw !== 'object') return null
    const component = raw as Record<string, unknown>
    const quantity = Number(component.quantityPerSaleUnit)
    if (!component.inventorySkuId || !Number.isInteger(quantity) || quantity <= 0) return null
    components.push({
      inventorySkuId: String(component.inventorySkuId),
      productCode: String(component.productCode || component.inventorySkuId),
      productName: String(component.productName || component.inventorySkuId),
      specName: component.specName == null ? null : String(component.specName),
      quantityPerSaleUnit: quantity,
    })
  }
  return components
}

async function resolvePickupComposition(
  tx: AnyTx,
  item: { skuId: string | null; inventoryCompositionSnapshot: unknown },
): Promise<PickupCompositionComponent[]> {
  const frozen = parseCompositionSnapshot(item.inventoryCompositionSnapshot)
  if (frozen) return frozen
  if (!item.skuId) throw new ApiError('INVALID_STATE', '销售明细缺少 SKU，无法解析库存组成')
  const rows = (await tx.execute(sql`
    SELECT mapping.inventory_sku_id,
           inventory.product_code,
           inventory.product_name,
           inventory.spec_name,
           inventory.is_active,
           mapping.quantity_per_sale_unit
      FROM inventory_sku_product_sku_mappings mapping
      JOIN inventory_skus inventory ON inventory.sku_id = mapping.inventory_sku_id
     WHERE mapping.product_sku_id = ${item.skuId}
       AND mapping.is_active = TRUE
  ORDER BY inventory.product_name, inventory.product_code
  `)) as unknown as Array<{
    inventory_sku_id: string
    product_code: string
    product_name: string
    spec_name: string | null
    is_active: boolean
    quantity_per_sale_unit: number
  }>
  if (rows.length === 0) {
    throw new ApiError('INVALID_STATE', '该销售商品尚未配置库存组成，请先在“销售商品组成”中配置')
  }
  if (rows.some((row) => !row.is_active)) {
    throw new ApiError('INVALID_STATE', '该销售商品的当前库存组成含停用商品，请先修改组成')
  }
  return rows.map((row) => ({
    inventorySkuId: row.inventory_sku_id,
    productCode: row.product_code,
    productName: row.product_name,
    specName: row.spec_name,
    quantityPerSaleUnit: Number(row.quantity_per_sale_unit),
  }))
}

async function buildPickupRequirements(
  tx: AnyTx,
  items: Array<{ skuId: string | null; inventoryCompositionSnapshot: unknown; pickupUnits: number }>,
): Promise<Array<PickupCompositionComponent & { quantity: number }>> {
  const aggregated = new Map<string, PickupCompositionComponent & { quantity: number }>()
  for (const item of items) {
    const components = await resolvePickupComposition(tx, item)
    for (const component of components) {
      const current = aggregated.get(component.inventorySkuId)
      const quantity = component.quantityPerSaleUnit * item.pickupUnits
      if (current) current.quantity += quantity
      else aggregated.set(component.inventorySkuId, { ...component, quantity })
    }
  }
  return [...aggregated.values()].sort((a, b) => a.inventorySkuId.localeCompare(b.inventorySkuId))
}

async function generatePickupInventoryDocNo(tx: AnyTx): Promise<string> {
  const prefix = 'GCK'
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_docs:${prefix}:${ymd}`})::bigint)`)
  const rows = (await tx.execute(sql`
    SELECT id
      FROM inventory_docs
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
    productName: string | null
    clientUserId: string | null
    customerName: string | null
    requirements: Array<PickupCompositionComponent & { quantity: number }>
    remark?: string | null
  idempotencyKey?: string | null
  },
): Promise<string> {
  await tx.execute(sql`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active)
    SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id,
           COALESCE(o.is_active, false) AND NOT s.is_closed
      FROM stores s
      LEFT JOIN org_nodes o ON o.id = s.org_node_id
     WHERE s.store_id = ${data.storeId}
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
  `)

  type LotRow = {
    id: number
    location_id: string
    sku_id: string
    sku_name: string | null
    spec_name: string | null
    supplier: string | null
    product_series: string | null
    batch_no: string | null
    expiry_date: string | null
    is_gift: boolean
    quantity_on_hand: string | number
  }

  const plans: Array<{
    requirement: PickupCompositionComponent & { quantity: number }
    lotRows: LotRow[]
    availableByLot: Map<number, number>
  }> = []
  // 固定锁顺序，避免两个不同销售商品包含相同库存 SKU 时形成交叉死锁。
  for (const requirement of data.requirements) {
    const lotRows = (await tx.execute(sql`
      SELECT lot.id, lot.location_id, lot.sku_id, lot.sku_name, lot.spec_name,
             lot.supplier, lot.product_series, lot.batch_no, lot.expiry_date,
             lot.is_gift, lot.quantity_on_hand
        FROM inventory_stock_lots lot
       WHERE lot.location_id = ${data.storeId}
         AND lot.sku_id = ${requirement.inventorySkuId}
         AND lot.quantity_on_hand > 0
    ORDER BY lot.expiry_date NULLS LAST, lot.id
       FOR UPDATE
    `)) as unknown as LotRow[]
    const lotIds = lotRows.map((row) => row.id)
    const reservationRows = lotIds.length === 0
      ? []
      : (await tx.execute(sql`
          SELECT lot_id,
                 COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
            FROM inventory_stock_reservations
           WHERE lot_id = ANY(${lotIds}::bigint[])
             AND status = '已预留'
        GROUP BY lot_id
        `)) as unknown as Array<{ lot_id: number; quantity: string | number }>
    const reservedByLot = new Map(reservationRows.map((row) => [Number(row.lot_id), Number(row.quantity)]))
    const availableByLot = new Map(
      lotRows.map((row) => [row.id, Math.max(0, Number(row.quantity_on_hand) - (reservedByLot.get(row.id) ?? 0))]),
    )
    const available = [...availableByLot.values()].reduce((acc, quantity) => acc + quantity, 0)
    if (available < requirement.quantity) {
      throw new ApiError(
        'INVALID_STATE',
        `库存商品「${requirement.productName}」不足，需要 ${requirement.quantity}，当前可用 ${available}`,
      )
    }
    plans.push({ requirement, lotRows, availableByLot })
  }

  const docId = await generatePickupInventoryDocNo(tx)
  const totalQuantity = data.requirements.reduce((sum, requirement) => sum + requirement.quantity, 0)
  await tx.execute(sql`
    INSERT INTO inventory_docs (
      id, doc_type, status, source_location_id, doc_date, total_quantity,
      related_sale_order_id, client_user_id, customer_name,
      remark, created_by, confirmed_by, confirmed_at
    )
    VALUES (
      ${docId}, '院顾客产品出库', '已完成', ${data.storeId}, ${shanghaiToday()}, ${totalQuantity},
      ${data.saleOrderId}, ${data.clientUserId}, ${data.customerName},
      ${data.remark?.trim() || null}, ${session.employeeId}, ${session.employeeId}, NOW()
    )
  `)

  let itemSeq = 0
  for (const plan of plans) {
    let remaining = plan.requirement.quantity
    for (const lot of plan.lotRows) {
      if (remaining <= 0) break
      const before = Number(lot.quantity_on_hand)
      const deduct = Math.min(plan.availableByLot.get(lot.id) ?? 0, remaining)
      if (deduct <= 0) continue
      const after = before - deduct
      const inserted = (await tx.execute(sql`
      INSERT INTO inventory_doc_items (
        doc_id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier,
        product_series, batch_no, expiry_date, is_gift, quantity, stock_snapshot, remark
      )
      VALUES (
        ${docId}, ${lot.id}, ${lot.sku_id}, ${data.saleItemId},
        ${lot.sku_name || plan.requirement.productName || data.productName || plan.requirement.inventorySkuId}, ${lot.spec_name}, ${lot.supplier},
        ${lot.product_series}, ${lot.batch_no || ''}, ${lot.expiry_date}, ${Boolean(lot.is_gift)},
        ${deduct}, ${before}, ${data.remark?.trim() || null}
      )
      RETURNING id
      `)) as unknown as Array<{ id: number }>
      const docItemId = inserted[0].id
      await tx.execute(sql`
      INSERT INTO inventory_movements (
        movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id,
        direction, quantity_delta,
        quantity_before, quantity_after, created_by, remark
      )
      VALUES (
        ${`pickup:${data.saleItemId}:${data.idempotencyKey || docId}:${itemSeq++}`},
        ${lot.id}, ${data.storeId}, ${lot.sku_id}, ${docId}, ${docItemId},
        '出库', ${-deduct},
        ${before}, ${after}, ${session.employeeId}, ${data.remark?.trim() || null}
      )
      `)
      remaining -= deduct
    }
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
      inventorySkuName: inventorySkus.productName,
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
    .leftJoin(inventorySkus, eq(pickupRecords.inventorySkuId, inventorySkus.skuId))
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
      inventorySkuId: r.record.inventorySkuId ?? undefined,
      inventorySkuName: r.inventorySkuName ?? undefined,
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
      inventorySkuName: inventorySkus.productName,
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
    .leftJoin(inventorySkus, eq(pickupRecords.inventorySkuId, inventorySkus.skuId))
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
    inventorySkuId: r.record.inventorySkuId ?? undefined,
    inventorySkuName: r.inventorySkuName ?? undefined,
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
  skuId: string | null
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
      MIN(si.sku_id) AS sku_id,
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
    skuId: (r.sku_id as string | null) ?? null,
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

export interface PickupInventorySkuOption {
  inventorySkuId: string
  productCode: string
  productName: string
  specName: string | null
  quantityPerSaleUnit: number
  availableQuantity: number
  label: string
}

/**
 * 返回一条销售明细冻结的库存组成；历史空快照读取当前最新配置。库存可用量已扣除预留。
 * 管理后台允许跨店提货，因此只以传入的实际提货门店计算库存，不限制原销售门店。
 */
export const getPickupInventorySkuOptions = withPermission(
  'pickup_record:create',
  async (session, saleItemId: string, storeId: string): Promise<PickupInventorySkuOption[]> => {
    if (!saleItemId || !storeId) throw new ApiError('INVALID_PARAMS', '缺少销售明细号或提货门店')
    if (!isInScope(session, storeId)) throw new ApiError('PERMISSION_DENIED', '无权查询该门店库存')

    const itemRows = (await db.execute(sql`
      SELECT sale_item.sku_id, sale_item.inventory_composition_snapshot
        FROM sale_items sale_item
        JOIN sale_orders sale_order ON sale_order.sale_order_id = sale_item.sale_order_id
       WHERE sale_item.sale_item_id = ${saleItemId}
         AND sale_order.status = '已支付'
         AND sale_item.item_direction = '购买'
         AND sale_item.product_type = '家居产品'
         AND sale_item.quantity > COALESCE(sale_item.picked_up_quantity, 0)
       LIMIT 1
    `)) as unknown as Array<{ sku_id: string | null; inventory_composition_snapshot: unknown }>
    const item = itemRows[0]
    if (!item) throw new ApiError('NOT_FOUND', '没有可提货的家居产品')
    const components = await resolvePickupComposition(db, {
      skuId: item.sku_id,
      inventoryCompositionSnapshot: item.inventory_composition_snapshot,
    })
    const inventorySkuIds = components.map((component) => component.inventorySkuId)
    const availabilityRows = (await db.execute(sql`
      SELECT inventory.sku_id,
             COALESCE(SUM(GREATEST(0, lot.quantity_on_hand - COALESCE(reserved.quantity, 0))), 0) AS available_quantity
        FROM inventory_skus inventory
   LEFT JOIN inventory_stock_lots lot
          ON lot.sku_id = inventory.sku_id
         AND lot.location_id = ${storeId}
         AND lot.quantity_on_hand > 0
   LEFT JOIN (
          SELECT lot_id, COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
            FROM inventory_stock_reservations
           WHERE status = '已预留'
        GROUP BY lot_id
   ) reserved ON reserved.lot_id = lot.id
       WHERE inventory.sku_id = ANY(${inventorySkuIds}::text[])
    GROUP BY inventory.sku_id
    `)) as unknown as Array<{ sku_id: string; available_quantity: string | number }>
    const availableBySku = new Map(availabilityRows.map((row) => [row.sku_id, Number(row.available_quantity)]))
    return components.map((component) => {
      const availableQuantity = availableBySku.get(component.inventorySkuId) ?? 0
      return {
        ...component,
        availableQuantity,
        label: `${component.productName}${component.specName ? ` ${component.specName}` : ''} × ${component.quantityPerSaleUnit}（可用 ${availableQuantity}）`,
      }
    })
  },
)

/**
 * 为同一销售行组拆出的多条家居明细创建一次提货。
 *
 * 实际库存始终按下单快照（历史空快照按最新组成）和批次库存扣减；一张出库单汇总本次提货，提货记录
 * 与 sale_items.picked_up_quantity 则逐条写入，以保留退款级联和库存审计的可追溯性。
 */
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
  if (sourceIds.length < 2 || !Number.isInteger(data.pickupQuantity) || data.pickupQuantity > sourceIds.length) {
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
             si.inventory_composition_snapshot,
             o.client_user_id, o.customer_name
        FROM sale_items si
        JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       WHERE si.sale_item_id IN (${sourceIdList})
         AND si.product_type = '家居产品'
         AND si.item_direction = '购买'
       FOR UPDATE OF si
    `)) as unknown as Array<{
      sale_item_id: string
      sale_item_group_id: string | null
      sale_order_id: string
      sku_id: string | null
      product_name: string | null
      quantity: number
      picked_up_quantity: number
      inventory_composition_snapshot: unknown
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
    if (await hasPendingRefund(tx, first.sale_order_id)) {
      throw new ApiError('INVALID_STATE', '该订单退款审批中，暂不可提货')
    }

    const selected = locked.slice(0, data.pickupQuantity)
    const requirements = await buildPickupRequirements(tx, selected.map((item) => ({
      skuId: item.sku_id,
      inventoryCompositionSnapshot: item.inventory_composition_snapshot,
      pickupUnits: 1,
    })))
    const inventoryDocId = await createPickupInventoryDoc(tx, session, {
      storeId: data.storeId,
      saleItemId: first.sale_item_id,
      saleOrderId: first.sale_order_id,
      productName: first.product_name,
      clientUserId: data.clientUserId ?? first.client_user_id,
      customerName: first.customer_name,
      requirements,
      remark: data.remark,
      idempotencyKey: idemKey,
    })

    const pickupRecordIds: number[] = []
    for (const item of selected) {
      const updated = (await tx.execute(sql`
        UPDATE sale_items
           SET picked_up_quantity = 1, updated_at = NOW()
         WHERE sale_item_id = ${item.sale_item_id}
           AND COALESCE(picked_up_quantity, 0) = 0
        RETURNING sale_item_id
      `)) as unknown as Array<{ sale_item_id: string }>
      if (updated.length !== 1) throw new ApiError('CONFLICT', '家居产品状态已更新，请刷新后重试')

      const inserted = await tx.insert(pickupRecords).values({
        saleItemId: item.sale_item_id,
        inventorySkuId: null,
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
      inventoryDocId,
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
      /** @deprecated 兼容旧调用方，服务端按销售商品组成自动出库。 */
      inventorySkuId?: string
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
        inventoryMode: 'composition',
        storeId: data.storeId,
        clientUserId: data.clientUserId,
        inventoryDocId: created.inventoryDocId || null,
      })
      revalidatePath('/pickup-records')
      return {
        success: true,
        message: created.inventoryDocId ? '提货记录创建成功' : '提货记录已存在（幂等）',
        createdId: created.pickupRecordId,
      }
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
        RETURNING sale_item_id, sale_order_id, sku_id, product_name, quantity, picked_up_quantity,
                  inventory_composition_snapshot
      `)
      const updatedRows = updated as unknown as Array<{
        sale_item_id: string
        sale_order_id: string
        sku_id: string | null
        product_name: string | null
        quantity: number
        picked_up_quantity: number
        inventory_composition_snapshot: unknown
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
      const requirements = await buildPickupRequirements(tx, [{
        skuId: updatedItem.sku_id,
        inventoryCompositionSnapshot: updatedItem.inventory_composition_snapshot,
        pickupUnits: data.pickupQuantity,
      }])

      const inventoryDocId = await createPickupInventoryDoc(tx, session, {
        storeId: data.storeId,
        saleItemId: updatedItem.sale_item_id,
        saleOrderId: updatedItem.sale_order_id,
        productName: updatedItem.product_name,
        clientUserId: data.clientUserId ?? orderInfo.client_user_id,
        customerName: orderInfo.customer_name,
        requirements,
        remark: data.remark,
        idempotencyKey: idemKey,
      })

      // 2. 插入 pickup_records；DB 层 uq_pickup_idempotency 兜底 race，命中即整事务回滚防 UPDATE 重复累加
      try {
        const inserted = await tx
          .insert(pickupRecords)
          .values({
            saleItemId: data.saleItemId,
            inventorySkuId: null,
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
      inventoryMode: 'composition',
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
