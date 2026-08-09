'use server'

import { db } from '@/db'
import { ApiError } from '@/lib/api-error'
import { nowTs } from '@/lib/db-time'
import { shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import {
  offsetPageResult,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { logOperation } from '@/lib/operation-log'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { hasPermission, isInScope, scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { stores } from '@db/org'
import { productSkus } from '@db/product'
import {
  storeInventoryDocItems,
  storeInventoryDocs,
  storeInventoryMovements,
  storeInventoryStocks,
} from '@db/inventory'
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export type StoreInventoryDocType =
  | '院报货'
  | '院入库'
  | '院顾客退货'
  | '院顾客产品出库'
  | '院退货'
  | '院产品报损'
  | '分院调货出库'
  | '分院调货入库'
  | '期初库存'

export type StoreInventoryDocStatus =
  | '草稿'
  | '待审批'
  | '待收货'
  | '已完成'
  | '已驳回'
  | '已取消'

export interface StoreInventoryStockRow {
  id: number
  storeId: string
  storeName: string | null
  skuId: string
  skuName: string
  productType: string
  batchNo: string
  expiryDate: string | null
  quantityOnHand: number
  lastUnitPrice?: number | null
  lastAmount?: number | null
  remark: string | null
  updatedAt: string
}

export interface StoreInventoryDocRow {
  id: string
  docType: StoreInventoryDocType
  status: StoreInventoryDocStatus
  storeId: string
  storeName: string | null
  counterpartStoreId: string | null
  docDate: string
  totalQuantity: number
  requestDocId: string | null
  relatedSaleOrderId: string | null
  customerName: string | null
  receiptAttachmentUrl: string | null
  remark: string | null
  createdBy: string
  confirmedAt: string | null
  approvedAt: string | null
  rejectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface StoreInventoryDocItemRow {
  id: number
  docId: string
  stockId: number | null
  skuId: string
  saleItemId: string | null
  skuName: string
  batchNo: string
  expiryDate: string | null
  quantity: number
  stockSnapshot: number | null
  unitPrice?: number | null
  amount?: number | null
  requestQuantity: number | null
  fulfilledQuantity: number | null
  scrapReason: string | null
  itemUsage: string | null
  remark: string | null
  createdAt: string
}

export interface StoreInventoryDocDetail extends StoreInventoryDocRow {
  items: StoreInventoryDocItemRow[]
}

export interface StoreInventoryDocItemInput {
  stockId?: number | null
  skuId?: string | null
  saleItemId?: string | null
  batchNo?: string | null
  expiryDate?: string | null
  quantity: number
  unitPrice?: number | null
  amount?: number | null
  requestQuantity?: number | null
  fulfilledQuantity?: number | null
  scrapReason?: string | null
  itemUsage?: string | null
  remark?: string | null
}

export interface CreateStoreInventoryDocInput {
  docType: StoreInventoryDocType
  storeId: string
  counterpartStoreId?: string | null
  docDate?: string | null
  status?: StoreInventoryDocStatus
  requestDocId?: string | null
  relatedSaleOrderId?: string | null
  clientUserId?: string | null
  customerName?: string | null
  receiptAttachmentUrl?: string | null
  remark?: string | null
  items: StoreInventoryDocItemInput[]
}

interface LockedStock {
  id: number
  storeId: string
  skuId: string
  skuName: string
  productType: string
  batchNo: string
  expiryDate: string | null
  quantityOnHand: number
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const DOC_PREFIX: Record<StoreInventoryDocType, string> = {
  院报货: 'YBH',
  院入库: 'YRK',
  院顾客退货: 'GTH',
  院顾客产品出库: 'GCK',
  院退货: 'YTH',
  院产品报损: 'YBS',
  分院调货出库: 'DBO',
  分院调货入库: 'DBI',
  期初库存: 'QC',
}

function normalizeBatchNo(batchNo: string | null | undefined): string {
  return batchNo?.trim() || ''
}

function normalizeDateKey(expiryDate: string | null | undefined): string {
  return expiryDate?.trim() || ''
}

function assertPositiveQuantity(quantity: number): number {
  const n = Number(quantity)
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError('INVALID_PARAMS', '明细数量必须大于 0')
  }
  return n
}

function canViewPrice(session: Parameters<typeof hasPermission>[0]): boolean {
  return hasPermission(session, 'inventory:price_view')
}

function defaultStatusForDoc(docType: StoreInventoryDocType): StoreInventoryDocStatus {
  if (docType === '院退货' || docType === '院产品报损') return '待审批'
  if (docType === '分院调货出库') return '待收货'
  return '已完成'
}

function movementDirection(docType: StoreInventoryDocType): '入库' | '出库' | null {
  if (
    docType === '院入库' ||
    docType === '院顾客退货' ||
    docType === '分院调货入库' ||
    docType === '期初库存'
  ) {
    return '入库'
  }
  if (docType === '院顾客产品出库' || docType === '分院调货出库') return '出库'
  return null
}

function approvalMovementDirection(docType: StoreInventoryDocType): '出库' | null {
  if (docType === '院退货' || docType === '院产品报损') return '出库'
  return null
}

async function generateStoreInventoryDocNo(tx: Tx, docType: StoreInventoryDocType): Promise<string> {
  const prefix = DOC_PREFIX[docType]
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`store_inventory_docs:${prefix}:${ymd}`}))`)
  const rows = await tx.execute(sql`
    SELECT id
      FROM store_inventory_docs
     WHERE id LIKE ${`${prefix}-${ymd}-%`}
  ORDER BY id DESC
     LIMIT 1
  `)
  const latest = (rows as unknown as Array<{ id: string }>)[0]?.id
  const seq = latest ? Number(latest.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function lockStockById(tx: Tx, stockId: number, storeId: string): Promise<LockedStock> {
  const rows = await tx.execute(sql`
    SELECT id, store_id, sku_id, sku_name, product_type, batch_no, expiry_date, quantity_on_hand
      FROM store_inventory_stocks
     WHERE id = ${stockId} AND store_id = ${storeId}
     FOR UPDATE
  `)
  const row = (rows as unknown as Array<{
    id: number
    store_id: string
    sku_id: string
    sku_name: string
    product_type: string
    batch_no: string | null
    expiry_date: string | null
    quantity_on_hand: string | number
  }>)[0]
  if (!row) throw new ApiError('NOT_FOUND', '库存记录不存在或不属于当前门店')
  return {
    id: Number(row.id),
    storeId: row.store_id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    productType: row.product_type,
    batchNo: row.batch_no ?? '',
    expiryDate: row.expiry_date,
    quantityOnHand: Number(row.quantity_on_hand),
  }
}

async function ensureStockFromSku(
  tx: Tx,
  storeId: string,
  item: StoreInventoryDocItemInput,
): Promise<LockedStock> {
  if (item.stockId) return lockStockById(tx, item.stockId, storeId)
  const skuId = item.skuId?.trim()
  if (!skuId) throw new ApiError('INVALID_PARAMS', '缺少 SKU 或库存记录')

  const skuRows = await tx.execute(sql`
    SELECT sku_id, spec_name, product_type
      FROM product_skus
     WHERE sku_id = ${skuId} AND deleted_at IS NULL
     LIMIT 1
  `)
  const sku = (skuRows as unknown as Array<{
    sku_id: string
    spec_name: string
    product_type: string
  }>)[0]
  if (!sku) throw new ApiError('NOT_FOUND', 'SKU 不存在或已删除')

  const batchNo = normalizeBatchNo(item.batchNo)
  const expiryDate = item.expiryDate?.trim() || null
  const expiryDateKey = normalizeDateKey(expiryDate)
  const rows = await tx.execute(sql`
    INSERT INTO store_inventory_stocks (
      store_id, sku_id, sku_name, product_type, batch_no, expiry_date, expiry_date_key, quantity_on_hand
    )
    VALUES (
      ${storeId}, ${sku.sku_id}, ${sku.spec_name}, ${sku.product_type}, ${batchNo}, ${expiryDate}, ${expiryDateKey}, 0
    )
    ON CONFLICT (store_id, sku_id, batch_no, expiry_date_key)
    DO UPDATE SET
      sku_name = EXCLUDED.sku_name,
      product_type = EXCLUDED.product_type,
      updated_at = NOW()
    RETURNING id, store_id, sku_id, sku_name, product_type, batch_no, expiry_date, quantity_on_hand
  `)
  const row = (rows as unknown as Array<{
    id: number
    store_id: string
    sku_id: string
    sku_name: string
    product_type: string
    batch_no: string | null
    expiry_date: string | null
    quantity_on_hand: string | number
  }>)[0]

  return lockStockById(tx, Number(row.id), storeId)
}

async function applyStockMovement(
  tx: Tx,
  params: {
    stock: LockedStock
    docId: string
    docItemId: number
    direction: '入库' | '出库'
    quantity: number
    createdBy: string
    movementKey: string
    saleOrderId?: string | null
    saleItemId?: string | null
    unitPrice?: number | null
    amount?: number | null
    remark?: string | null
  },
): Promise<{ before: number; after: number }> {
  const before = params.stock.quantityOnHand
  const delta = params.direction === '入库' ? params.quantity : -params.quantity
  const after = before + delta
  if (after < 0) {
    throw new ApiError('INVALID_STATE', `库存不足：${params.stock.skuName} 当前 ${before}`)
  }

  await tx.execute(sql`
    UPDATE store_inventory_stocks
       SET quantity_on_hand = ${after},
           last_unit_price = COALESCE(${params.unitPrice ?? null}, last_unit_price),
           last_amount = COALESCE(${params.amount ?? null}, last_amount),
           updated_at = NOW()
     WHERE id = ${params.stock.id}
  `)
  await tx.execute(sql`
    INSERT INTO store_inventory_movements (
      movement_key, stock_id, store_id, sku_id, doc_id, doc_item_id,
      sale_order_id, sale_item_id, direction, quantity_delta,
      quantity_before, quantity_after, created_by, remark
    )
    VALUES (
      ${params.movementKey}, ${params.stock.id}, ${params.stock.storeId}, ${params.stock.skuId},
      ${params.docId}, ${params.docItemId}, ${params.saleOrderId ?? null}, ${params.saleItemId ?? null},
      ${params.direction}, ${delta}, ${before}, ${after}, ${params.createdBy}, ${params.remark ?? null}
    )
  `)

  params.stock.quantityOnHand = after
  return { before, after }
}

function rowToStock(
  row: {
    stock: typeof storeInventoryStocks.$inferSelect
    storeName: string | null
  },
  includePrice: boolean,
): StoreInventoryStockRow {
  const stock = row.stock
  return {
    id: stock.id,
    storeId: stock.storeId,
    storeName: row.storeName,
    skuId: stock.skuId,
    skuName: stock.skuName,
    productType: stock.productType,
    batchNo: stock.batchNo,
    expiryDate: stock.expiryDate,
    quantityOnHand: Number(stock.quantityOnHand),
    lastUnitPrice: includePrice && stock.lastUnitPrice != null ? Number(stock.lastUnitPrice) : undefined,
    lastAmount: includePrice && stock.lastAmount != null ? Number(stock.lastAmount) : undefined,
    remark: stock.remark,
    updatedAt: stock.updatedAt.toISOString(),
  }
}

function rowToDoc(row: {
  doc: typeof storeInventoryDocs.$inferSelect
  storeName: string | null
}): StoreInventoryDocRow {
  const doc = row.doc
  return {
    id: doc.id,
    docType: doc.docType,
    status: doc.status,
    storeId: doc.storeId,
    storeName: row.storeName,
    counterpartStoreId: doc.counterpartStoreId,
    docDate: doc.docDate,
    totalQuantity: Number(doc.totalQuantity),
    requestDocId: doc.requestDocId,
    relatedSaleOrderId: doc.relatedSaleOrderId,
    customerName: doc.customerName,
    receiptAttachmentUrl: doc.receiptAttachmentUrl,
    remark: doc.remark,
    createdBy: doc.createdBy,
    confirmedAt: doc.confirmedAt?.toISOString() ?? null,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    rejectedAt: doc.rejectedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export const listInventoryStocks = withPermission(
  'inventory:stock_list',
  async (
    session,
    filters: {
      marketId?: string
      storeId?: string
      skuId?: string
      keyword?: string
      onlyPositive?: boolean
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: StoreInventoryStockRow[]; total: number; canViewPrice: boolean }> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0)
      ? filters.pageSize!
      : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, storeInventoryStocks.storeId),
    ]
    if (filters.marketId) conditions.push(storeInMarketCondition(storeInventoryStocks.storeId, filters.marketId))
    if (filters.storeId) conditions.push(eq(storeInventoryStocks.storeId, filters.storeId))
    if (filters.skuId) conditions.push(eq(storeInventoryStocks.skuId, filters.skuId))
    if (filters.onlyPositive) conditions.push(sql`${storeInventoryStocks.quantityOnHand} > 0`)
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(storeInventoryStocks.skuName, pattern),
          ilike(storeInventoryStocks.skuId, pattern),
          ilike(productSkus.specName, pattern),
          ilike(storeInventoryStocks.batchNo, pattern),
        ),
      )
    }
    const whereClause = and(...conditions)
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(storeInventoryStocks)
      .leftJoin(productSkus, eq(storeInventoryStocks.skuId, productSkus.skuId))
      .where(whereClause)
    const rows = await db
      .select({
        stock: storeInventoryStocks,
        storeName: stores.storeName,
      })
      .from(storeInventoryStocks)
      .leftJoin(stores, eq(storeInventoryStocks.storeId, stores.storeId))
      .leftJoin(productSkus, eq(storeInventoryStocks.skuId, productSkus.skuId))
      .where(whereClause)
      .orderBy(asc(stores.storeName), asc(storeInventoryStocks.skuName), asc(storeInventoryStocks.batchNo))
      .limit(pageSize)
      .offset(offset)

    const priceVisible = canViewPrice(session)
    return {
      data: rows.map((row) => rowToStock(row, priceVisible)),
      total: countRow?.count ?? 0,
      canViewPrice: priceVisible,
    }
  },
)

export const exportInventoryStocks = withPermission(
  'inventory:export',
  async (
    session,
    params: Record<string, string | undefined> = {},
    options?: ExportBatchOptions,
  ): Promise<ExportBatchResult<StoreInventoryStockRow> & { canViewPrice: boolean }> => {
    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, storeInventoryStocks.storeId),
    ]
    if (params.marketId) conditions.push(storeInMarketCondition(storeInventoryStocks.storeId, params.marketId))
    if (params.storeId) conditions.push(eq(storeInventoryStocks.storeId, params.storeId))
    if (params.skuId) conditions.push(eq(storeInventoryStocks.skuId, params.skuId))
    if (params.onlyPositive === '1') conditions.push(sql`${storeInventoryStocks.quantityOnHand} > 0`)
    if (params.keyword) {
      const pattern = `%${params.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(storeInventoryStocks.skuName, pattern),
          ilike(storeInventoryStocks.skuId, pattern),
          ilike(productSkus.specName, pattern),
          ilike(storeInventoryStocks.batchNo, pattern),
        ),
      )
    }
    const page = resolveExportOffsetPage(options)
    const query = db
      .select({
        stock: storeInventoryStocks,
        storeName: stores.storeName,
      })
      .from(storeInventoryStocks)
      .leftJoin(stores, eq(storeInventoryStocks.storeId, stores.storeId))
      .leftJoin(productSkus, eq(storeInventoryStocks.skuId, productSkus.skuId))
      .where(and(...conditions))
      .orderBy(
        asc(stores.storeName),
        asc(storeInventoryStocks.skuName),
        asc(storeInventoryStocks.batchNo),
        asc(storeInventoryStocks.id),
      )
    const rows = page
      ? await query.limit(page.limit + 1).offset(page.offset)
      : await query
    const priceVisible = canViewPrice(session)
    return {
      ...offsetPageResult(rows.map((row) => rowToStock(row, priceVisible)), page),
      canViewPrice: priceVisible,
    }
  },
)

