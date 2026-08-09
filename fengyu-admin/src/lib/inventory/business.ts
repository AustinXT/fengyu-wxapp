import 'server-only'

import { db } from '@/db'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import { logOperation } from '@/lib/operation-log'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type LocationType = '总部' | '市场' | '门店'

interface Location {
  locationId: string
  locationType: LocationType
  name: string
  parentLocationId: string | null
}

interface SkuSnapshot {
  skuId: string
  productCode: string
  productName: string
  specName: string | null
  supplier: string | null
  productSeries: string | null
  sourceType: '供应链' | '市场自采' | '转让店'
  ownerMarketId: string | null
  supplyChainPurchasePrice: number | null
  marketPurchasePrice: number | null
  storePurchasePrice: number | null
  marketStaffPurchasePrice: number | null
  itemCompanyPurchasePrice: number | null
}

interface LotSnapshot {
  id: number
  locationId: string
  skuId: string
  skuName: string
  specName: string | null
  supplier: string | null
  productSeries: string | null
  batchNo: string
  expiryDate: string | null
  isGift: boolean
  quantityOnHand: number
  supplyChainUnitCost: number | null
  marketStandardUnitPrice: number | null
  marketUnitDiscount: number | null
  marketActualUnitPrice: number | null
  storeStandardUnitPrice: number | null
  storeUnitDiscount: number | null
  storeActualUnitPrice: number | null
}

interface DocHeader {
  id: string
  docType: string
  status: string
  sourceLocationId: string | null
  targetLocationId: string | null
  marketId: string | null
  supplierId: string | null
  supplierName: string | null
  relatedDocId: string | null
  requestDocId: string | null
}

interface DocItemSnapshot {
  id: number
  docId: string
  lotId: number | null
  skuId: string
  skuName: string
  specName: string | null
  supplier: string | null
  productSeries: string | null
  batchNo: string
  expiryDate: string | null
  isGift: boolean
  quantity: number
  stockSnapshot: number | null
  requestQuantity: number | null
  fulfilledQuantity: number | null
  standardUnitPrice: number | null
  unitDiscount: number | null
  actualUnitPrice: number | null
  amount: number | null
  supplyChainUnitCost: number | null
  marketStandardUnitPrice: number | null
  marketUnitDiscount: number | null
  marketActualUnitPrice: number | null
  storeStandardUnitPrice: number | null
  storeUnitDiscount: number | null
  storeActualUnitPrice: number | null
  reason: string | null
  remark: string | null
}

interface PriceSnapshot {
  marketStandardUnitPrice: number | null
  marketUnitDiscount: number | null
  marketActualUnitPrice: number | null
  storeStandardUnitPrice: number | null
  storeUnitDiscount: number | null
  storeActualUnitPrice: number | null
  supplyChainUnitCost: number | null
}

interface InsertDocHeaderInput {
  id: string
  docType: string
  status: string
  sourceLocationId?: string | null
  targetLocationId?: string | null
  marketId?: string | null
  supplierId?: string | null
  supplierName?: string | null
  employeeId?: string | null
  employeeName?: string | null
  externalPartyName?: string | null
  logisticsCompany?: string | null
  trackingNo?: string | null
  receiptAttachmentUrl?: string | null
  docDate?: string | null
  relatedDocId?: string | null
  requestDocId?: string | null
  totalQuantity: number
  totalAmount?: number | null
  remark?: string | null
  createdBy: string
  confirmed?: boolean
}

interface InsertDocItemInput extends PriceSnapshot {
  docId: string
  lotId?: number | null
  skuId: string
  skuName: string
  specName?: string | null
  supplier?: string | null
  productSeries?: string | null
  batchNo?: string | null
  expiryDate?: string | null
  isGift?: boolean
  quantity: number
  stockSnapshot?: number | null
  requestQuantity?: number | null
  fulfilledQuantity?: number | null
  standardUnitPrice?: number | null
  unitDiscount?: number | null
  actualUnitPrice?: number | null
  amount?: number | null
  reason?: string | null
  remark?: string | null
}

export interface StoreReplenishmentLineInput {
  skuId: string
  quantity: number
  remark?: string | null
}

export interface CreateStoreReplenishmentInput {
  storeId: string
  marketId: string
  docDate?: string | null
  remark?: string | null
  items: StoreReplenishmentLineInput[]
}

export interface StoreReplenishmentSummaryLine {
  skuId: string
  skuName: string
  specName: string | null
  requestedQuantity: number
  fulfilledQuantity: number
  outstandingQuantity: number
  onHandQuantity: number
  reservedQuantity: number
  availableQuantity: number
  suggestedPurchaseQuantity: number
  requestItemIds: number[]
}

export interface StoreReplenishmentSummary {
  marketId: string
  items: StoreReplenishmentSummaryLine[]
}

export interface MarketReplenishmentLineInput {
  skuId: string
  sourceRequestItemIds: number[]
  purchaseQuantity: number
}

export interface CreateMarketReplenishmentInput {
  marketId: string
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: MarketReplenishmentLineInput[]
}

export interface CreatePurchaseOrderLineInput {
  marketReportItemId: number
  quantity: number
}

export interface CreatePurchaseOrderInput {
  marketReportId: string
  supplierId: string
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: CreatePurchaseOrderLineInput[]
}

export interface ShipmentLineInput {
  purchaseOrderItemId: number
  lotId: number
  quantity: number
  giftQuantity?: number | null
  remark?: string | null
}

export interface CreateItemCompanyShipmentInput {
  purchaseOrderId: string
  sourceLocationId: string
  docDate?: string | null
  logisticsCompany?: string | null
  trackingNo?: string | null
  remark?: string | null
  items: ShipmentLineInput[]
}

export interface ReceiptLineInput {
  shipmentItemId: number
  receivedQuantity: number
  remark?: string | null
}

export interface ReceiveShipmentInput {
  shipmentId: string
  docDate?: string | null
  remark?: string | null
  items: ReceiptLineInput[]
}

export interface StoreAllocationLineInput {
  requestItemId: number
  lotId: number
  quantity: number
  giftQuantity?: number | null
  storeUnitDiscount?: number | null
  remark?: string | null
}

export interface CreateStoreAllocationInput {
  storeRequestId: string
  sourceMarketId: string
  docDate?: string | null
  remark?: string | null
  items: StoreAllocationLineInput[]
}

export interface ReturnLineInput {
  lotId: number
  quantity: number
  reason?: string | null
  remark?: string | null
}

export interface CreateReturnForRestockInput {
  sourceLocationId: string
  targetLocationId: string
  docDate?: string | null
  remark?: string | null
  items: ReturnLineInput[]
}

export interface MarketStaffPurchaseLineInput {
  lotId: number
  quantity: number
  remark?: string | null
}

export interface CreateMarketStaffPurchaseInput {
  marketId: string
  employeeId: string
  docDate?: string | null
  remark?: string | null
  items: MarketStaffPurchaseLineInput[]
}

export interface SelfPurchasedReceiptLineInput {
  skuId: string
  quantity: number
  batchNo?: string | null
  expiryDate?: string | null
  isGift?: boolean
  /** 市场本次自采的实际单位成本；空值时取资料表自采/市场进货价。 */
  marketActualUnitPrice?: number | null
  /** 给门店配货时的本批单价优惠快照。 */
  storeUnitDiscount?: number | null
  remark?: string | null
}

export interface CreateSelfPurchasedReceiptInput {
  marketId: string
  supplierId?: string | null
  supplierName?: string | null
  docDate?: string | null
  receiptAttachmentUrl?: string | null
  remark?: string | null
  items: SelfPurchasedReceiptLineInput[]
}

export interface ExternalMarketOutboundLineInput {
  lotId: number
  quantity: number
  remark?: string | null
}

export interface CreateExternalMarketOutboundInput {
  marketId: string
  externalPartyName: string
  docDate?: string | null
  remark?: string | null
  items: ExternalMarketOutboundLineInput[]
}

export interface InventoryConversionLineInput {
  sourceLotId: number
  sourceQuantity: number
  targetSkuId: string
  targetQuantity: number
  targetBatchNo?: string | null
  targetExpiryDate?: string | null
  remark?: string | null
}

export interface CreateInventoryConversionInput {
  locationId: string
  docDate?: string | null
  remark?: string | null
  items: InventoryConversionLineInput[]
}

export interface PromotionQuote {
  skuId: string
  marketId: string
  quantity: number
  marketStandardUnitPrice: number
  marketUnitDiscount: number
  marketActualUnitPrice: number
  promotionPlanId: string | null
  promotionPlanNo: string | null
  promotionName: string | null
}

const EPSILON = 0.000001

const DOC_PREFIX: Record<string, string> = {
  门店报货: 'DBH',
  市场报货: 'MBH',
  采购订单: 'CGD',
  品项公司发货: 'GFH',
  市场采购入库: 'MRK',
  分院配货: 'FPH',
  院入库: 'YRK',
  院退货: 'YTH',
  市场退货: 'MTH',
  市场退货入库: 'MTR',
  供应链退货入库: 'GTR',
  员工购出库: 'YGG',
  自采产品入库: 'ZRK',
  非凤御市场出库: 'FFY',
  库存转换出库: 'ZHO',
  库存转换入库: 'ZHI',
}

function rows<T>(value: unknown): T[] {
  return value as T[]
}

function text(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized || null
}

function required(value: string | null | undefined, label: string): string {
  const normalized = text(value)
  if (!normalized) throw new ApiError('INVALID_PARAMS', `缺少${label}`)
  return normalized
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positive(value: number, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError('INVALID_PARAMS', `${label}必须大于 0`)
  }
  return parsed
}

function nonnegative(value: number | null | undefined, label: string): number {
  if (value === null || value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError('INVALID_PARAMS', `${label}不能小于 0`)
  }
  return parsed
}

function numeric(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) throw new ApiError('INVALID_PARAMS', '数量或金额不是有效数字')
  return String(value)
}

function dateOrToday(value: string | null | undefined): string {
  const result = text(value) ?? shanghaiToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new ApiError('INVALID_PARAMS', '单据日期格式应为 YYYY-MM-DD')
  }
  return result
}

function nearlyGreater(left: number, right: number): boolean {
  return left - right > EPSILON
}

function fixed(value: number): number {
  return Number(value.toFixed(4))
}

function lotKey(input: {
  skuId: string
  batchNo: string
  expiryDate: string | null
  isGift: boolean
  supplyChainUnitCost: number | null
  marketActualUnitPrice: number | null
  storeActualUnitPrice: number | null
}): string {
  const price = (value: number | null) => value === null ? '' : value.toFixed(4)
  return [
    input.skuId,
    input.batchNo,
    input.expiryDate ?? '',
    input.isGift ? 'gift' : 'normal',
    price(input.supplyChainUnitCost),
    price(input.marketActualUnitPrice),
    price(input.storeActualUnitPrice),
  ].join('|')
}

async function syncLocations(): Promise<void> {
  await db.execute(sql`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id, is_active)
    SELECT id, type, name, id, parent_id, is_active
      FROM org_nodes
     WHERE type IN ('总部', '市场')
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
  `)
  await db.execute(sql`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active)
    SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id,
           COALESCE(o.is_active, false) AND NOT s.is_closed
      FROM stores s
      LEFT JOIN org_nodes o ON o.id = s.org_node_id
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
  `)
}

async function locationForUpdate(tx: Tx, locationId: string): Promise<Location> {
  const [row] = rows<{
    location_id: string
    location_type: LocationType
    name: string
    parent_location_id: string | null
  }>(await tx.execute(sql`
    SELECT location_id, location_type, name, parent_location_id
      FROM inventory_locations
     WHERE location_id = ${locationId}
       AND is_active = true
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存主体不存在或已停用')
  return {
    locationId: row.location_id,
    locationType: row.location_type,
    name: row.name,
    parentLocationId: row.parent_location_id,
  }
}

function assertLocationWritable(session: AuthSession, location: Location): void {
  if (isAdminScope(session) || session.roles.some((role) => role.scopeType === '总部')) return
  if (
    location.locationType === '市场' &&
    session.roles.some((role) => role.scopeType === '市场' && role.scopeId === location.locationId)
  ) return
  if (
    location.locationType === '门店' &&
    session.permissions.scopeStoreIds.includes(location.locationId)
  ) return
  throw new ApiError('PERMISSION_DENIED', '无权操作该库存主体')
}

function assertType(location: Location, type: LocationType, label: string): void {
  if (location.locationType !== type) {
    throw new ApiError('INVALID_PARAMS', `${label}必须是${type}库存主体`)
  }
}

async function generateDocId(tx: Tx, docType: string): Promise<string> {
  const prefix = DOC_PREFIX[docType]
  if (!prefix) throw new ApiError('INVALID_PARAMS', `不支持的业务单据类型：${docType}`)
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_business:${prefix}:${ymd}`}))`)
  const [latest] = rows<{ id: string }>(await tx.execute(sql`
    SELECT id
      FROM inventory_docs
     WHERE id LIKE ${`${prefix}-${ymd}-%`}
     ORDER BY id DESC
     LIMIT 1
  `))
  const sequence = latest ? Number(latest.id.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(sequence).padStart(4, '0')}`
}

async function loadSku(
  tx: Tx,
  skuId: string,
  reportable = false,
  activeOnly = true,
): Promise<SkuSnapshot> {
  const [row] = rows<{
    sku_id: string
    product_code: string
    product_name: string
    spec_name: string | null
    supplier: string | null
    product_series: string | null
    source_type: '供应链' | '市场自采' | '转让店'
    owner_market_id: string | null
    supply_chain_purchase_price: string | number | null
    market_purchase_price: string | number | null
    store_purchase_price: string | number | null
    market_staff_purchase_price: string | number | null
    item_company_purchase_price: string | number | null
  }>(await tx.execute(sql`
    SELECT sku_id, product_code, product_name, spec_name, supplier, product_series,
           source_type, owner_market_id, supply_chain_purchase_price, market_purchase_price,
           store_purchase_price, market_staff_purchase_price, item_company_purchase_price
     FROM inventory_skus
     WHERE sku_id = ${skuId}
       ${activeOnly ? sql`AND is_active = true` : sql``}
       ${reportable ? sql`AND is_reportable = true` : sql``}
     LIMIT 1
  `))
  if (!row) {
    throw new ApiError(
      'NOT_FOUND',
      reportable ? '库存 SKU 不存在、已停用或不可报货' : activeOnly ? '库存 SKU 不存在或已停用' : '库存 SKU 不存在',
    )
  }
  return {
    skuId: row.sku_id,
    productCode: row.product_code,
    productName: row.product_name,
    specName: row.spec_name,
    supplier: row.supplier,
    productSeries: row.product_series,
    sourceType: row.source_type,
    ownerMarketId: row.owner_market_id,
    supplyChainPurchasePrice: numberOrNull(row.supply_chain_purchase_price),
    marketPurchasePrice: numberOrNull(row.market_purchase_price),
    storePurchasePrice: numberOrNull(row.store_purchase_price),
    marketStaffPurchasePrice: numberOrNull(row.market_staff_purchase_price),
    itemCompanyPurchasePrice: numberOrNull(row.item_company_purchase_price),
  }
}

async function lotForUpdate(tx: Tx, lotId: number, locationId?: string | null): Promise<LotSnapshot> {
  const [row] = rows<{
    id: number
    location_id: string
    sku_id: string
    sku_name: string
    spec_name: string | null
    supplier: string | null
    product_series: string | null
    batch_no: string
    expiry_date: string | null
    is_gift: boolean
    quantity_on_hand: string | number
    supply_chain_unit_cost: string | number | null
    market_standard_unit_price: string | number | null
    market_unit_discount: string | number | null
    market_actual_unit_price: string | number | null
    store_standard_unit_price: string | number | null
    store_unit_discount: string | number | null
    store_actual_unit_price: string | number | null
  }>(await tx.execute(sql`
    SELECT id, location_id, sku_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity_on_hand,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price
      FROM inventory_stock_lots
     WHERE id = ${lotId}
       AND (${locationId ?? null}::text IS NULL OR location_id = ${locationId ?? null})
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存批次不存在或不属于当前库存主体')
  return {
    id: Number(row.id),
    locationId: row.location_id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    specName: row.spec_name,
    supplier: row.supplier,
    productSeries: row.product_series,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    isGift: row.is_gift,
    quantityOnHand: Number(row.quantity_on_hand),
    supplyChainUnitCost: numberOrNull(row.supply_chain_unit_cost),
    marketStandardUnitPrice: numberOrNull(row.market_standard_unit_price),
    marketUnitDiscount: numberOrNull(row.market_unit_discount),
    marketActualUnitPrice: numberOrNull(row.market_actual_unit_price),
    storeStandardUnitPrice: numberOrNull(row.store_standard_unit_price),
    storeUnitDiscount: numberOrNull(row.store_unit_discount),
    storeActualUnitPrice: numberOrNull(row.store_actual_unit_price),
  }
}

async function activeReservedQuantity(tx: Tx, lotId: number): Promise<number> {
  const [row] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
    SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
      FROM inventory_stock_reservations
     WHERE lot_id = ${lotId}
       AND status = '已预留'
  `))
  return Number(row?.quantity ?? 0)
}

async function assertLotAvailable(tx: Tx, lot: LotSnapshot, quantity: number): Promise<void> {
  const reserved = await activeReservedQuantity(tx, lot.id)
  const available = lot.quantityOnHand - reserved
  if (nearlyGreater(quantity, available)) {
    throw new ApiError('INVALID_STATE', `库存不足：${lot.skuName} 可用 ${fixed(Math.max(available, 0))}`)
  }
}

async function applyLotDelta(
  tx: Tx,
  input: {
    lot: LotSnapshot
    docId: string
    docItemId: number
    direction: '入库' | '出库' | '调整'
    quantityDelta: number
    createdBy: string
    movementKey: string
    remark?: string | null
  },
): Promise<void> {
  if (!Number.isFinite(input.quantityDelta) || Math.abs(input.quantityDelta) < EPSILON) {
    throw new ApiError('INVALID_PARAMS', '库存变动数量必须非零')
  }
  const after = fixed(input.lot.quantityOnHand + input.quantityDelta)
  if (after < -EPSILON) throw new ApiError('INVALID_STATE', `库存不足：${input.lot.skuName}`)
  await tx.execute(sql`
    UPDATE inventory_stock_lots
       SET quantity_on_hand = ${numeric(Math.max(after, 0))},
           updated_at = NOW()
     WHERE id = ${input.lot.id}
  `)
  await tx.execute(sql`
    INSERT INTO inventory_movements (
      movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id,
      direction, quantity_delta, quantity_before, quantity_after, created_by, remark
    ) VALUES (
      ${input.movementKey}, ${input.lot.id}, ${input.lot.locationId}, ${input.lot.skuId},
      ${input.docId}, ${input.docItemId}, ${input.direction}, ${numeric(input.quantityDelta)},
      ${numeric(input.lot.quantityOnHand)}, ${numeric(Math.max(after, 0))},
      ${input.createdBy}, ${text(input.remark)}
    )
  `)
  input.lot.quantityOnHand = Math.max(after, 0)
}

async function upsertLot(
  tx: Tx,
  input: Omit<LotSnapshot, 'id' | 'quantityOnHand' | 'locationId'> & { locationId: string; sourceDocId: string },
): Promise<LotSnapshot> {
  const key = lotKey({
    skuId: input.skuId,
    batchNo: input.batchNo,
    expiryDate: input.expiryDate,
    isGift: input.isGift,
    supplyChainUnitCost: input.supplyChainUnitCost,
    marketActualUnitPrice: input.marketActualUnitPrice,
    storeActualUnitPrice: input.storeActualUnitPrice,
  })
  const [created] = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO inventory_stock_lots (
      location_id, sku_id, lot_key, sku_name, spec_name, supplier, product_series,
      batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, source_doc_id
    ) VALUES (
      ${input.locationId}, ${input.skuId}, ${key}, ${input.skuName}, ${text(input.specName)},
      ${text(input.supplier)}, ${text(input.productSeries)}, ${input.batchNo},
      ${input.expiryDate}, ${input.expiryDate ?? ''}, ${input.isGift}, 0,
      ${numeric(input.supplyChainUnitCost)}, ${numeric(input.marketStandardUnitPrice)},
      ${numeric(input.marketUnitDiscount)}, ${numeric(input.marketActualUnitPrice)},
      ${numeric(input.storeStandardUnitPrice)}, ${numeric(input.storeUnitDiscount)},
      ${numeric(input.storeActualUnitPrice)}, ${input.sourceDocId}
    )
    ON CONFLICT (location_id, lot_key) DO UPDATE
      SET sku_name = EXCLUDED.sku_name,
          spec_name = EXCLUDED.spec_name,
          supplier = EXCLUDED.supplier,
          product_series = EXCLUDED.product_series,
          updated_at = NOW()
    RETURNING id
  `))
  return lotForUpdate(tx, Number(created.id), input.locationId)
}

async function insertDocHeader(tx: Tx, input: InsertDocHeaderInput): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_docs (
      id, doc_type, status, source_location_id, target_location_id, market_id, supplier_id,
      employee_id, employee_name, supplier_name, external_party_name, logistics_company, tracking_no,
      receipt_attachment_url, doc_date, related_doc_id, request_doc_id,
      total_quantity, total_amount, remark, created_by, confirmed_by, confirmed_at
    ) VALUES (
      ${input.id}, ${input.docType}, ${input.status}, ${text(input.sourceLocationId)},
      ${text(input.targetLocationId)}, ${text(input.marketId)}, ${text(input.supplierId)},
      ${text(input.employeeId)}, ${text(input.employeeName)}, ${text(input.supplierName)},
      ${text(input.externalPartyName)}, ${text(input.logisticsCompany)}, ${text(input.trackingNo)},
      ${text(input.receiptAttachmentUrl)}, ${dateOrToday(input.docDate)},
      ${text(input.relatedDocId)}, ${text(input.requestDocId)}, ${numeric(input.totalQuantity)},
      ${numeric(input.totalAmount ?? null)}, ${text(input.remark)}, ${input.createdBy},
      ${input.confirmed ? input.createdBy : null}, ${input.confirmed ? sql`NOW()` : null}
    )
  `)
}

async function insertDocItem(tx: Tx, input: InsertDocItemInput): Promise<number> {
  const [created] = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO inventory_doc_items (
      doc_id, lot_id, sku_id, sku_name, spec_name, supplier, product_series,
      batch_no, expiry_date, is_gift, quantity, stock_snapshot, request_quantity,
      fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price, amount,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, reason, remark
    ) VALUES (
      ${input.docId}, ${input.lotId ?? null}, ${input.skuId}, ${input.skuName},
      ${text(input.specName)}, ${text(input.supplier)}, ${text(input.productSeries)},
      ${text(input.batchNo) ?? ''}, ${text(input.expiryDate)}, ${Boolean(input.isGift)},
      ${numeric(input.quantity)}, ${numeric(input.stockSnapshot ?? null)},
      ${numeric(input.requestQuantity ?? null)}, ${numeric(input.fulfilledQuantity ?? null)},
      ${numeric(input.standardUnitPrice ?? null)}, ${numeric(input.unitDiscount ?? null)},
      ${numeric(input.actualUnitPrice ?? null)}, ${numeric(input.amount ?? null)},
      ${numeric(input.supplyChainUnitCost)}, ${numeric(input.marketStandardUnitPrice)},
      ${numeric(input.marketUnitDiscount)}, ${numeric(input.marketActualUnitPrice)},
      ${numeric(input.storeStandardUnitPrice)}, ${numeric(input.storeUnitDiscount)},
      ${numeric(input.storeActualUnitPrice)}, ${text(input.reason)}, ${text(input.remark)}
    )
    RETURNING id
  `))
  return Number(created.id)
}

async function insertDocLink(
  tx: Tx,
  input: {
    fromDocId: string
    toDocId: string
    relationType: string
    fromItemId?: number | null
    toItemId?: number | null
    quantity?: number | null
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_doc_links (
      from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity
    ) VALUES (
      ${input.fromDocId}, ${input.toDocId}, ${input.relationType},
      ${input.fromItemId ?? null}, ${input.toItemId ?? null}, ${numeric(input.quantity ?? null)}
    )
  `)
}