export const listInventoryDocs = withPermission(
  'inventory:list',
  async (
    session,
    filters: {
      storeId?: string
      docType?: StoreInventoryDocType
      status?: StoreInventoryDocStatus
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: StoreInventoryDocRow[]; total: number }> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = [
      scopeCondition(session, storeInventoryDocs.storeId),
    ]
    if (filters.storeId) conditions.push(eq(storeInventoryDocs.storeId, filters.storeId))
    if (filters.docType) conditions.push(eq(storeInventoryDocs.docType, filters.docType))
    if (filters.status) conditions.push(eq(storeInventoryDocs.status, filters.status))
    if (filters.startDate) conditions.push(gte(storeInventoryDocs.docDate, filters.startDate))
    if (filters.endDate) conditions.push(lte(storeInventoryDocs.docDate, filters.endDate))
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(storeInventoryDocs.id, pattern),
          ilike(storeInventoryDocs.customerName, pattern),
          ilike(storeInventoryDocs.relatedSaleOrderId, pattern),
          ilike(storeInventoryDocs.remark, pattern),
        ),
      )
    }
    const whereClause = and(...conditions)
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(storeInventoryDocs)
      .where(whereClause)
    const rows = await db
      .select({ doc: storeInventoryDocs, storeName: stores.storeName })
      .from(storeInventoryDocs)
      .leftJoin(stores, eq(storeInventoryDocs.storeId, stores.storeId))
      .where(whereClause)
      .orderBy(desc(storeInventoryDocs.docDate), desc(storeInventoryDocs.createdAt))
      .limit(pageSize)
      .offset(offset)
    return { data: rows.map(rowToDoc), total: countRow?.count ?? 0 }
  },
)