async function insertReservation(
  tx: Tx,
  input: {
    requestDocId: string
    requestItemId: number
    lotId: number
    locationId: string
    skuId: string
    quantity: number
    fulfilledQuantity?: number
    releasedQuantity?: number
    status: '已预留' | '已完成' | '已释放'
    createdBy: string
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_stock_reservations (
      request_doc_id, request_item_id, lot_id, location_id, sku_id, quantity,
      fulfilled_quantity, released_quantity, status, created_by
    ) VALUES (
      ${input.requestDocId}, ${input.requestItemId}, ${input.lotId}, ${input.locationId},
      ${input.skuId}, ${numeric(input.quantity)}, ${numeric(input.fulfilledQuantity ?? 0)},
      ${numeric(input.releasedQuantity ?? 0)}, ${input.status}, ${input.createdBy}
    )
  `)
}

function asDocItem(row: Record<string, unknown>): DocItemSnapshot {
  return {
    id: Number(row.id),
    docId: String(row.doc_id),
    lotId: numberOrNull(row.lot_id),
    skuId: String(row.sku_id),
    skuName: String(row.sku_name),
    specName: text(row.spec_name as string | null | undefined),
    supplier: text(row.supplier as string | null | undefined),
    productSeries: text(row.product_series as string | null | undefined),
    batchNo: String(row.batch_no ?? ''),
    expiryDate: text(row.expiry_date as string | null | undefined),
    isGift: Boolean(row.is_gift),
    quantity: Number(row.quantity),
    stockSnapshot: numberOrNull(row.stock_snapshot),
    requestQuantity: numberOrNull(row.request_quantity),
    fulfilledQuantity: numberOrNull(row.fulfilled_quantity),
    standardUnitPrice: numberOrNull(row.standard_unit_price),
    unitDiscount: numberOrNull(row.unit_discount),
    actualUnitPrice: numberOrNull(row.actual_unit_price),
    amount: numberOrNull(row.amount),
    supplyChainUnitCost: numberOrNull(row.supply_chain_unit_cost),
    marketStandardUnitPrice: numberOrNull(row.market_standard_unit_price),
    marketUnitDiscount: numberOrNull(row.market_unit_discount),
    marketActualUnitPrice: numberOrNull(row.market_actual_unit_price),
    storeStandardUnitPrice: numberOrNull(row.store_standard_unit_price),
    storeUnitDiscount: numberOrNull(row.store_unit_discount),
    storeActualUnitPrice: numberOrNull(row.store_actual_unit_price),
    reason: text(row.reason as string | null | undefined),
    remark: text(row.remark as string | null | undefined),
  }
}

async function docForUpdate(tx: Tx, id: string): Promise<DocHeader> {
  const [row] = rows<{
    id: string
    doc_type: string
    status: string
    source_location_id: string | null
    target_location_id: string | null
    market_id: string | null
    supplier_id: string | null
    supplier_name: string | null
    related_doc_id: string | null
    request_doc_id: string | null
  }>(await tx.execute(sql`
    SELECT id, doc_type, status, source_location_id, target_location_id, market_id,
           supplier_id, supplier_name, related_doc_id, request_doc_id
      FROM inventory_docs
     WHERE id = ${id}
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存单据不存在')
  return {
    id: row.id,
    docType: row.doc_type,
    status: row.status,
    sourceLocationId: row.source_location_id,
    targetLocationId: row.target_location_id,
    marketId: row.market_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    relatedDocId: row.related_doc_id,
    requestDocId: row.request_doc_id,
  }
}

async function docItemForUpdate(tx: Tx, id: number, docId?: string): Promise<DocItemSnapshot> {
  const [row] = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, doc_id, lot_id, sku_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity, stock_snapshot, request_quantity,
           fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price, amount,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price, reason, remark
      FROM inventory_doc_items
     WHERE id = ${id}
       AND (${docId ?? null}::text IS NULL OR doc_id = ${docId ?? null})
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存单据明细不存在')
  return asDocItem(row)
}

async function linkedQuantity(
  tx: Tx,
  fromItemId: number,
  relationType: string,
): Promise<number> {
  const [row] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
    SELECT COALESCE(SUM(quantity), 0) AS quantity
      FROM inventory_doc_links l
      JOIN inventory_docs target_doc ON target_doc.id = l.to_doc_id
     WHERE l.from_item_id = ${fromItemId}
       AND l.relation_type = ${relationType}
       AND target_doc.status <> '已取消'
  `))
  return Number(row?.quantity ?? 0)
}

async function ensureSupplier(tx: Tx, supplierId: string): Promise<{ id: string; name: string }> {
  const [supplier] = rows<{ supplier_id: string; name: string }>(await tx.execute(sql`
    SELECT supplier_id, name
      FROM inventory_suppliers
     WHERE supplier_id = ${supplierId}
       AND is_active = true
     LIMIT 1
  `))
  if (!supplier) throw new ApiError('NOT_FOUND', '供应商不存在或已停用')
  return { id: supplier.supplier_id, name: supplier.name }
}

async function employeeForMarket(
  tx: Tx,
  employeeId: string,
  marketId: string,
): Promise<{ id: string; name: string }> {
  const [employee] = rows<{
    employee_id: string
    name: string | null
    store_id: string | null
    org_node_id: string | null
    store_market_id: string | null
  }>(await tx.execute(sql`
    SELECT e.employee_id, e.name, e.store_id, e.org_node_id,
           location.parent_location_id AS store_market_id
      FROM staff_wechat_users e
      LEFT JOIN inventory_locations location ON location.location_id = e.store_id
     WHERE e.employee_id = ${employeeId}
       AND e.is_resigned = false
     LIMIT 1
  `))
  if (!employee) throw new ApiError('NOT_FOUND', '员工不存在或已离职')
  let employeeMarketId = employee.store_market_id
  if (!employeeMarketId && employee.org_node_id) {
    const [market] = rows<{ id: string }>(await tx.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, type
          FROM org_nodes
         WHERE id = ${employee.org_node_id}
        UNION ALL
        SELECT node.id, node.parent_id, node.type
          FROM org_nodes node
          JOIN ancestors ancestor ON ancestor.parent_id = node.id
      )
      SELECT id
        FROM ancestors
       WHERE type = '市场'
       LIMIT 1
    `))
    employeeMarketId = market?.id ?? null
  }
  if (!employeeMarketId || employeeMarketId !== marketId) {
    throw new ApiError('PERMISSION_DENIED', '员工不属于当前市场')
  }
  return { id: employee.employee_id, name: employee.name?.trim() || employee.employee_id }
}

function marketIdForLocation(location: Location): string | null {
  if (location.locationType === '市场') return location.locationId
  if (location.locationType === '门店') return location.parentLocationId
  return null
}

/** 供应链 SKU 可跨市场使用；市场自采与转让店 SKU 只能留在其归属市场业务链中。 */
export function assertSkuAvailableToMarket(
  sku: Pick<SkuSnapshot, 'sourceType' | 'ownerMarketId' | 'productName'>,
  marketId: string | null | undefined,
): void {
  if (sku.sourceType === '供应链') return
  if (marketId && sku.ownerMarketId === marketId) return
  throw new ApiError('INVALID_STATE', `${sku.sourceType} SKU ${sku.productName} 仅可在归属市场使用`)
}

async function loadLotSkuForMarket(
  tx: Tx,
  lot: LotSnapshot,
  marketId: string | null | undefined,
): Promise<SkuSnapshot> {
  const sku = await loadSku(tx, lot.skuId, false, false)
  assertSkuAvailableToMarket(sku, marketId)
  return sku
}

function assertMarketFinance(session: AuthSession): void {
  if (isAdminScope(session) || session.roles.some((role) => role.role === 'finance')) return
  throw new ApiError('PERMISSION_DENIED', '市场自采资料与入库仅限市场财务办理')
}

async function quoteMarketPriceInTx(
  tx: Tx,
  input: { marketId: string; skuId: string; quantity: number; docDate: string },
): Promise<PromotionQuote> {
  const sku = await loadSku(tx, input.skuId, true)
  assertSkuAvailableToMarket(sku, input.marketId)
  if (sku.marketPurchasePrice === null) {
    throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置市场进货价`)
  }
  const [promotion] = rows<{
    plan_id: string
    plan_no: string
    plan_name: string
    market_unit_discount: string | number | null
  }>(await tx.execute(sql`
    SELECT p.id AS plan_id, p.plan_no, p.name AS plan_name,
           i.market_unit_discount
      FROM inventory_promotion_plans p
      JOIN inventory_promotion_plan_items i ON i.plan_id = p.id
     WHERE p.status = '启用'
       AND p.starts_at <= ${input.docDate}
       AND p.ends_at >= ${input.docDate}
       AND (p.scope_market_id IS NULL OR p.scope_market_id = ${input.marketId})
       AND p.scope_store_id IS NULL
       AND i.sku_id = ${input.skuId}
       AND (i.report_min_quantity IS NULL OR i.report_min_quantity <= ${numeric(input.quantity)})
       AND (i.report_max_quantity IS NULL OR i.report_max_quantity >= ${numeric(input.quantity)})
     ORDER BY
       CASE WHEN p.scope_market_id = ${input.marketId} THEN 0 ELSE 1 END,
       COALESCE(i.report_min_quantity, 0) DESC,
       p.created_at DESC
     LIMIT 1
  `))
  const base = sku.marketPurchasePrice
  const discount = numberOrNull(promotion?.market_unit_discount) ?? 0
  const actual = fixed(base - discount)
  if (discount < -EPSILON || actual < -EPSILON) {
    throw new ApiError('INVALID_STATE', '福利方案计算出的市场实际单价无效')
  }
  return {
    skuId: input.skuId,
    marketId: input.marketId,
    quantity: input.quantity,
    marketStandardUnitPrice: fixed(base),
    marketUnitDiscount: fixed(discount),
    marketActualUnitPrice: fixed(actual),
    promotionPlanId: promotion?.plan_id ?? null,
    promotionPlanNo: promotion?.plan_no ?? null,
    promotionName: promotion?.plan_name ?? null,
  }
}

function priceFromItem(item: DocItemSnapshot): PriceSnapshot {
  return {
    supplyChainUnitCost: item.supplyChainUnitCost,
    marketStandardUnitPrice: item.marketStandardUnitPrice,
    marketUnitDiscount: item.marketUnitDiscount,
    marketActualUnitPrice: item.marketActualUnitPrice,
    storeStandardUnitPrice: item.storeStandardUnitPrice,
    storeUnitDiscount: item.storeUnitDiscount,
    storeActualUnitPrice: item.storeActualUnitPrice,
  }
}

function priceFromLot(lot: LotSnapshot): PriceSnapshot {
  return {
    supplyChainUnitCost: lot.supplyChainUnitCost,
    marketStandardUnitPrice: lot.marketStandardUnitPrice,
    marketUnitDiscount: lot.marketUnitDiscount,
    marketActualUnitPrice: lot.marketActualUnitPrice,
    storeStandardUnitPrice: lot.storeStandardUnitPrice,
    storeUnitDiscount: lot.storeUnitDiscount,
    storeActualUnitPrice: lot.storeActualUnitPrice,
  }
}

function refreshInventoryPaths(): void {
  revalidatePath('/inventory')
  revalidatePath('/inventory/docs')
  revalidatePath('/inventory/stocks')
  revalidatePath('/inventory/operations')
}

/** 门店只能为自身市场创建需求，报货本身不产生库存流水。 */
export async function createStoreReplenishmentRequest(
  session: AuthSession,
  input: CreateStoreReplenishmentInput,
): Promise<{ id: string }> {
  const storeId = required(input.storeId, '门店')
  const marketId = required(input.marketId, '市场')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '门店报货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const store = await locationForUpdate(tx, storeId)
    const market = await locationForUpdate(tx, marketId)
    assertType(store, '门店', '报货主体')
    assertType(market, '市场', '报货市场')
    if (store.parentLocationId !== market.locationId) {
      throw new ApiError('INVALID_PARAMS', '门店只能向所属市场报货')
    }
    assertLocationWritable(session, store)
    const skuIds = new Set<string>()
    const prepared: Array<{ sku: SkuSnapshot; quantity: number; remark: string | null }> = []
    for (const item of input.items) {
      const skuId = required(item.skuId, '库存 SKU')
      if (skuIds.has(skuId)) throw new ApiError('INVALID_PARAMS', '同一 SKU 请合并为一条报货明细')
      skuIds.add(skuId)
      const sku = await loadSku(tx, skuId, true)
      assertSkuAvailableToMarket(sku, marketId)
      prepared.push({
        sku,
        quantity: positive(item.quantity, '报货数量'),
        remark: text(item.remark),
      })
    }
    const docId = await generateDocId(tx, '门店报货')
    const total = prepared.reduce((sum, item) => sum + item.quantity, 0)
    await insertDocHeader(tx, {
      id: docId,
      docType: '门店报货',
      status: '已完成',
      sourceLocationId: storeId,
      targetLocationId: marketId,
      marketId,
      docDate: input.docDate,
      totalQuantity: total,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      await insertDocItem(tx, {
        docId,
        skuId: item.sku.skuId,
        skuName: item.sku.productName,
        specName: item.sku.specName,
        supplier: item.sku.supplier,
        productSeries: item.sku.productSeries,
        quantity: item.quantity,
        requestQuantity: item.quantity,
        fulfilledQuantity: 0,
        supplyChainUnitCost: null,
        marketStandardUnitPrice: null,
        marketUnitDiscount: null,
        marketActualUnitPrice: null,
        storeStandardUnitPrice: null,
        storeUnitDiscount: null,
        storeActualUnitPrice: null,
        remark: item.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.store_request.create', 'inventory_docs', id, { storeId, marketId })
  refreshInventoryPaths()
  return { id }
}

/** 汇总本市场尚未履约且未被市场报货占用的门店需求；汇总仅是查询，不生成可绕过关联的通用单据。 */
export async function summarizeStoreReplenishmentRequests(
  session: AuthSession,
  input: { marketId: string; startDate?: string | null; endDate?: string | null },
): Promise<StoreReplenishmentSummary> {
  const marketId = required(input.marketId, '市场')
  await syncLocations()
  return db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '市场')
    assertLocationWritable(session, market)
    const startDate = input.startDate ? dateOrToday(input.startDate) : null
    const endDate = input.endDate ? dateOrToday(input.endDate) : null
    const result = rows<{
      sku_id: string
      sku_name: string
      spec_name: string | null
      requested_quantity: string | number
      fulfilled_quantity: string | number
      outstanding_quantity: string | number
      request_item_ids: number[] | string
    }>(await tx.execute(sql`
      SELECT i.sku_id,
             MAX(i.sku_name) AS sku_name,
             MAX(i.spec_name) AS spec_name,
             SUM(i.quantity) AS requested_quantity,
             SUM(COALESCE(i.fulfilled_quantity, 0)) AS fulfilled_quantity,
             SUM(GREATEST(i.quantity - summarized.quantity - COALESCE(i.fulfilled_quantity, 0), 0)) AS outstanding_quantity,
             ARRAY_AGG(i.id ORDER BY i.id) AS request_item_ids
        FROM inventory_docs d
        JOIN inventory_doc_items i ON i.doc_id = d.id
        JOIN LATERAL (
          SELECT COALESCE(SUM(quantity), 0) AS quantity
            FROM inventory_doc_links l
            JOIN inventory_docs market_request ON market_request.id = l.to_doc_id
           WHERE l.from_item_id = i.id
             AND l.relation_type = '门店报货汇总'
             AND market_request.status <> '已取消'
        ) summarized ON true
       WHERE d.doc_type = '门店报货'
         AND d.status <> '已取消'
         AND d.market_id = ${marketId}
         AND (${startDate}::date IS NULL OR d.doc_date >= ${startDate})
         AND (${endDate}::date IS NULL OR d.doc_date <= ${endDate})
         AND i.quantity > summarized.quantity + COALESCE(i.fulfilled_quantity, 0)
       GROUP BY i.sku_id
       ORDER BY MAX(i.sku_name), i.sku_id
    `))
    const items: StoreReplenishmentSummaryLine[] = []
    for (const row of result) {
        const requestedQuantity = Number(row.requested_quantity)
        const fulfilledQuantity = Number(row.fulfilled_quantity)
        const ids = Array.isArray(row.request_item_ids)
          ? row.request_item_ids.map(Number)
          : String(row.request_item_ids ?? '').replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
        const [onHand] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
          SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity
            FROM inventory_stock_lots
           WHERE location_id = ${marketId}
             AND sku_id = ${row.sku_id}
        `))
        const [reserved] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
          SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
            FROM inventory_stock_reservations
           WHERE location_id = ${marketId}
             AND sku_id = ${row.sku_id}
             AND status = '已预留'
        `))
        const onHandQuantity = Number(onHand?.quantity ?? 0)
        const reservedQuantity = Number(reserved?.quantity ?? 0)
        const availableQuantity = Math.max(0, fixed(onHandQuantity - reservedQuantity))
        const outstandingQuantity = Math.max(0, fixed(Number(row.outstanding_quantity)))
        items.push({
          skuId: row.sku_id,
          skuName: row.sku_name,
          specName: row.spec_name,
          requestedQuantity,
          fulfilledQuantity,
          outstandingQuantity,
          onHandQuantity,
          reservedQuantity,
          availableQuantity,
          suggestedPurchaseQuantity: Math.max(0, fixed(outstandingQuantity - availableQuantity)),
          requestItemIds: ids,
        })
    }
    return {
      marketId,
      items,
    }
  })
}

/** 市场报货由服务端从门店需求、实时库存及福利方案计算，采购数量只允许显式业务字段传入。 */
export async function createMarketReplenishment(
  session: AuthSession,
  input: CreateMarketReplenishmentInput,
): Promise<{ id: string }> {
  const marketId = required(input.marketId, '市场')
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '市场报货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(market, '市场', '报货市场')
    assertType(supplyChain, '总部', '供应链库存主体')
    assertLocationWritable(session, market)
    const seenRequestItems = new Set<number>()
    const docDate = dateOrToday(input.docDate)
    const prepared: Array<{
      sku: SkuSnapshot
      sourceItems: DocItemSnapshot[]
      requestQuantity: number
      stockSnapshot: number
      quote: PromotionQuote
      purchaseQuantity: number
    }> = []
    for (const line of input.items) {
      const skuId = required(line.skuId, '库存 SKU')
      const purchaseQuantity = positive(line.purchaseQuantity, '实际采购数量')
      if (!Array.isArray(line.sourceRequestItemIds) || line.sourceRequestItemIds.length === 0) {
        throw new ApiError('INVALID_PARAMS', '市场报货必须选择门店报货明细')
      }
      const sourceItems: DocItemSnapshot[] = []
      for (const rawItemId of line.sourceRequestItemIds) {
        const requestItemId = Number(rawItemId)
        if (!Number.isInteger(requestItemId) || requestItemId <= 0 || seenRequestItems.has(requestItemId)) {
          throw new ApiError('INVALID_PARAMS', '门店报货明细不能重复引用')
        }
        seenRequestItems.add(requestItemId)
        const item = await docItemForUpdate(tx, requestItemId)
        const requestHeader = await docForUpdate(tx, item.docId)
        if (
          requestHeader.docType !== '门店报货' ||
          requestHeader.status === '已取消' ||
          requestHeader.marketId !== marketId ||
          item.skuId !== skuId
        ) {
          throw new ApiError('INVALID_STATE', '所选明细不是当前市场可汇总的门店报货')
        }
        const alreadySummarized = await linkedQuantity(tx, item.id, '门店报货汇总')
        const alreadyFulfilled = item.fulfilledQuantity ?? 0
        const outstandingQuantity = fixed(item.quantity - alreadySummarized - alreadyFulfilled)
        if (!nearlyGreater(outstandingQuantity, 0)) {
          throw new ApiError('CONFLICT', '门店报货明细已全部履约或已汇总')
        }
        sourceItems.push({ ...item, quantity: outstandingQuantity })
      }
      const sku = await loadSku(tx, skuId, true)
      assertSkuAvailableToMarket(sku, marketId)
      const [stock] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
        SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity
          FROM inventory_stock_lots
         WHERE location_id = ${marketId}
           AND sku_id = ${skuId}
      `))
      const [reserved] = rows<{ quantity: string | number | null }>(await tx.execute(sql`
        SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
          FROM inventory_stock_reservations
         WHERE location_id = ${marketId}
           AND sku_id = ${skuId}
           AND status = '已预留'
      `))
      const requestQuantity = fixed(sourceItems.reduce((sum, item) => sum + item.quantity, 0))
      const quote = await quoteMarketPriceInTx(tx, { marketId, skuId, quantity: purchaseQuantity, docDate })
      prepared.push({
        sku,
        sourceItems,
        requestQuantity,
        stockSnapshot: Math.max(0, fixed(Number(stock?.quantity ?? 0) - Number(reserved?.quantity ?? 0))),
        quote,
        purchaseQuantity,
      })
    }
    const docId = await generateDocId(tx, '市场报货')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.purchaseQuantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, line) => sum + line.purchaseQuantity * line.quote.marketActualUnitPrice, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '市场报货',
      status: '已完成',
      sourceLocationId: marketId,
      targetLocationId: supplyChainLocationId,
      marketId,
      docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      const itemId = await insertDocItem(tx, {
        docId,
        skuId: line.sku.skuId,
        skuName: line.sku.productName,
        specName: line.sku.specName,
        supplier: line.sku.supplier,
        productSeries: line.sku.productSeries,
        quantity: line.purchaseQuantity,
        stockSnapshot: line.stockSnapshot,
        requestQuantity: line.requestQuantity,
        fulfilledQuantity: 0,
        standardUnitPrice: line.quote.marketStandardUnitPrice,
        unitDiscount: line.quote.marketUnitDiscount,
        actualUnitPrice: line.quote.marketActualUnitPrice,
        amount: fixed(line.purchaseQuantity * line.quote.marketActualUnitPrice),
        supplyChainUnitCost: line.sku.supplyChainPurchasePrice,
        marketStandardUnitPrice: line.quote.marketStandardUnitPrice,
        marketUnitDiscount: line.quote.marketUnitDiscount,
        marketActualUnitPrice: line.quote.marketActualUnitPrice,
        storeStandardUnitPrice: line.sku.storePurchasePrice,
        storeUnitDiscount: 0,
        storeActualUnitPrice: line.sku.storePurchasePrice,
        remark: line.quote.promotionPlanNo ? `福利方案：${line.quote.promotionPlanNo}` : null,
      })
      for (const sourceItem of line.sourceItems) {
        await insertDocLink(tx, {
          fromDocId: sourceItem.docId,
          toDocId: docId,
          relationType: '门店报货汇总',
          fromItemId: sourceItem.id,
          toItemId: itemId,
          quantity: sourceItem.quantity,
        })
      }
    }
    return docId
  })
  await logOperation(session, 'inventory.market_request.create', 'inventory_docs', id, { marketId })
  refreshInventoryPaths()
  return { id }
}

/** 采购订单只能从已完成的市场报货提取，不允许以自由 SKU/价格绕过需求和福利快照。 */
export async function createPurchaseOrderFromMarketReplenishment(
  session: AuthSession,
  input: CreatePurchaseOrderInput,
): Promise<{ id: string }> {
  const marketReportId = required(input.marketReportId, '市场报货单')
  const supplierId = required(input.supplierId, '供应商')
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '采购订单至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const marketReport = await docForUpdate(tx, marketReportId)
    if (marketReport.docType !== '市场报货' || marketReport.status === '已取消') {
      throw new ApiError('INVALID_STATE', '采购订单必须引用有效的市场报货单')
    }
    const marketId = required(marketReport.marketId, '市场报货所属市场')
    if (marketReport.sourceLocationId !== marketId) {
      throw new ApiError('INVALID_STATE', '市场报货单的市场主体不一致')
    }
    if (marketReport.targetLocationId !== supplyChainLocationId) {
      throw new ApiError('INVALID_STATE', '采购订单必须使用市场报货单指定的供应链主体')
    }
    const market = await locationForUpdate(tx, marketId)
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(market, '市场', '市场报货所属市场')
    assertType(supplyChain, '总部', '供应链库存主体')
    assertLocationWritable(session, market)
    const supplier = await ensureSupplier(tx, supplierId)
    const seen = new Set<number>()
    const prepared: Array<{ source: DocItemSnapshot; quantity: number }> = []
    for (const line of input.items) {
      const itemId = Number(line.marketReportItemId)
      if (!Number.isInteger(itemId) || itemId <= 0 || seen.has(itemId)) {
        throw new ApiError('INVALID_PARAMS', '市场报货明细不能重复')
      }
      seen.add(itemId)
      const source = await docItemForUpdate(tx, itemId, marketReportId)
      const sku = await loadSku(tx, source.skuId, false, false)
      assertSkuAvailableToMarket(sku, marketId)
      const quantity = positive(line.quantity, '采购数量')
      const ordered = await linkedQuantity(tx, source.id, '市场报货采购订单')
      if (nearlyGreater(quantity, source.quantity - ordered)) {
        throw new ApiError('CONFLICT', '采购数量不能超过市场报货中的未下单数量')
      }
      prepared.push({ source, quantity })
    }
    const docId = await generateDocId(tx, '采购订单')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, line) => sum + line.quantity * Number(line.source.marketActualUnitPrice ?? 0), 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '采购订单',
      status: '已完成',
      sourceLocationId: marketId,
      targetLocationId: supplyChainLocationId,
      marketId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      docDate: input.docDate,
      relatedDocId: marketReportId,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      const source = line.source
      const itemId = await insertDocItem(tx, {
        docId,
        skuId: source.skuId,
        skuName: source.skuName,
        specName: source.specName,
        supplier: source.supplier,
        productSeries: source.productSeries,
        quantity: line.quantity,
        requestQuantity: source.quantity,
        fulfilledQuantity: 0,
        standardUnitPrice: source.marketStandardUnitPrice,
        unitDiscount: source.marketUnitDiscount,
        actualUnitPrice: source.marketActualUnitPrice,
        amount: fixed(line.quantity * Number(source.marketActualUnitPrice ?? 0)),
        ...priceFromItem(source),
        remark: source.remark,
      })
      await insertDocLink(tx, {
        fromDocId: marketReportId,
        toDocId: docId,
        relationType: '市场报货采购订单',
        fromItemId: source.id,
        toItemId: itemId,
        quantity: line.quantity,
      })
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(line.quantity)}
         WHERE id = ${source.id}
      `)
    }
    return docId
  })
  await logOperation(session, 'inventory.purchase_order.create', 'inventory_docs', id, { marketReportId, supplierId })
  refreshInventoryPaths()
  return { id }
}

async function insertOutboundShipmentItem(
  tx: Tx,
  input: {
    docId: string
    sourceLot: LotSnapshot
    quantity: number
    isGift: boolean
    requestQuantity?: number | null
    remark?: string | null
  },
): Promise<number> {
  return insertDocItem(tx, {
    docId: input.docId,
    lotId: input.sourceLot.id,
    skuId: input.sourceLot.skuId,
    skuName: input.sourceLot.skuName,
    specName: input.sourceLot.specName,
    supplier: input.sourceLot.supplier,
    productSeries: input.sourceLot.productSeries,
    batchNo: input.sourceLot.batchNo,
    expiryDate: input.sourceLot.expiryDate,
    isGift: input.isGift,
    quantity: input.quantity,
    stockSnapshot: input.sourceLot.quantityOnHand,
    requestQuantity: input.requestQuantity,
    fulfilledQuantity: 0,
    standardUnitPrice: null,
    unitDiscount: null,
    actualUnitPrice: null,
    amount: null,
    supplyChainUnitCost: null,
    marketStandardUnitPrice: null,
    marketUnitDiscount: null,
    marketActualUnitPrice: null,
    storeStandardUnitPrice: null,
    storeUnitDiscount: null,
    storeActualUnitPrice: null,
    remark: input.remark,
  })
}

/** 品项公司发货只能从采购订单出发；正常发货受订单数量约束，额外数量必须明确标记为赠送。 */
export async function createItemCompanyShipment(
  session: AuthSession,
  input: CreateItemCompanyShipmentInput,
): Promise<{ id: string }> {
  const purchaseOrderId = required(input.purchaseOrderId, '采购订单')
  const sourceLocationId = required(input.sourceLocationId, '发货总部')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '品项公司发货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const order = await docForUpdate(tx, purchaseOrderId)
    if (order.docType !== '采购订单' || order.status === '已取消') {
      throw new ApiError('INVALID_STATE', '品项公司发货必须引用有效采购订单')
    }
    const marketId = required(order.marketId, '采购订单所属市场')
    if (order.sourceLocationId !== marketId) {
      throw new ApiError('INVALID_STATE', '采购订单的市场主体不一致')
    }
    if (order.targetLocationId !== sourceLocationId) {
      throw new ApiError('INVALID_STATE', '品项公司发货必须从采购订单指定的供应链主体发出')
    }
    const source = await locationForUpdate(tx, sourceLocationId)
    const market = await locationForUpdate(tx, marketId)
    assertType(source, '总部', '品项公司发货主体')
    assertType(market, '市场', '采购订单所属市场')
    assertLocationWritable(session, source)
    const seen = new Set<number>()
    const prepared: Array<{ orderItem: DocItemSnapshot; lot: LotSnapshot; quantity: number; giftQuantity: number; remark: string | null }> = []
    for (const line of input.items) {
      const purchaseOrderItemId = Number(line.purchaseOrderItemId)
      if (!Number.isInteger(purchaseOrderItemId) || purchaseOrderItemId <= 0 || seen.has(purchaseOrderItemId)) {
        throw new ApiError('INVALID_PARAMS', '采购订单明细不能重复发货')
      }
      seen.add(purchaseOrderItemId)
      const quantity = nonnegative(line.quantity, '发货数量')
      const giftQuantity = nonnegative(line.giftQuantity, '赠送数量')
      if (quantity + giftQuantity <= EPSILON) {
        throw new ApiError('INVALID_PARAMS', '发货数量和赠送数量不能同时为 0')
      }
      const orderItem = await docItemForUpdate(tx, purchaseOrderItemId, purchaseOrderId)
      const shipped = await linkedQuantity(tx, orderItem.id, '采购订单发货')
      if (nearlyGreater(quantity, orderItem.quantity - shipped)) {
        throw new ApiError('CONFLICT', '正常发货数量不能超过采购订单未发数量')
      }
      const lot = await lotForUpdate(tx, Number(line.lotId), sourceLocationId)
      if (lot.skuId !== orderItem.skuId) throw new ApiError('INVALID_PARAMS', '发货批次与采购订单 SKU 不一致')
      await loadLotSkuForMarket(tx, lot, marketIdForLocation(source))
      await assertLotAvailable(tx, lot, quantity + giftQuantity)
      prepared.push({ orderItem, lot, quantity, giftQuantity, remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, '品项公司发货')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity + line.giftQuantity, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '品项公司发货',
      status: '待收货',
      sourceLocationId,
      targetLocationId: marketId,
      marketId,
      supplierId: order.supplierId,
      supplierName: order.supplierName,
      docDate: input.docDate,
      relatedDocId: purchaseOrderId,
      logisticsCompany: input.logisticsCompany,
      trackingNo: input.trackingNo,
      totalQuantity,
      totalAmount: null,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      if (line.quantity > EPSILON) {
        const shipmentItemId = await insertOutboundShipmentItem(tx, {
          docId,
          sourceLot: line.lot,
          quantity: line.quantity,
          isGift: false,
          requestQuantity: line.orderItem.quantity,
          remark: line.remark,
        })
        await applyLotDelta(tx, {
          lot: line.lot,
          docId,
          docItemId: shipmentItemId,
          direction: '出库',
          quantityDelta: -line.quantity,
          createdBy: session.employeeId,
          movementKey: `shipment:${docId}:item:${shipmentItemId}`,
          remark: input.remark,
        })
        await insertDocLink(tx, {
          fromDocId: purchaseOrderId,
          toDocId: docId,
          relationType: '采购订单发货',
          fromItemId: line.orderItem.id,
          toItemId: shipmentItemId,
          quantity: line.quantity,
        })
        await insertReservation(tx, {
          requestDocId: purchaseOrderId,
          requestItemId: line.orderItem.id,
          lotId: line.lot.id,
          locationId: sourceLocationId,
          skuId: line.lot.skuId,
          quantity: line.quantity,
          fulfilledQuantity: line.quantity,
          status: '已完成',
          createdBy: session.employeeId,
        })
        await tx.execute(sql`
          UPDATE inventory_doc_items
             SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(line.quantity)}
           WHERE id = ${line.orderItem.id}
        `)
      }
      if (line.giftQuantity > EPSILON) {
        const giftItemId = await insertOutboundShipmentItem(tx, {
          docId,
          sourceLot: line.lot,
          quantity: line.giftQuantity,
          isGift: true,
          requestQuantity: 0,
          remark: line.remark,
        })
        await applyLotDelta(tx, {
          lot: line.lot,
          docId,
          docItemId: giftItemId,
          direction: '出库',
          quantityDelta: -line.giftQuantity,
          createdBy: session.employeeId,
          movementKey: `shipment:${docId}:gift:${giftItemId}`,
          remark: input.remark,
        })
        await insertDocLink(tx, {
          fromDocId: purchaseOrderId,
          toDocId: docId,
          relationType: '采购订单赠送发货',
          fromItemId: line.orderItem.id,
          toItemId: giftItemId,
          quantity: line.giftQuantity,
        })
        await insertReservation(tx, {
          requestDocId: purchaseOrderId,
          requestItemId: line.orderItem.id,
          lotId: line.lot.id,
          locationId: sourceLocationId,
          skuId: line.lot.skuId,
          quantity: line.giftQuantity,
          fulfilledQuantity: line.giftQuantity,
          status: '已完成',
          createdBy: session.employeeId,
        })
      }
    }
    return docId
  })
  await logOperation(session, 'inventory.item_company_shipment.create', 'inventory_docs', id, { purchaseOrderId })
  refreshInventoryPaths()
  return { id }
}

async function linkedSourcePricing(tx: Tx, shipmentItemId: number): Promise<PriceSnapshot> {
  const [row] = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT i.supply_chain_unit_cost, i.market_standard_unit_price, i.market_unit_discount,
           i.market_actual_unit_price, i.store_standard_unit_price, i.store_unit_discount,
           i.store_actual_unit_price
      FROM inventory_doc_links l
      JOIN inventory_doc_items i ON i.id = l.from_item_id
     WHERE l.to_item_id = ${shipmentItemId}
       AND l.relation_type IN ('采购订单发货', '采购订单赠送发货')
     ORDER BY l.relation_type
     LIMIT 1
  `))
  if (!row) throw new ApiError('INVALID_STATE', '发货明细缺少采购订单价格快照')
  return {
    supplyChainUnitCost: numberOrNull(row.supply_chain_unit_cost),
    marketStandardUnitPrice: numberOrNull(row.market_standard_unit_price),
    marketUnitDiscount: numberOrNull(row.market_unit_discount),
    marketActualUnitPrice: numberOrNull(row.market_actual_unit_price),
    storeStandardUnitPrice: numberOrNull(row.store_standard_unit_price),
    storeUnitDiscount: numberOrNull(row.store_unit_discount),
    storeActualUnitPrice: numberOrNull(row.store_actual_unit_price),
  }
}