export const getInventoryDocById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<StoreInventoryDocDetail | null> => {
    const [head] = await db
      .select({ doc: storeInventoryDocs, storeName: stores.storeName })
      .from(storeInventoryDocs)
      .leftJoin(stores, eq(storeInventoryDocs.storeId, stores.storeId))
      .where(and(eq(storeInventoryDocs.id, id), scopeCondition(session, storeInventoryDocs.storeId)))
      .limit(1)
    if (!head) return null

    const items = await db
      .select()
      .from(storeInventoryDocItems)
      .where(eq(storeInventoryDocItems.docId, id))
      .orderBy(asc(storeInventoryDocItems.id))
    const priceVisible = canViewPrice(session)
    return {
      ...rowToDoc(head),
      items: items.map((item) => ({
        id: item.id,
        docId: item.docId,
        stockId: item.stockId,
        skuId: item.skuId,
        saleItemId: item.saleItemId,
        skuName: item.skuName,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        quantity: Number(item.quantity),
        stockSnapshot: item.stockSnapshot == null ? null : Number(item.stockSnapshot),
        unitPrice: priceVisible && item.unitPrice != null ? Number(item.unitPrice) : undefined,
        amount: priceVisible && item.amount != null ? Number(item.amount) : undefined,
        requestQuantity: item.requestQuantity == null ? null : Number(item.requestQuantity),
        fulfilledQuantity: item.fulfilledQuantity == null ? null : Number(item.fulfilledQuantity),
        scrapReason: item.scrapReason,
        itemUsage: item.itemUsage,
        remark: item.remark,
        createdAt: item.createdAt.toISOString(),
      })),
    }
  },
)