async function completeShipmentIfFullyReceived(tx: Tx, shipmentId: string): Promise<void> {
  const [row] = rows<{ completed: boolean }>(await tx.execute(sql`
    SELECT COALESCE(BOOL_AND(COALESCE(fulfilled_quantity, 0) >= quantity), false) AS completed
      FROM inventory_doc_items
     WHERE doc_id = ${shipmentId}
  `))
  if (row?.completed) {
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已完成', updated_at = NOW()
       WHERE id = ${shipmentId}
         AND status = '待收货'
    `)
  }
}

async function receivePhysicalShipment(
  session: AuthSession,
  input: ReceiveShipmentInput,
  expectedDocType: '品项公司发货' | '分院配货',
  inboundDocType: '市场采购入库' | '院入库',
): Promise<{ id: string; shipmentId: string }> {
  const shipmentId = required(input.shipmentId, '发货单')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '收货至少需要一条明细')
  }
  await syncLocations()
  const inboundId = await db.transaction(async (tx) => {
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== expectedDocType || shipment.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '当前单据不能收货')
    }
    const source = await locationForUpdate(tx, required(shipment.sourceLocationId, '发货主体'))
    const targetLocationId = required(shipment.targetLocationId, '收货主体')
    const target = await locationForUpdate(tx, targetLocationId)
    assertLocationWritable(session, target)
    if (expectedDocType === '品项公司发货') {
      assertType(source, '总部', '品项公司发货主体')
      assertType(target, '市场', '市场收货主体')
      if (shipment.marketId !== target.locationId) {
        throw new ApiError('INVALID_STATE', '品项公司发货的市场归属不一致')
      }
    }
    if (expectedDocType === '分院配货') {
      assertType(source, '市场', '分院配货主体')
      assertType(target, '门店', '分院收货主体')
      if (shipment.marketId !== source.locationId || target.parentLocationId !== source.locationId) {
        throw new ApiError('INVALID_STATE', '分院配货的市场与门店归属不一致')
      }
    }
    const seen = new Set<number>()
    const prepared: Array<{ shipmentItem: DocItemSnapshot; quantity: number; sourceLot: LotSnapshot; price: PriceSnapshot; sku: SkuSnapshot; remark: string | null }> = []
    for (const line of input.items) {
      const shipmentItemId = Number(line.shipmentItemId)
      if (!Number.isInteger(shipmentItemId) || shipmentItemId <= 0 || seen.has(shipmentItemId)) {
        throw new ApiError('INVALID_PARAMS', '收货明细不能重复')
      }
      seen.add(shipmentItemId)
      const shipmentItem = await docItemForUpdate(tx, shipmentItemId, shipmentId)
      const quantity = positive(line.receivedQuantity, '实收数量')
      const received = shipmentItem.fulfilledQuantity ?? 0
      if (nearlyGreater(quantity, shipmentItem.quantity - received)) {
        throw new ApiError('CONFLICT', '实收数量不能超过待收数量')
      }
      if (!shipmentItem.lotId) throw new ApiError('INVALID_STATE', '发货明细缺少来源批次')
      const sourceLot = await lotForUpdate(tx, shipmentItem.lotId, shipment.sourceLocationId)
      const price = expectedDocType === '品项公司发货'
        ? await linkedSourcePricing(tx, shipmentItem.id)
        : priceFromItem(shipmentItem)
      const sku = await loadSku(tx, shipmentItem.skuId, false, false)
      assertSkuAvailableToMarket(sku, marketIdForLocation(source))
      assertSkuAvailableToMarket(sku, marketIdForLocation(target))
      prepared.push({ shipmentItem, quantity, sourceLot, price, sku, remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, inboundDocType)
    const totalQuantity = fixed(prepared.reduce((sum, item) => sum + item.quantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, item) => {
      if (item.shipmentItem.isGift) return sum
      return sum + item.quantity * Number(
        inboundDocType === '市场采购入库'
          ? item.price.marketActualUnitPrice ?? 0
          : item.price.storeActualUnitPrice ?? 0,
      )
    }, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: inboundDocType,
      status: '已完成',
      sourceLocationId: shipment.sourceLocationId,
      targetLocationId,
      marketId: shipment.marketId,
      supplierId: shipment.supplierId,
      supplierName: shipment.supplierName,
      docDate: input.docDate,
      relatedDocId: shipmentId,
      requestDocId: shipment.relatedDocId,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const targetLot = await upsertLot(tx, {
        locationId: targetLocationId,
        skuId: item.shipmentItem.skuId,
        skuName: item.shipmentItem.skuName,
        specName: item.shipmentItem.specName,
        supplier: item.shipmentItem.supplier,
        productSeries: item.shipmentItem.productSeries,
        batchNo: item.shipmentItem.batchNo,
        expiryDate: item.shipmentItem.expiryDate,
        isGift: item.shipmentItem.isGift,
        supplyChainUnitCost: item.price.supplyChainUnitCost ?? item.sourceLot.supplyChainUnitCost,
        marketStandardUnitPrice: item.price.marketStandardUnitPrice,
        marketUnitDiscount: item.price.marketUnitDiscount,
        marketActualUnitPrice: item.price.marketActualUnitPrice,
        storeStandardUnitPrice: item.price.storeStandardUnitPrice ?? item.sku.storePurchasePrice,
        storeUnitDiscount: item.price.storeUnitDiscount ?? 0,
        storeActualUnitPrice: item.price.storeActualUnitPrice ?? item.sku.storePurchasePrice,
        sourceDocId: docId,
      })
      const actualUnitPrice = inboundDocType === '市场采购入库'
        ? item.price.marketActualUnitPrice
        : item.price.storeActualUnitPrice
      const docItemId = await insertDocItem(tx, {
        docId,
        lotId: targetLot.id,
        skuId: targetLot.skuId,
        skuName: targetLot.skuName,
        specName: targetLot.specName,
        supplier: targetLot.supplier,
        productSeries: targetLot.productSeries,
        batchNo: targetLot.batchNo,
        expiryDate: targetLot.expiryDate,
        isGift: targetLot.isGift,
        quantity: item.quantity,
        stockSnapshot: targetLot.quantityOnHand,
        standardUnitPrice: inboundDocType === '市场采购入库'
          ? item.price.marketStandardUnitPrice
          : item.price.storeStandardUnitPrice,
        unitDiscount: inboundDocType === '市场采购入库'
          ? item.price.marketUnitDiscount
          : item.price.storeUnitDiscount,
        actualUnitPrice,
        amount: targetLot.isGift || actualUnitPrice === null ? 0 : fixed(item.quantity * actualUnitPrice),
        ...priceFromLot(targetLot),
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot: targetLot,
        docId,
        docItemId,
        direction: '入库',
        quantityDelta: item.quantity,
        createdBy: session.employeeId,
        movementKey: `receipt:${shipmentId}:item:${docItemId}`,
        remark: input.remark,
      })
      await insertDocLink(tx, {
        fromDocId: shipmentId,
        toDocId: docId,
        relationType: '发货收货',
        fromItemId: item.shipmentItem.id,
        toItemId: docItemId,
        quantity: item.quantity,
      })
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(item.quantity)}
         WHERE id = ${item.shipmentItem.id}
      `)
    }
    await completeShipmentIfFullyReceived(tx, shipmentId)
    return docId
  })
  await logOperation(session, 'inventory.shipment.receive', 'inventory_docs', inboundId, { shipmentId, inboundDocType })
  refreshInventoryPaths()
  return { id: inboundId, shipmentId }
}

export async function receiveItemCompanyShipment(
  session: AuthSession,
  input: ReceiveShipmentInput,
): Promise<{ id: string; shipmentId: string }> {
  return receivePhysicalShipment(session, input, '品项公司发货', '市场采购入库')
}

/** 分院配货只允许关联对应门店报货；正常数量受需求限制，赠送数量在独立明细中保留。 */
export async function createStoreAllocation(
  session: AuthSession,
  input: CreateStoreAllocationInput,
): Promise<{ id: string }> {
  const storeRequestId = required(input.storeRequestId, '门店报货单')
  const sourceMarketId = required(input.sourceMarketId, '配货市场')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '分院配货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const request = await docForUpdate(tx, storeRequestId)
    if (request.docType !== '门店报货' || request.status === '已取消') {
      throw new ApiError('INVALID_STATE', '分院配货必须引用有效门店报货单')
    }
    const storeId = required(request.sourceLocationId, '门店报货主体')
    const marketId = required(request.marketId, '门店报货所属市场')
    if (marketId !== sourceMarketId) throw new ApiError('INVALID_PARAMS', '配货市场必须与门店报货所属市场一致')
    if (request.targetLocationId !== sourceMarketId) {
      throw new ApiError('INVALID_STATE', '门店报货单的接收市场不一致')
    }
    const market = await locationForUpdate(tx, sourceMarketId)
    const store = await locationForUpdate(tx, storeId)
    assertType(market, '市场', '配货市场')
    assertType(store, '门店', '收货门店')
    if (store.parentLocationId !== market.locationId) throw new ApiError('INVALID_STATE', '门店不属于当前配货市场')
    assertLocationWritable(session, market)
    const seen = new Set<number>()
    const prepared: Array<{
      requestItem: DocItemSnapshot
      lot: LotSnapshot
      quantity: number
      giftQuantity: number
      price: PriceSnapshot
      remark: string | null
    }> = []
    for (const line of input.items) {
      const requestItemId = Number(line.requestItemId)
      if (!Number.isInteger(requestItemId) || requestItemId <= 0 || seen.has(requestItemId)) {
        throw new ApiError('INVALID_PARAMS', '门店报货明细不能重复配货')
      }
      seen.add(requestItemId)
      const quantity = nonnegative(line.quantity, '配货数量')
      const giftQuantity = nonnegative(line.giftQuantity, '赠送数量')
      if (quantity + giftQuantity <= EPSILON) throw new ApiError('INVALID_PARAMS', '配货数量和赠送数量不能同时为 0')
      const requestItem = await docItemForUpdate(tx, requestItemId, storeRequestId)
      const allocated = await linkedQuantity(tx, requestItem.id, '门店报货配货')
      if (nearlyGreater(quantity, requestItem.quantity - allocated)) {
        throw new ApiError('CONFLICT', '正常配货数量不能超过门店报货未配数量')
      }
      const lot = await lotForUpdate(tx, Number(line.lotId), sourceMarketId)
      if (lot.skuId !== requestItem.skuId) throw new ApiError('INVALID_PARAMS', '配货批次与门店报货 SKU 不一致')
      await assertLotAvailable(tx, lot, quantity + giftQuantity)
      const sku = await loadLotSkuForMarket(tx, lot, sourceMarketId)
      if (sku.storePurchasePrice === null) {
        throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置门店进货价`)
      }
      const discount = nonnegative(line.storeUnitDiscount, '门店单价优惠')
      const actual = fixed(sku.storePurchasePrice - discount)
      if (actual < -EPSILON) throw new ApiError('INVALID_PARAMS', '门店单价优惠不能高于门店进货价')
      prepared.push({
        requestItem,
        lot,
        quantity,
        giftQuantity,
        price: {
          supplyChainUnitCost: lot.supplyChainUnitCost,
          marketStandardUnitPrice: lot.marketStandardUnitPrice,
          marketUnitDiscount: lot.marketUnitDiscount,
          marketActualUnitPrice: lot.marketActualUnitPrice,
          storeStandardUnitPrice: sku.storePurchasePrice,
          storeUnitDiscount: discount,
          storeActualUnitPrice: Math.max(actual, 0),
        },
        remark: text(line.remark),
      })
    }
    const docId = await generateDocId(tx, '分院配货')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity + line.giftQuantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, line) => sum + line.quantity * Number(line.price.storeActualUnitPrice ?? 0), 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '分院配货',
      status: '待收货',
      sourceLocationId: sourceMarketId,
      targetLocationId: storeId,
      marketId: sourceMarketId,
      docDate: input.docDate,
      requestDocId: storeRequestId,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      if (line.quantity > EPSILON) {
        const itemId = await insertDocItem(tx, {
          docId,
          lotId: line.lot.id,
          skuId: line.lot.skuId,
          skuName: line.lot.skuName,
          specName: line.lot.specName,
          supplier: line.lot.supplier,
          productSeries: line.lot.productSeries,
          batchNo: line.lot.batchNo,
          expiryDate: line.lot.expiryDate,
          isGift: false,
          quantity: line.quantity,
          stockSnapshot: line.lot.quantityOnHand,
          requestQuantity: line.requestItem.quantity,
          fulfilledQuantity: 0,
          standardUnitPrice: line.price.storeStandardUnitPrice,
          unitDiscount: line.price.storeUnitDiscount,
          actualUnitPrice: line.price.storeActualUnitPrice,
          amount: fixed(line.quantity * Number(line.price.storeActualUnitPrice ?? 0)),
          ...line.price,
          remark: line.remark,
        })
        await applyLotDelta(tx, {
          lot: line.lot,
          docId,
          docItemId: itemId,
          direction: '出库',
          quantityDelta: -line.quantity,
          createdBy: session.employeeId,
          movementKey: `allocation:${docId}:item:${itemId}`,
          remark: input.remark,
        })
        await insertDocLink(tx, {
          fromDocId: storeRequestId,
          toDocId: docId,
          relationType: '门店报货配货',
          fromItemId: line.requestItem.id,
          toItemId: itemId,
          quantity: line.quantity,
        })
        await insertReservation(tx, {
          requestDocId: storeRequestId,
          requestItemId: line.requestItem.id,
          lotId: line.lot.id,
          locationId: sourceMarketId,
          skuId: line.lot.skuId,
          quantity: line.quantity,
          fulfilledQuantity: line.quantity,
          status: '已完成',
          createdBy: session.employeeId,
        })
        await tx.execute(sql`
          UPDATE inventory_doc_items
             SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(line.quantity)}
           WHERE id = ${line.requestItem.id}
        `)
      }
      if (line.giftQuantity > EPSILON) {
        const itemId = await insertDocItem(tx, {
          docId,
          lotId: line.lot.id,
          skuId: line.lot.skuId,
          skuName: line.lot.skuName,
          specName: line.lot.specName,
          supplier: line.lot.supplier,
          productSeries: line.lot.productSeries,
          batchNo: line.lot.batchNo,
          expiryDate: line.lot.expiryDate,
          isGift: true,
          quantity: line.giftQuantity,
          stockSnapshot: line.lot.quantityOnHand,
          requestQuantity: 0,
          fulfilledQuantity: 0,
          standardUnitPrice: line.price.storeStandardUnitPrice,
          unitDiscount: line.price.storeUnitDiscount,
          actualUnitPrice: line.price.storeActualUnitPrice,
          amount: 0,
          ...line.price,
          remark: line.remark,
        })
        await applyLotDelta(tx, {
          lot: line.lot,
          docId,
          docItemId: itemId,
          direction: '出库',
          quantityDelta: -line.giftQuantity,
          createdBy: session.employeeId,
          movementKey: `allocation:${docId}:gift:${itemId}`,
          remark: input.remark,
        })
        await insertDocLink(tx, {
          fromDocId: storeRequestId,
          toDocId: docId,
          relationType: '门店报货赠送配货',
          fromItemId: line.requestItem.id,
          toItemId: itemId,
          quantity: line.giftQuantity,
        })
        await insertReservation(tx, {
          requestDocId: storeRequestId,
          requestItemId: line.requestItem.id,
          lotId: line.lot.id,
          locationId: sourceMarketId,
          skuId: line.lot.skuId,
          quantity: line.giftQuantity,
          fulfilledQuantity: line.giftQuantity,
          status: '已完成',
          createdBy: session.employeeId,
        })
      }
    }
    return docId
  })
  await logOperation(session, 'inventory.store_allocation.create', 'inventory_docs', id, { storeRequestId, sourceMarketId })
  refreshInventoryPaths()
  return { id }
}

export async function receiveStoreAllocation(
  session: AuthSession,
  input: ReceiveShipmentInput,
): Promise<{ id: string; shipmentId: string }> {
  return receivePhysicalShipment(session, input, '分院配货', '院入库')
}

/** 退货创建时只预留来源批次；市场/总部审批后才会同时出库和回库，避免悬空库存。 */
export async function createReturnForRestock(
  session: AuthSession,
  input: CreateReturnForRestockInput,
): Promise<{ id: string }> {
  const sourceLocationId = required(input.sourceLocationId, '退货主体')
  const targetLocationId = required(input.targetLocationId, '回库主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '退货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const source = await locationForUpdate(tx, sourceLocationId)
    const target = await locationForUpdate(tx, targetLocationId)
    assertLocationWritable(session, source)
    let docType: '院退货' | '市场退货'
    let marketId: string
    if (source.locationType === '门店') {
      assertType(target, '市场', '门店退货回库主体')
      if (source.parentLocationId !== target.locationId) {
        throw new ApiError('INVALID_PARAMS', '门店只能退回所属市场')
      }
      docType = '院退货'
      marketId = target.locationId
    } else if (source.locationType === '市场') {
      assertType(target, '总部', '市场退货回库主体')
      docType = '市场退货'
      marketId = source.locationId
    } else {
      throw new ApiError('INVALID_PARAMS', '只有门店或市场可以创建退货')
    }
    const seenLots = new Set<number>()
    const prepared: Array<{ lot: LotSnapshot; quantity: number; reason: string | null; remark: string | null }> = []
    for (const line of input.items) {
      const lotId = Number(line.lotId)
      if (!Number.isInteger(lotId) || lotId <= 0 || seenLots.has(lotId)) {
        throw new ApiError('INVALID_PARAMS', '退货批次不能重复')
      }
      seenLots.add(lotId)
      const lot = await lotForUpdate(tx, lotId, sourceLocationId)
      const quantity = positive(line.quantity, '退货数量')
      await assertLotAvailable(tx, lot, quantity)
      const sku = await loadLotSkuForMarket(tx, lot, marketId)
      assertSkuAvailableToMarket(sku, marketIdForLocation(target))
      prepared.push({ lot, quantity, reason: text(line.reason), remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, docType)
    const totalQuantity = fixed(prepared.reduce((sum, item) => sum + item.quantity, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType,
      status: '待审批',
      sourceLocationId,
      targetLocationId,
      marketId,
      docDate: input.docDate,
      totalQuantity,
      totalAmount: null,
      remark: input.remark,
      createdBy: session.employeeId,
    })
    for (const item of prepared) {
      const docItemId = await insertDocItem(tx, {
        docId,
        lotId: item.lot.id,
        skuId: item.lot.skuId,
        skuName: item.lot.skuName,
        specName: item.lot.specName,
        supplier: item.lot.supplier,
        productSeries: item.lot.productSeries,
        batchNo: item.lot.batchNo,
        expiryDate: item.lot.expiryDate,
        isGift: item.lot.isGift,
        quantity: item.quantity,
        stockSnapshot: item.lot.quantityOnHand,
        fulfilledQuantity: 0,
        standardUnitPrice: item.lot.storeStandardUnitPrice ?? item.lot.marketStandardUnitPrice,
        unitDiscount: item.lot.storeUnitDiscount ?? item.lot.marketUnitDiscount,
        actualUnitPrice: item.lot.storeActualUnitPrice ?? item.lot.marketActualUnitPrice,
        amount: null,
        ...priceFromLot(item.lot),
        reason: item.reason,
        remark: item.remark,
      })
      await insertReservation(tx, {
        requestDocId: docId,
        requestItemId: docItemId,
        lotId: item.lot.id,
        locationId: sourceLocationId,
        skuId: item.lot.skuId,
        quantity: item.quantity,
        status: '已预留',
        createdBy: session.employeeId,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.return.create', 'inventory_docs', id, { sourceLocationId, targetLocationId })
  refreshInventoryPaths()
  return { id }
}

async function allDocItemsForUpdate(tx: Tx, docId: string): Promise<DocItemSnapshot[]> {
  const raw = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, doc_id, lot_id, sku_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity, stock_snapshot, request_quantity,
           fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price, amount,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price, reason, remark
      FROM inventory_doc_items
     WHERE doc_id = ${docId}
     ORDER BY id
     FOR UPDATE
  `))
  return raw.map(asDocItem)
}