export const createInventoryDoc = withPermission(
  'inventory:create_doc',
  async (session, input: CreateStoreInventoryDocInput): Promise<{ success: true; id: string }> => {
    if (!input.storeId) throw new ApiError('INVALID_PARAMS', '缺少门店')
    if (!isInScope(session, input.storeId)) throw new ApiError('PERMISSION_DENIED', '无权操作该门店库存')
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ApiError('INVALID_PARAMS', '库存单据至少需要一条明细')
    }
    if (input.counterpartStoreId && input.counterpartStoreId === input.storeId) {
      throw new ApiError('INVALID_PARAMS', '调拨门店不能与当前门店相同')
    }

    const status = input.status ?? defaultStatusForDoc(input.docType)
    const totalQuantity = input.items.reduce((acc, item) => acc + assertPositiveQuantity(item.quantity), 0)
    const id = await db.transaction(async (tx) => {
      const docId = await generateStoreInventoryDocNo(tx, input.docType)
      await tx.insert(storeInventoryDocs).values({
        id: docId,
        docType: input.docType,
        status,
        storeId: input.storeId,
        counterpartStoreId: input.counterpartStoreId?.trim() || null,
        docDate: input.docDate?.trim() || shanghaiToday(),
        totalQuantity: String(totalQuantity),
        requestDocId: input.requestDocId?.trim() || null,
        relatedSaleOrderId: input.relatedSaleOrderId?.trim() || null,
        clientUserId: input.clientUserId?.trim() || null,
        customerName: input.customerName?.trim() || null,
        receiptAttachmentUrl: input.receiptAttachmentUrl?.trim() || null,
        remark: input.remark?.trim() || null,
        createdBy: session.employeeId,
        confirmedBy: status === '已完成' || status === '待收货' ? session.employeeId : null,
        confirmedAt: status === '已完成' || status === '待收货' ? nowTs() : null,
      })

      const direction = status === '草稿' || status === '待审批'
        ? null
        : movementDirection(input.docType)
      for (const item of input.items) {
        const qty = assertPositiveQuantity(item.quantity)
        const stock = await ensureStockFromSku(tx, input.storeId, item)
        const amount = item.amount ?? (item.unitPrice == null ? null : Number(item.unitPrice) * qty)
        const [createdItem] = await tx
          .insert(storeInventoryDocItems)
          .values({
            docId,
            stockId: stock.id,
            skuId: stock.skuId,
            saleItemId: item.saleItemId?.trim() || null,
            skuName: stock.skuName,
            batchNo: stock.batchNo,
            expiryDate: stock.expiryDate,
            quantity: String(qty),
            stockSnapshot: String(stock.quantityOnHand),
            unitPrice: item.unitPrice == null ? null : String(item.unitPrice),
            amount: amount == null ? null : String(amount),
            requestQuantity: item.requestQuantity == null ? null : String(item.requestQuantity),
            fulfilledQuantity: item.fulfilledQuantity == null ? null : String(item.fulfilledQuantity),
            scrapReason: item.scrapReason?.trim() || null,
            itemUsage: item.itemUsage?.trim() || null,
            remark: item.remark?.trim() || null,
          })
          .returning({ id: storeInventoryDocItems.id })
        if (direction) {
          await applyStockMovement(tx, {
            stock,
            docId,
            docItemId: createdItem.id,
            direction,
            quantity: qty,
            createdBy: session.employeeId,
            movementKey: `doc:${docId}:item:${createdItem.id}`,
            saleOrderId: input.relatedSaleOrderId ?? null,
            saleItemId: item.saleItemId ?? null,
            unitPrice: item.unitPrice ?? null,
            amount,
            remark: input.remark ?? null,
          })
        }
      }
      return docId
    })

    await logOperation(session, 'create', 'store_inventory_doc', id, {
      docType: input.docType,
      storeId: input.storeId,
      totalQuantity,
    })
    revalidatePath('/inventory')
    revalidatePath('/inventory/stocks')
    return { success: true, id }
  },
)