export async function approveReturnForRestock(
  session: AuthSession,
  input: { returnDocId: string; auditRemark?: string | null },
): Promise<{ id: string; returnDocId: string }> {
  const returnDocId = required(input.returnDocId, '退货单')
  await syncLocations()
  const inboundId = await db.transaction(async (tx) => {
    const returnDoc = await docForUpdate(tx, returnDocId)
    if (!['院退货', '市场退货'].includes(returnDoc.docType) || returnDoc.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '当前单据不能审批回库')
    }
    const sourceLocationId = required(returnDoc.sourceLocationId, '退货主体')
    const targetLocationId = required(returnDoc.targetLocationId, '回库主体')
    const source = await locationForUpdate(tx, sourceLocationId)
    const target = await locationForUpdate(tx, targetLocationId)
    assertLocationWritable(session, target)
    const inboundDocType = returnDoc.docType === '院退货' ? '市场退货入库' : '供应链退货入库'
    const items = await allDocItemsForUpdate(tx, returnDocId)
    if (items.length === 0) throw new ApiError('INVALID_STATE', '退货单没有可回库明细')
    const docId = await generateDocId(tx, inboundDocType)
    const totalQuantity = fixed(items.reduce((sum, item) => sum + item.quantity, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: inboundDocType,
      status: '已完成',
      sourceLocationId,
      targetLocationId,
      marketId: returnDoc.marketId,
      docDate: shanghaiToday(),
      relatedDocId: returnDocId,
      totalQuantity,
      totalAmount: null,
      remark: input.auditRemark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of items) {
      if (!item.lotId) throw new ApiError('INVALID_STATE', '退货明细缺少来源批次')
      const [reservation] = rows<{
        quantity: string | number
        fulfilled_quantity: string | number
        released_quantity: string | number
      }>(await tx.execute(sql`
        SELECT quantity, fulfilled_quantity, released_quantity
          FROM inventory_stock_reservations
         WHERE request_doc_id = ${returnDocId}
           AND request_item_id = ${item.id}
           AND lot_id = ${item.lotId}
           AND status = '已预留'
         FOR UPDATE
      `))
      if (!reservation) throw new ApiError('CONFLICT', '退货库存预留已失效，请刷新后重试')
      const reservedAvailable = Number(reservation.quantity) - Number(reservation.fulfilled_quantity) - Number(reservation.released_quantity)
      if (nearlyGreater(item.quantity, reservedAvailable)) {
        throw new ApiError('CONFLICT', '退货库存预留数量不足')
      }
      const sourceLot = await lotForUpdate(tx, item.lotId, sourceLocationId)
      if (nearlyGreater(item.quantity, sourceLot.quantityOnHand)) {
        throw new ApiError('INVALID_STATE', '退货批次当前库存不足')
      }
      const sku = await loadLotSkuForMarket(tx, sourceLot, marketIdForLocation(source))
      assertSkuAvailableToMarket(sku, marketIdForLocation(target))
      const targetLot = await upsertLot(tx, {
        locationId: targetLocationId,
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        supplier: item.supplier,
        productSeries: item.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        ...priceFromItem(item),
        sourceDocId: docId,
      })
      const inboundItemId = await insertDocItem(tx, {
        docId,
        lotId: targetLot.id,
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        supplier: item.supplier,
        productSeries: item.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        quantity: item.quantity,
        stockSnapshot: targetLot.quantityOnHand,
        standardUnitPrice: item.standardUnitPrice,
        unitDiscount: item.unitDiscount,
        actualUnitPrice: item.actualUnitPrice,
        amount: null,
        ...priceFromItem(item),
        reason: item.reason,
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot: sourceLot,
        docId: returnDocId,
        docItemId: item.id,
        direction: '出库',
        quantityDelta: -item.quantity,
        createdBy: session.employeeId,
        movementKey: `return:${returnDocId}:item:${item.id}`,
        remark: input.auditRemark,
      })
      await applyLotDelta(tx, {
        lot: targetLot,
        docId,
        docItemId: inboundItemId,
        direction: '入库',
        quantityDelta: item.quantity,
        createdBy: session.employeeId,
        movementKey: `return-receipt:${returnDocId}:item:${inboundItemId}`,
        remark: input.auditRemark,
      })
      await insertDocLink(tx, {
        fromDocId: returnDocId,
        toDocId: docId,
        relationType: '退货回库',
        fromItemId: item.id,
        toItemId: inboundItemId,
        quantity: item.quantity,
      })
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = ${numeric(item.quantity)}
         WHERE id = ${item.id}
      `)
      await tx.execute(sql`
        UPDATE inventory_stock_reservations
           SET fulfilled_quantity = ${numeric(item.quantity)},
               status = '已完成',
               updated_at = NOW()
         WHERE request_doc_id = ${returnDocId}
           AND request_item_id = ${item.id}
           AND lot_id = ${item.lotId}
           AND status = '已预留'
      `)
    }
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已完成', approved_by = ${session.employeeId}, approved_at = NOW(),
             audit_remark = ${text(input.auditRemark)}, updated_at = NOW()
       WHERE id = ${returnDocId}
    `)
    return docId
  })
  await logOperation(session, 'inventory.return.approve', 'inventory_docs', returnDocId, { inboundId })
  refreshInventoryPaths()
  return { id: inboundId, returnDocId }
}

export async function rejectReturnForRestock(
  session: AuthSession,
  input: { returnDocId: string; auditRemark: string },
): Promise<{ success: true }> {
  const returnDocId = required(input.returnDocId, '退货单')
  const auditRemark = required(input.auditRemark, '驳回原因')
  await syncLocations()
  await db.transaction(async (tx) => {
    const returnDoc = await docForUpdate(tx, returnDocId)
    if (!['院退货', '市场退货'].includes(returnDoc.docType) || returnDoc.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '当前单据不能驳回')
    }
    const target = await locationForUpdate(tx, required(returnDoc.targetLocationId, '回库主体'))
    assertLocationWritable(session, target)
    await tx.execute(sql`
      UPDATE inventory_stock_reservations
         SET released_quantity = quantity,
             status = '已释放',
             updated_at = NOW()
       WHERE request_doc_id = ${returnDocId}
         AND status = '已预留'
    `)
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已驳回', rejected_by = ${session.employeeId}, rejected_at = NOW(),
             audit_remark = ${auditRemark}, updated_at = NOW()
       WHERE id = ${returnDocId}
    `)
  })
  await logOperation(session, 'inventory.return.reject', 'inventory_docs', returnDocId, { auditRemark })
  refreshInventoryPaths()
  return { success: true }
}

/** 仅未发生任何实收的品项公司发货可撤回；撤回以反向库存流水恢复总部批次。 */
export async function cancelItemCompanyShipment(
  session: AuthSession,
  input: { shipmentId: string; cancellationReason: string },
): Promise<{ success: true }> {
  const shipmentId = required(input.shipmentId, '品项公司发货单')
  const cancellationReason = required(input.cancellationReason, '撤回原因')
  await syncLocations()
  await db.transaction(async (tx) => {
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== '品项公司发货' || shipment.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '只有待收货的品项公司发货单可以撤回')
    }
    const source = await locationForUpdate(tx, required(shipment.sourceLocationId, '发货主体'))
    assertType(source, '总部', '发货主体')
    assertLocationWritable(session, source)
    const items = await allDocItemsForUpdate(tx, shipmentId)
    if (items.some((item) => (item.fulfilledQuantity ?? 0) > EPSILON)) {
      throw new ApiError('CONFLICT', '已有实收记录的发货单不可撤回')
    }
    for (const item of items) {
      if (!item.lotId) throw new ApiError('INVALID_STATE', '发货明细缺少来源批次')
      const sourceLot = await lotForUpdate(tx, item.lotId, source.locationId)
      await applyLotDelta(tx, {
        lot: sourceLot,
        docId: shipmentId,
        docItemId: item.id,
        direction: '调整',
        quantityDelta: item.quantity,
        createdBy: session.employeeId,
        movementKey: `shipment-cancel:${shipmentId}:item:${item.id}`,
        remark: cancellationReason,
      })
    }
    await tx.execute(sql`
      UPDATE inventory_doc_items purchase_item
         SET fulfilled_quantity = GREATEST(0, COALESCE(purchase_item.fulfilled_quantity, 0) - cancelled.quantity)
        FROM (
          SELECT from_item_id, COALESCE(SUM(quantity), 0) AS quantity
            FROM inventory_doc_links
           WHERE to_doc_id = ${shipmentId}
             AND relation_type = '采购订单发货'
           GROUP BY from_item_id
        ) cancelled
       WHERE purchase_item.id = cancelled.from_item_id
    `)
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已取消', cancellation_reason = ${cancellationReason},
             cancelled_by = ${session.employeeId}, cancelled_at = NOW(), updated_at = NOW()
       WHERE id = ${shipmentId}
    `)
  })
  await logOperation(session, 'inventory.item_company_shipment.cancel', 'inventory_docs', shipmentId, { cancellationReason })
  refreshInventoryPaths()
  return { success: true }
}

/**
 * 市场员工购只从市场库存出库，并强制使用商品资料的市场员工购价。
 * 它不创建 sale_orders，因此不会进入任一门店营收。
 */