export const approveInventoryDoc = withPermission(
  'inventory:approve',
  async (session, id: string, auditRemark?: string | null): Promise<{ success: boolean; message: string }> => {
    const doc = await getInventoryDocById(id as never)
    if (!doc) return { success: false, message: '单据不存在或无权限' }
    if (doc.status !== '待审批') return { success: false, message: '只有待审批单据可以审批' }
    const direction = approvalMovementDirection(doc.docType)
    if (!direction) return { success: false, message: '该单据类型不需要审批扣减库存' }

    await db.transaction(async (tx) => {
      const headRows = await tx.execute(sql`
        SELECT id, doc_type, status, store_id, related_sale_order_id
          FROM store_inventory_docs
         WHERE id = ${id}
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        doc_type: StoreInventoryDocType
        status: StoreInventoryDocStatus
        store_id: string
        related_sale_order_id: string | null
      }>)[0]
      if (!head || head.status !== '待审批') {
        throw new ApiError('INVALID_STATE', '单据状态已变化，请刷新后重试')
      }
      const itemRows = await tx.execute(sql`
        SELECT id, stock_id, sku_id, quantity, unit_price, amount, sale_item_id
          FROM store_inventory_doc_items
         WHERE doc_id = ${id}
         ORDER BY id
      `)
      for (const item of itemRows as unknown as Array<{
        id: number
        stock_id: number
        sku_id: string
        quantity: string | number
        unit_price: string | number | null
        amount: string | number | null
        sale_item_id: string | null
      }>) {
        if (!item.stock_id) throw new ApiError('INVALID_STATE', '单据明细缺少库存记录')
        const stock = await lockStockById(tx, Number(item.stock_id), head.store_id)
        await applyStockMovement(tx, {
          stock,
          docId: id,
          docItemId: Number(item.id),
          direction,
          quantity: Number(item.quantity),
          createdBy: session.employeeId,
          movementKey: `approve:${id}:item:${item.id}`,
          saleOrderId: head.related_sale_order_id,
          saleItemId: item.sale_item_id,
          unitPrice: item.unit_price == null ? null : Number(item.unit_price),
          amount: item.amount == null ? null : Number(item.amount),
          remark: auditRemark ?? null,
        })
      }
      await tx
        .update(storeInventoryDocs)
        .set({
          status: '已完成',
          approvedBy: session.employeeId,
          approvedAt: nowTs(),
          auditRemark: auditRemark?.trim() || null,
          updatedAt: nowTs(),
        })
        .where(eq(storeInventoryDocs.id, id))
    })

    await logOperation(session, 'approve', 'store_inventory_doc', id, { auditRemark })
    revalidatePath('/inventory')
    revalidatePath('/inventory/stocks')
    return { success: true, message: '审批通过' }
  },
)

export const rejectInventoryDoc = withPermission(
  'inventory:approve',
  async (session, id: string, auditRemark?: string | null): Promise<{ success: boolean; message: string }> => {
    const [doc] = await db
      .select({ storeId: storeInventoryDocs.storeId, status: storeInventoryDocs.status })
      .from(storeInventoryDocs)
      .where(and(eq(storeInventoryDocs.id, id), scopeCondition(session, storeInventoryDocs.storeId)))
      .limit(1)
    if (!doc) return { success: false, message: '单据不存在或无权限' }
    if (doc.status !== '待审批') return { success: false, message: '只有待审批单据可以驳回' }
    await db
      .update(storeInventoryDocs)
      .set({
        status: '已驳回',
        rejectedBy: session.employeeId,
        rejectedAt: nowTs(),
        auditRemark: auditRemark?.trim() || null,
        updatedAt: nowTs(),
      })
      .where(eq(storeInventoryDocs.id, id))
    await logOperation(session, 'reject', 'store_inventory_doc', id, { auditRemark })
    revalidatePath('/inventory')
    return { success: true, message: '已驳回' }
  },
)

export const confirmInventoryReceive = withPermission(
  'inventory:create_doc',
  async (session, outboundDocId: string, remark?: string | null): Promise<{ success: true; inboundDocId: string }> => {
    const inboundDocId = await db.transaction(async (tx) => {
      const headRows = await tx.execute(sql`
        SELECT id, status, store_id, counterpart_store_id, doc_date, total_quantity, remark
          FROM store_inventory_docs
         WHERE id = ${outboundDocId} AND doc_type = '分院调货出库'
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        status: StoreInventoryDocStatus
        store_id: string
        counterpart_store_id: string | null
        doc_date: string
        total_quantity: string | number
        remark: string | null
      }>)[0]
      if (!head) throw new ApiError('NOT_FOUND', '调拨出库单不存在')
      if (head.status !== '待收货') throw new ApiError('INVALID_STATE', '该调拨单不是待收货状态')
      if (!head.counterpart_store_id) throw new ApiError('INVALID_STATE', '调拨单缺少接收门店')
      if (!isInScope(session, head.counterpart_store_id)) {
        throw new ApiError('PERMISSION_DENIED', '无权确认该接收门店库存')
      }

      const newDocId = await generateStoreInventoryDocNo(tx, '分院调货入库')
      await tx.insert(storeInventoryDocs).values({
        id: newDocId,
        docType: '分院调货入库',
        status: '已完成',
        storeId: head.counterpart_store_id,
        counterpartStoreId: head.store_id,
        docDate: shanghaiToday(),
        totalQuantity: String(head.total_quantity),
        requestDocId: outboundDocId,
        remark: remark?.trim() || head.remark,
        createdBy: session.employeeId,
        confirmedBy: session.employeeId,
        confirmedAt: nowTs(),
      })

      const itemRows = await tx.execute(sql`
        SELECT sku_id, sku_name, batch_no, expiry_date, quantity, unit_price, amount, remark
          FROM store_inventory_doc_items
         WHERE doc_id = ${outboundDocId}
         ORDER BY id
      `)
      for (const item of itemRows as unknown as Array<{
        sku_id: string
        sku_name: string
        batch_no: string | null
        expiry_date: string | null
        quantity: string | number
        unit_price: string | number | null
        amount: string | number | null
        remark: string | null
      }>) {
        const stock = await ensureStockFromSku(tx, head.counterpart_store_id, {
          skuId: item.sku_id,
          batchNo: item.batch_no,
          expiryDate: item.expiry_date,
          quantity: Number(item.quantity),
        })
        const [createdItem] = await tx
          .insert(storeInventoryDocItems)
          .values({
            docId: newDocId,
            stockId: stock.id,
            skuId: stock.skuId,
            skuName: stock.skuName,
            batchNo: stock.batchNo,
            expiryDate: stock.expiryDate,
            quantity: String(item.quantity),
            stockSnapshot: String(stock.quantityOnHand),
            unitPrice: item.unit_price == null ? null : String(item.unit_price),
            amount: item.amount == null ? null : String(item.amount),
            remark: item.remark,
          })
          .returning({ id: storeInventoryDocItems.id })
        await applyStockMovement(tx, {
          stock,
          docId: newDocId,
          docItemId: createdItem.id,
          direction: '入库',
          quantity: Number(item.quantity),
          createdBy: session.employeeId,
          movementKey: `receive:${outboundDocId}:item:${createdItem.id}`,
          unitPrice: item.unit_price == null ? null : Number(item.unit_price),
          amount: item.amount == null ? null : Number(item.amount),
          remark: remark ?? null,
        })
      }

      await tx
        .update(storeInventoryDocs)
        .set({
          status: '已完成',
          confirmedBy: session.employeeId,
          confirmedAt: nowTs(),
          updatedAt: nowTs(),
        })
        .where(eq(storeInventoryDocs.id, outboundDocId))
      return newDocId
    })

    await logOperation(session, 'confirm_receive', 'store_inventory_doc', outboundDocId, {
      inboundDocId,
    })
    revalidatePath('/inventory')
    revalidatePath('/inventory/stocks')
    return { success: true, inboundDocId }
  },
)