export async function createMarketStaffPurchase(
  session: AuthSession,
  input: CreateMarketStaffPurchaseInput,
): Promise<{ id: string }> {
  const marketId = required(input.marketId, '市场')
  const employeeId = required(input.employeeId, '购买员工')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '市场员工购至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '员工购出库主体')
    assertLocationWritable(session, market)
    const employee = await employeeForMarket(tx, employeeId, marketId)
    const seenLots = new Set<number>()
    const prepared: Array<{ lot: LotSnapshot; quantity: number; price: number; remark: string | null }> = []
    for (const line of input.items) {
      const lotId = Number(line.lotId)
      if (!Number.isInteger(lotId) || lotId <= 0 || seenLots.has(lotId)) {
        throw new ApiError('INVALID_PARAMS', '员工购库存批次不能重复')
      }
      seenLots.add(lotId)
      const lot = await lotForUpdate(tx, lotId, marketId)
      const quantity = positive(line.quantity, '员工购数量')
      await assertLotAvailable(tx, lot, quantity)
      const sku = await loadLotSkuForMarket(tx, lot, marketId)
      if (sku.marketStaffPurchasePrice === null) {
        throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置市场员工购价格`)
      }
      prepared.push({
        lot,
        quantity,
        price: sku.marketStaffPurchasePrice,
        remark: text(line.remark),
      })
    }
    const docId = await generateDocId(tx, '员工购出库')
    const totalQuantity = fixed(prepared.reduce((sum, item) => sum + item.quantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, item) => sum + item.quantity * item.price, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '员工购出库',
      status: '已完成',
      sourceLocationId: marketId,
      marketId,
      employeeId: employee.id,
      employeeName: employee.name,
      docDate: input.docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const docItemId = await insertDocItem(tx, {
        docId,
        lotId: item.lot.id,
        skuId: item.lot.skuId,
        skuName: item.lot.skuName,
        specName: item.lot.specName,
        supplier: item.lot.supplier,
        productSeries: item.lot.productSeries,
        batchNo: item.lot.batchNo,
        expiryDate: item.lot.expiryDate,
        isGift: false,
        quantity: item.quantity,
        stockSnapshot: item.lot.quantityOnHand,
        standardUnitPrice: item.price,
        unitDiscount: 0,
        actualUnitPrice: item.price,
        amount: fixed(item.quantity * item.price),
        ...priceFromLot(item.lot),
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot: item.lot,
        docId,
        docItemId,
        direction: '出库',
        quantityDelta: -item.quantity,
        createdBy: session.employeeId,
        movementKey: `market-staff-purchase:${docId}:item:${docItemId}`,
        remark: input.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.market_staff_purchase.create', 'inventory_docs', id, { marketId, employeeId })
  refreshInventoryPaths()
  return { id }
}

/** 市场财务登记自采产品入库；只接收归属当前市场的市场自采/转让店 SKU。 */
export async function createSelfPurchasedReceipt(
  session: AuthSession,
  input: CreateSelfPurchasedReceiptInput,
): Promise<{ id: string }> {
  assertMarketFinance(session)
  const marketId = required(input.marketId, '市场')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '自采产品入库至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '自采入库主体')
    assertLocationWritable(session, market)
    const supplier = input.supplierId ? await ensureSupplier(tx, required(input.supplierId, '供应商')) : null
    const supplierName = supplier?.name ?? required(input.supplierName, '自采供应商名称')
    const seenSkus = new Set<string>()
    const prepared: Array<{
      sku: SkuSnapshot
      quantity: number
      batchNo: string
      expiryDate: string | null
      isGift: boolean
      marketActualUnitPrice: number
      storeUnitDiscount: number
      storeActualUnitPrice: number | null
      remark: string | null
    }> = []
    for (const line of input.items) {
      const skuId = required(line.skuId, '自采库存 SKU')
      if (seenSkus.has(skuId)) throw new ApiError('INVALID_PARAMS', '同一自采 SKU 请合并为一条入库明细')
      seenSkus.add(skuId)
      const sku = await loadSku(tx, skuId)
      assertSkuAvailableToMarket(sku, marketId)
      if (sku.sourceType === '供应链') {
        throw new ApiError('INVALID_STATE', '自采入库只能使用归属当前市场的市场自采或转让店 SKU')
      }
      const quantity = positive(line.quantity, '自采入库数量')
      const marketActualUnitPrice = nonnegative(
        line.marketActualUnitPrice ?? sku.itemCompanyPurchasePrice ?? sku.marketPurchasePrice,
        '市场自采实际单价',
      )
      const storeUnitDiscount = nonnegative(line.storeUnitDiscount, '门店单价优惠')
      const storeActualUnitPrice = sku.storePurchasePrice === null
        ? null
        : fixed(sku.storePurchasePrice - storeUnitDiscount)
      if (storeActualUnitPrice !== null && storeActualUnitPrice < -EPSILON) {
        throw new ApiError('INVALID_PARAMS', '门店单价优惠不能高于门店进货价')
      }
      prepared.push({
        sku,
        quantity,
        batchNo: text(line.batchNo) ?? '',
        expiryDate: text(line.expiryDate),
        isGift: Boolean(line.isGift),
        marketActualUnitPrice,
        storeUnitDiscount,
        storeActualUnitPrice: storeActualUnitPrice === null ? null : Math.max(0, storeActualUnitPrice),
        remark: text(line.remark),
      })
    }
    const docId = await generateDocId(tx, '自采产品入库')
    const totalQuantity = fixed(prepared.reduce((sum, item) => sum + item.quantity, 0))
    const totalAmount = fixed(prepared.reduce(
      (sum, item) => sum + (item.isGift ? 0 : item.quantity * item.marketActualUnitPrice),
      0,
    ))
    await insertDocHeader(tx, {
      id: docId,
      docType: '自采产品入库',
      status: '已完成',
      targetLocationId: marketId,
      marketId,
      supplierId: supplier?.id ?? null,
      supplierName,
      receiptAttachmentUrl: input.receiptAttachmentUrl,
      docDate: input.docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const lot = await upsertLot(tx, {
        locationId: marketId,
        skuId: item.sku.skuId,
        skuName: item.sku.productName,
        specName: item.sku.specName,
        supplier: supplierName,
        productSeries: item.sku.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        supplyChainUnitCost: null,
        marketStandardUnitPrice: item.marketActualUnitPrice,
        marketUnitDiscount: 0,
        marketActualUnitPrice: item.marketActualUnitPrice,
        storeStandardUnitPrice: item.sku.storePurchasePrice,
        storeUnitDiscount: item.storeUnitDiscount,
        storeActualUnitPrice: item.storeActualUnitPrice,
        sourceDocId: docId,
      })
      const docItemId = await insertDocItem(tx, {
        docId,
        lotId: lot.id,
        skuId: lot.skuId,
        skuName: lot.skuName,
        specName: lot.specName,
        supplier: lot.supplier,
        productSeries: lot.productSeries,
        batchNo: lot.batchNo,
        expiryDate: lot.expiryDate,
        isGift: lot.isGift,
        quantity: item.quantity,
        stockSnapshot: lot.quantityOnHand,
        standardUnitPrice: item.marketActualUnitPrice,
        unitDiscount: 0,
        actualUnitPrice: item.marketActualUnitPrice,
        amount: lot.isGift ? 0 : fixed(item.quantity * item.marketActualUnitPrice),
        ...priceFromLot(lot),
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot,
        docId,
        docItemId,
        direction: '入库',
        quantityDelta: item.quantity,
        createdBy: session.employeeId,
        movementKey: `self-purchase-receipt:${docId}:item:${docItemId}`,
        remark: input.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.self_purchase_receipt.create', 'inventory_docs', id, { marketId })
  refreshInventoryPaths()
  return { id }
}

/** 非凤御市场出库必须记录外部对象，但不生成销售单或门店营收。 */
export async function createExternalMarketOutbound(
  session: AuthSession,
  input: CreateExternalMarketOutboundInput,
): Promise<{ id: string }> {
  const marketId = required(input.marketId, '市场')
  const externalPartyName = required(input.externalPartyName, '外部对象')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '非凤御市场出库至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '非凤御市场出库主体')
    assertLocationWritable(session, market)
    const seenLots = new Set<number>()
    const prepared: Array<{ lot: LotSnapshot; quantity: number; remark: string | null }> = []
    for (const line of input.items) {
      const lotId = Number(line.lotId)
      if (!Number.isInteger(lotId) || lotId <= 0 || seenLots.has(lotId)) {
        throw new ApiError('INVALID_PARAMS', '出库库存批次不能重复')
      }
      seenLots.add(lotId)
      const lot = await lotForUpdate(tx, lotId, marketId)
      const quantity = positive(line.quantity, '出库数量')
      await assertLotAvailable(tx, lot, quantity)
      await loadLotSkuForMarket(tx, lot, marketId)
      prepared.push({ lot, quantity, remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, '非凤御市场出库')
    await insertDocHeader(tx, {
      id: docId,
      docType: '非凤御市场出库',
      status: '已完成',
      sourceLocationId: marketId,
      marketId,
      externalPartyName,
      docDate: input.docDate,
      totalQuantity: fixed(prepared.reduce((sum, item) => sum + item.quantity, 0)),
      totalAmount: null,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const docItemId = await insertDocItem(tx, {
        docId,
        lotId: item.lot.id,
        skuId: item.lot.skuId,
        skuName: item.lot.skuName,
        specName: item.lot.specName,
        supplier: item.lot.supplier,
        productSeries: item.lot.productSeries,
        batchNo: item.lot.batchNo,
        expiryDate: item.lot.expiryDate,
        isGift: item.lot.isGift,
        quantity: item.quantity,
        stockSnapshot: item.lot.quantityOnHand,
        standardUnitPrice: item.lot.marketStandardUnitPrice,
        unitDiscount: item.lot.marketUnitDiscount,
        actualUnitPrice: item.lot.marketActualUnitPrice,
        amount: null,
        ...priceFromLot(item.lot),
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot: item.lot,
        docId,
        docItemId,
        direction: '出库',
        quantityDelta: -item.quantity,
        createdBy: session.employeeId,
        movementKey: `external-market-outbound:${docId}:item:${docItemId}`,
        remark: input.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.external_market_outbound.create', 'inventory_docs', id, { marketId, externalPartyName })
  refreshInventoryPaths()
  return { id }
}

/** 库存转换在同一事务内创建关联的出入库单，任何一侧失败都会回滚。 */
export async function createInventoryConversion(
  session: AuthSession,
  input: CreateInventoryConversionInput,
): Promise<{ outboundId: string; inboundId: string }> {
  const locationId = required(input.locationId, '转换库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '库存转换至少需要一条明细')
  }
  await syncLocations()
  const ids = await db.transaction(async (tx) => {
    const location = await locationForUpdate(tx, locationId)
    assertLocationWritable(session, location)
    const seenLots = new Set<number>()
    const prepared: Array<{
      sourceLot: LotSnapshot
      sourceQuantity: number
      targetSku: SkuSnapshot
      targetQuantity: number
      targetBatchNo: string
      targetExpiryDate: string | null
      remark: string | null
    }> = []
    for (const line of input.items) {
      const sourceLotId = Number(line.sourceLotId)
      if (!Number.isInteger(sourceLotId) || sourceLotId <= 0 || seenLots.has(sourceLotId)) {
        throw new ApiError('INVALID_PARAMS', '同一来源库存批次只能转换一次')
      }
      seenLots.add(sourceLotId)
      const sourceLot = await lotForUpdate(tx, sourceLotId, locationId)
      const sourceQuantity = positive(line.sourceQuantity, '转换出库数量')
      const targetQuantity = positive(line.targetQuantity, '转换入库数量')
      await assertLotAvailable(tx, sourceLot, sourceQuantity)
      await loadLotSkuForMarket(tx, sourceLot, marketIdForLocation(location))
      const targetSku = await loadSku(tx, required(line.targetSkuId, '转换目标 SKU'))
      assertSkuAvailableToMarket(targetSku, marketIdForLocation(location))
      if (targetSku.skuId === sourceLot.skuId) {
        throw new ApiError('INVALID_PARAMS', '库存转换目标 SKU 不能与来源 SKU 相同')
      }
      prepared.push({
        sourceLot,
        sourceQuantity,
        targetSku,
        targetQuantity,
        targetBatchNo: text(line.targetBatchNo) ?? sourceLot.batchNo,
        targetExpiryDate: text(line.targetExpiryDate) ?? sourceLot.expiryDate,
        remark: text(line.remark),
      })
    }
    const marketId = marketIdForLocation(location)
    const outboundId = await generateDocId(tx, '库存转换出库')
    const inboundId = await generateDocId(tx, '库存转换入库')
    await insertDocHeader(tx, {
      id: outboundId,
      docType: '库存转换出库',
      status: '已完成',
      sourceLocationId: locationId,
      marketId,
      docDate: input.docDate,
      totalQuantity: fixed(prepared.reduce((sum, item) => sum + item.sourceQuantity, 0)),
      totalAmount: null,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    await insertDocHeader(tx, {
      id: inboundId,
      docType: '库存转换入库',
      status: '已完成',
      targetLocationId: locationId,
      marketId,
      docDate: input.docDate,
      relatedDocId: outboundId,
      totalQuantity: fixed(prepared.reduce((sum, item) => sum + item.targetQuantity, 0)),
      totalAmount: null,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const outboundItemId = await insertDocItem(tx, {
        docId: outboundId,
        lotId: item.sourceLot.id,
        skuId: item.sourceLot.skuId,
        skuName: item.sourceLot.skuName,
        specName: item.sourceLot.specName,
        supplier: item.sourceLot.supplier,
        productSeries: item.sourceLot.productSeries,
        batchNo: item.sourceLot.batchNo,
        expiryDate: item.sourceLot.expiryDate,
        isGift: item.sourceLot.isGift,
        quantity: item.sourceQuantity,
        stockSnapshot: item.sourceLot.quantityOnHand,
        standardUnitPrice: item.sourceLot.marketStandardUnitPrice,
        unitDiscount: item.sourceLot.marketUnitDiscount,
        actualUnitPrice: item.sourceLot.marketActualUnitPrice,
        amount: null,
        ...priceFromLot(item.sourceLot),
        remark: item.remark,
      })
      const targetLot = await upsertLot(tx, {
        locationId,
        skuId: item.targetSku.skuId,
        skuName: item.targetSku.productName,
        specName: item.targetSku.specName,
        supplier: item.targetSku.supplier,
        productSeries: item.targetSku.productSeries,
        batchNo: item.targetBatchNo,
        expiryDate: item.targetExpiryDate,
        isGift: item.sourceLot.isGift,
        ...priceFromLot(item.sourceLot),
        sourceDocId: inboundId,
      })
      const inboundItemId = await insertDocItem(tx, {
        docId: inboundId,
        lotId: targetLot.id,
        skuId: targetLot.skuId,
        skuName: targetLot.skuName,
        specName: targetLot.specName,
        supplier: targetLot.supplier,
        productSeries: targetLot.productSeries,
        batchNo: targetLot.batchNo,
        expiryDate: targetLot.expiryDate,
        isGift: targetLot.isGift,
        quantity: item.targetQuantity,
        stockSnapshot: targetLot.quantityOnHand,
        standardUnitPrice: targetLot.marketStandardUnitPrice,
        unitDiscount: targetLot.marketUnitDiscount,
        actualUnitPrice: targetLot.marketActualUnitPrice,
        amount: null,
        ...priceFromLot(targetLot),
        remark: item.remark,
      })
      await applyLotDelta(tx, {
        lot: item.sourceLot,
        docId: outboundId,
        docItemId: outboundItemId,
        direction: '出库',
        quantityDelta: -item.sourceQuantity,
        createdBy: session.employeeId,
        movementKey: `inventory-conversion:out:${outboundId}:item:${outboundItemId}`,
        remark: input.remark,
      })
      await applyLotDelta(tx, {
        lot: targetLot,
        docId: inboundId,
        docItemId: inboundItemId,
        direction: '入库',
        quantityDelta: item.targetQuantity,
        createdBy: session.employeeId,
        movementKey: `inventory-conversion:in:${inboundId}:item:${inboundItemId}`,
        remark: input.remark,
      })
      await insertDocLink(tx, {
        fromDocId: outboundId,
        toDocId: inboundId,
        relationType: '库存转换',
        fromItemId: outboundItemId,
        toItemId: inboundItemId,
        quantity: item.targetQuantity,
      })
    }
    return { outboundId, inboundId }
  })
  await logOperation(session, 'inventory.conversion.create', 'inventory_docs', ids.outboundId, ids)
  refreshInventoryPaths()
  return ids
}

/** 福利报价只读，不写 SKU 主数据；市场报货创建时会再次在同一事务中取价并快照。 */
export async function quoteMarketReplenishmentPrice(
  session: AuthSession,
  input: { marketId: string; skuId: string; quantity: number; docDate?: string | null },
): Promise<PromotionQuote> {
  const marketId = required(input.marketId, '市场')
  const skuId = required(input.skuId, '库存 SKU')
  const quantity = positive(input.quantity, '采购数量')
  if (!hasPermission(session, 'inventory:price_view')) {
    throw new ApiError('PERMISSION_DENIED', '无权查看市场报货价格')
  }
  await syncLocations()
  return db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '市场')
    assertLocationWritable(session, market)
    return quoteMarketPriceInTx(tx, {
      marketId,
      skuId,
      quantity,
      docDate: dateOrToday(input.docDate),
    })
  })
}

/** 用同一份发货明细给页面展示预期、实收、差异和赠送，不从自由表单字段推断。 */
export async function getShipmentReceiptProgress(
  session: AuthSession,
  shipmentIdInput: string,
): Promise<{
  shipmentId: string
  status: string
  items: Array<{
    itemId: number
    skuId: string
    skuName: string
    isGift: boolean
    shippedQuantity: number
    receivedQuantity: number
    outstandingQuantity: number
    differenceQuantity: number
  }>
}> {
  const shipmentId = required(shipmentIdInput, '发货单')
  await syncLocations()
  return db.transaction(async (tx) => {
    const shipment = await docForUpdate(tx, shipmentId)
    if (!['品项公司发货', '分院配货'].includes(shipment.docType)) {
      throw new ApiError('INVALID_PARAMS', '仅支持查询品项公司发货或分院配货进度')
    }
    const source = shipment.sourceLocationId ? await locationForUpdate(tx, shipment.sourceLocationId) : null
    const target = shipment.targetLocationId ? await locationForUpdate(tx, shipment.targetLocationId) : null
    const canSeeSource = source && (() => {
      try {
        assertLocationWritable(session, source)
        return true
      } catch {
        return false
      }
    })()
    const canSeeTarget = target && (() => {
      try {
        assertLocationWritable(session, target)
        return true
      } catch {
        return false
      }
    })()
    if (!canSeeSource && !canSeeTarget) throw new ApiError('PERMISSION_DENIED', '无权查看该发货单')
    const items = await allDocItemsForUpdate(tx, shipmentId)
    return {
      shipmentId,
      status: shipment.status,
      items: items.map((item) => {
        const receivedQuantity = item.fulfilledQuantity ?? 0
        const outstandingQuantity = Math.max(0, fixed(item.quantity - receivedQuantity))
        return {
          itemId: item.id,
          skuId: item.skuId,
          skuName: item.skuName,
          isGift: item.isGift,
          shippedQuantity: item.quantity,
          receivedQuantity,
          outstandingQuantity,
          differenceQuantity: outstandingQuantity,
        }
      }),
    }
  })
}
