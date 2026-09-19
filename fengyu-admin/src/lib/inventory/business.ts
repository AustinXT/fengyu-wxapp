import 'server-only'

import { db } from '@/db'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import { logOperation } from '@/lib/operation-log'
import { hasPermission } from '@/lib/permissions'
import { assertInventoryLocationInScope, inventoryPriceVisibility } from './access'
import type { AuthSession } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { assertInventoryBusinessWritable } from './cutover'

// DOC_LOCK_KEY_PREFIX 必须与 staffApi 的 generateDocNo / admin engine.generateDocNo 保持字面量一致；cross-end snapshot 守护
// Admin release SOP：切流前必须调用 getInventoryBaselineStatus 并断言 isInitialized=true。
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type LocationType = '总部' | '市场' | '门店'

interface Location {
  locationId: string
  orgNodeId: string
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
  supplierId: string | null
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
  supplierId: string | null
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
  sourceDocId: string | null
}

interface DocHeader {
  id: string
  docType: string
  status: string
  sourceOrgNodeId: string | null
  targetOrgNodeId: string | null
  marketId: string | null
  supplierId: string | null
  supplierName: string | null
  cancellationRequestReason: string | null
  cancellationRequestedBy: string | null
  cancellationRequestedAt: string | Date | null
}

interface DocItemSnapshot {
  id: number
  docId: string
  lotId: number | null
  skuId: string
  skuName: string
  specName: string | null
  supplier: string | null
  /** 行级供应商档案关联（#194）；`supplier` 是同一刻冻结的名称快照。 */
  supplierId: string | null
  /** 行级市场归属（#194）。NULL = 品项公司自用行，非 NULL = 市场行。 */
  marketId: string | null
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
  sourceOrgNodeId?: string | null
  targetOrgNodeId?: string | null
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
  /** 行级供应商档案关联（#194）；不传则留空，`supplier` 名称快照仍单独写入。 */
  supplierId?: string | null
  /** 行级市场归属（#194）；采购订单与市场报货汇总按行写入，其它单据留空。 */
  marketId?: string | null
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
  promotionPlanId?: string | null
  promotionPlanNoSnapshot?: string | null
  promotionPlanNameSnapshot?: string | null
  promotionRuleTypeSnapshot?: '单品阶梯' | '组合' | null
  promotionSelectionMode?: '系统推荐' | '人工选择' | null
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
  promotionSelections?: MarketPromotionSelectionInput[]
}

export interface MarketPromotionSelectionInput {
  skuId: string
  promotionPlanId: string
}

/**
 * 供应链跨市场汇总各市场报货需求的一行（#193）。
 *
 * **按 SKU × 市场 成行，不跨市场并成一行**：下游采购订单要按行承载市场归属才能发货，
 * 也才能把履约回写到正确的市场报货明细。UI 可按 SKU 分组展示合计。
 */
export interface MarketReportSummaryLine {
  skuId: string
  skuName: string
  specName: string | null
  marketId: string
  marketName: string
  /** 该 SKU × 市场 的报货总量（含已汇总、已采购的部分）。 */
  requestedQuantity: number
  /** 尚未被汇总单占用、也未被采购订单占用的量。 */
  outstandingQuantity: number
  /** 来源市场报货明细行 id。 */
  requestItemIds: number[]
  /** 商品档案上的供应商，供 UI 提前提示缺绑定；建单时服务端会再校验一次。 */
  supplierId: string | null
  supplierName: string | null
  /** 按来源行数量加权的市场实际单价，用于汇总单与采购订单的金额快照。 */
  marketActualUnitPrice: number | null
}

export interface MarketReportSummary {
  supplyChainLocationId: string
  items: MarketReportSummaryLine[]
}

/**
 * 合并后的采购订单入参（#194）。
 *
 * 来源明细可以同时来自多张 `市场报货汇总` 与多张 `品项公司报货需求`，服务端按
 * `sourceItemId` 自行反查来源单类型 —— 不接受前端传类型，免得被绕过校验。
 */
export interface PurchaseOrderSourceLineInput {
  sourceItemId: number
  quantity: number
}

export interface CreateMergedPurchaseOrderInput {
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: PurchaseOrderSourceLineInput[]
}

export interface MarketReportSummaryLineInput {
  skuId: string
  marketId: string
  quantity: number
  sourceReportItemIds: number[]
}

export interface CreateMarketReportSummaryInput {
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: MarketReportSummaryLineInput[]
}

/** 品项公司直接向供应链提出的采购需求，不经过市场报货或门店需求汇总。 */
export interface ItemCompanyReplenishmentLineInput {
  skuId: string
  quantity: number
  remark?: string | null
}

export interface CreateItemCompanyReplenishmentInput {
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: ItemCompanyReplenishmentLineInput[]
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

export interface CreateCompanyPurchaseOrderLineInput {
  companyRequestItemId: number
  quantity: number
}

export interface CreateCompanyPurchaseOrderInput {
  companyRequestId: string
  supplierId: string
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: CreateCompanyPurchaseOrderLineInput[]
}

export interface SupplyChainPurchaseReceiptLineInput {
  purchaseOrderItemId: number
  quantity: number
  batchNo?: string | null
  expiryDate?: string | null
  isGift?: boolean
  remark?: string | null
}

export interface ReceiveSupplyChainPurchaseOrderInput {
  purchaseOrderId: string
  supplyChainLocationId: string
  docDate?: string | null
  remark?: string | null
  items: SupplyChainPurchaseReceiptLineInput[]
}

export interface CancelSupplyChainPurchaseOrderInput {
  purchaseOrderId: string
  cancellationReason: string
}

export interface RequestItemCompanyShipmentCancellationInput {
  shipmentId: string
  cancellationReason: string
}

export interface ResolveItemCompanyShipmentCancellationInput {
  shipmentId: string
  auditRemark?: string | null
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
  sourceOrgNodeId: string
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
  sourceOrgNodeId: string
  targetOrgNodeId: string
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

export interface CreateSupplyChainStaffPurchaseInput {
  locationId: string
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
  supplierId: string
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
  locationId: string
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

export interface InventoryMarketEmployeeOption {
  employeeId: string
  name: string
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
  promotionRuleType: '单品阶梯' | '组合' | null
}

export interface PromotionQuoteOption {
  promotionPlanId: string
  promotionPlanNo: string
  promotionName: string
  promotionRuleType: '单品阶梯' | '组合'
  scopeMarketId: string | null
  marketUnitDiscount: number
  marketActualUnitPrice: number
  componentSkuIds: string[]
}

export interface MarketPromotionQuoteLine extends PromotionQuote {
  recommendedPromotionPlanId: string | null
  selectionMode: '系统推荐' | '人工选择' | null
  eligibleOptions: PromotionQuoteOption[]
}

export interface MarketPromotionQuoteResult {
  items: MarketPromotionQuoteLine[]
  totalStandardAmount: number
  totalDiscountAmount: number
  totalActualAmount: number
}

interface MarketQuoteRequest {
  skuId: string
  quantity: number
}

interface PromotionCandidate {
  planId: string
  planNo: string
  planName: string
  ruleType: '单品阶梯' | '组合'
  scopeMarketId: string | null
  createdAt: string
  skuId: string
  marketUnitDiscount: number
  reportMinQuantity: number | null
  reportMaxQuantity: number | null
}

const EPSILON = 0.000001

const DOC_PREFIX: Record<string, string> = {
  门店报货: 'DBH',
  市场报货: 'MBH',
  品项公司报货需求: 'ZBH',
  采购订单: 'CGD',
  供应链采购订单: 'PCG',
  供应链采购入库: 'GRK',
  品项公司发货: 'GFH',
  市场采购入库: 'MRK',
  分院配货: 'FPH',
  院入库: 'YRK',
  院退货: 'YTH',
  市场退货: 'MTH',
  市场退货入库: 'MTR',
  供应链退货入库: 'GTR',
  员工购出库: 'YGG',
  供应链员工购出库: 'GYG',
  自采产品入库: 'ZRK',
  非凤御市场出库: 'FFY',
  库存转换出库: 'ZHO',
  库存转换入库: 'ZHI',
}

const INTERNAL_SAME_NODE_DOC_TYPES = new Set([
  '品项公司报货需求',
  '员工购出库',
  '供应链员工购出库',
  '内部领用',
  '市场产品报损',
  '院产品报损',
  '市场产品盘溢',
  '市场库存盘点',
  '分院库存盘点',
  '库存转换出库',
  '库存转换入库',
  '期初库存',
])

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
  supplier: string | null
  supplierId: string | null
  sourceDocId: string | null
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
    `supplier:${input.supplierId ?? input.supplier ?? ''}`,
    `source:${input.sourceDocId ?? ''}`,
  ].join('|')
}

/**
 * 热路径短路：migration 0009 的 org_nodes / stores 触发器（INSERT + 相关列 UPDATE）
 * 已实时维护 inventory_locations，本函数只是漂移自愈兜底。先跑只读反连接探测，
 * 无缺失/漂移时跳过两条全表 UPSERT（采购/发货/收货等业务动作每次都会调用本函数，
 * 是比 engine.ts 更热的真实路径）。探测无结果或结果异常时保守回退旧行为。
 * ⚠ 探测片段与 engine.ts syncInventoryLocations 保持字面一致（各自副本，由本文件
 * business.test.ts 的守护测试 + staff cross-end-inventory-snapshot.test.js 守护）。
 * 所有调用点均在 db.transaction 之外，探测与 UPSERT 一律走 db 顶层连接。
 */
async function syncLocations(): Promise<void> {
  const probe = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM org_nodes o
        LEFT JOIN inventory_locations loc ON loc.location_id = o.id
       WHERE o.type IN ('总部','市场')
         AND (loc.location_id IS NULL
           OR loc.location_type IS DISTINCT FROM o.type::text
           OR loc.name IS DISTINCT FROM o.name
           OR loc.org_node_id IS DISTINCT FROM o.id
           OR loc.parent_location_id IS DISTINCT FROM o.parent_id
           OR loc.is_active IS DISTINCT FROM o.is_active)
      UNION ALL
      SELECT 1
        FROM stores s
        LEFT JOIN org_nodes o ON o.id = s.org_node_id
        LEFT JOIN inventory_locations loc ON loc.location_id = s.store_id
       WHERE loc.location_id IS NULL
         OR loc.location_type IS DISTINCT FROM '门店'
         OR loc.name IS DISTINCT FROM s.store_name
         OR loc.org_node_id IS DISTINCT FROM s.org_node_id
         OR loc.store_id IS DISTINCT FROM s.store_id
         OR loc.parent_location_id IS DISTINCT FROM o.parent_id
         OR loc.is_active IS DISTINCT FROM (COALESCE(o.is_active, false) AND NOT s.is_closed)
    ) AS drifted
  `)
  const drifted = (probe as unknown as Array<{ drifted: boolean | null }> | undefined)?.[0]?.drifted
  if (drifted === false) return
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

async function locationForUpdate(tx: Tx, endpointId: string): Promise<Location> {
  const [row] = rows<{
    location_id: string
    org_node_id: string
    location_type: LocationType
    name: string
    parent_location_id: string | null
  }>(await tx.execute(sql`
    SELECT location_id, org_node_id, location_type, name, parent_location_id
      FROM inventory_locations
     WHERE (location_id = ${endpointId} OR org_node_id = ${endpointId})
       AND is_active = true
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存主体不存在或已停用')
  return {
    locationId: row.location_id,
    orgNodeId: row.org_node_id,
    locationType: row.location_type,
    name: row.name,
    parentLocationId: row.parent_location_id,
  }
}

function assertLocationWritable(session: AuthSession, location: Location): void {
  assertInventoryLocationInScope(session, location.locationId)
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
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_docs:${prefix}:${ymd}`}))`)
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
    supplier_id: string | null
    product_series: string | null
    source_type: '供应链' | '市场自采' | '转让店'
    owner_market_id: string | null
    supply_chain_purchase_price: string | number | null
    market_purchase_price: string | number | null
    store_purchase_price: string | number | null
    market_staff_purchase_price: string | number | null
    item_company_purchase_price: string | number | null
  }>(await tx.execute(sql`
    SELECT sku_id, product_code, product_name, spec_name, supplier, supplier_id, product_series,
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
    supplierId: row.supplier_id,
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
    supplier_id: string | null
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
    source_doc_id: string | null
  }>(await tx.execute(sql`
    SELECT id, location_id, sku_id, sku_name, spec_name, supplier, supplier_id, product_series,
           batch_no, expiry_date, is_gift, quantity_on_hand,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price, source_doc_id
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
    supplierId: row.supplier_id,
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
    sourceDocId: row.source_doc_id,
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
  input: Omit<LotSnapshot, 'id' | 'quantityOnHand' | 'locationId'> & { locationId: string },
): Promise<LotSnapshot> {
  const key = lotKey({
    skuId: input.skuId,
    batchNo: input.batchNo,
    expiryDate: input.expiryDate,
    isGift: input.isGift,
    supplyChainUnitCost: input.supplyChainUnitCost,
    marketActualUnitPrice: input.marketActualUnitPrice,
    storeActualUnitPrice: input.storeActualUnitPrice,
    supplier: input.supplier,
    supplierId: input.supplierId,
    sourceDocId: input.sourceDocId,
  })
  const [created] = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO inventory_stock_lots (
      location_id, sku_id, lot_key, sku_name, spec_name, supplier, supplier_id, product_series,
      batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, source_doc_id
    ) VALUES (
      ${input.locationId}, ${input.skuId}, ${key}, ${input.skuName}, ${text(input.specName)},
      ${text(input.supplier)}, ${text(input.supplierId)}, ${text(input.productSeries)}, ${input.batchNo},
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
          supplier_id = COALESCE(EXCLUDED.supplier_id, inventory_stock_lots.supplier_id),
          product_series = EXCLUDED.product_series,
          updated_at = NOW()
    RETURNING id
  `))
  return lotForUpdate(tx, Number(created.id), input.locationId)
}

async function insertDocHeader(tx: Tx, input: InsertDocHeaderInput): Promise<void> {
  const source = input.sourceOrgNodeId
    ? await locationForUpdate(tx, input.sourceOrgNodeId)
    : null
  const target = input.targetOrgNodeId
    ? await locationForUpdate(tx, input.targetOrgNodeId)
    : null
  let sourceOrgNodeId = source?.orgNodeId ?? null
  let targetOrgNodeId = target?.orgNodeId ?? null
  if (INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)) {
    const orgNodeId = sourceOrgNodeId ?? targetOrgNodeId
    sourceOrgNodeId = orgNodeId
    targetOrgNodeId = orgNodeId
  }
  if (!sourceOrgNodeId && !targetOrgNodeId) {
    throw new ApiError('INVALID_PARAMS', '库存单据至少需要一个组织节点端点')
  }
  await tx.execute(sql`
    INSERT INTO inventory_docs (
      id, doc_type, status, source_org_node_id, target_org_node_id, market_id, supplier_id,
      employee_id, employee_name, supplier_name, external_party_name, logistics_company, tracking_no,
      receipt_attachment_url, doc_date,
      total_quantity, total_amount, remark, created_by, confirmed_by, confirmed_at
    ) VALUES (
      ${input.id}, ${input.docType}, ${input.status}, ${text(sourceOrgNodeId)},
      ${text(targetOrgNodeId)}, ${text(input.marketId)}, ${text(input.supplierId)},
      ${text(input.employeeId)}, ${text(input.employeeName)}, ${text(input.supplierName)},
      ${text(input.externalPartyName)}, ${text(input.logisticsCompany)}, ${text(input.trackingNo)},
      ${text(input.receiptAttachmentUrl)}, ${dateOrToday(input.docDate)},
      ${numeric(input.totalQuantity)},
      ${numeric(input.totalAmount ?? null)}, ${text(input.remark)}, ${input.createdBy},
      ${input.confirmed ? input.createdBy : null}, ${input.confirmed ? sql`NOW()` : null}
    )
  `)
}

async function insertDocItem(tx: Tx, input: InsertDocItemInput): Promise<number> {
  const [created] = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO inventory_doc_items (
      doc_id, lot_id, sku_id, sku_name, spec_name, supplier, supplier_id, market_id,
      product_series,
      batch_no, expiry_date, is_gift, quantity, stock_snapshot, request_quantity,
      fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price, amount,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, promotion_plan_id, promotion_plan_no_snapshot,
      promotion_plan_name_snapshot, promotion_rule_type_snapshot, promotion_selection_mode,
      reason, remark
    ) VALUES (
      ${input.docId}, ${input.lotId ?? null}, ${input.skuId}, ${input.skuName},
      ${text(input.specName)}, ${text(input.supplier)}, ${text(input.supplierId)},
      ${text(input.marketId)}, ${text(input.productSeries)},
      ${text(input.batchNo) ?? ''}, ${text(input.expiryDate)}, ${Boolean(input.isGift)},
      ${numeric(input.quantity)}, ${numeric(input.stockSnapshot ?? null)},
      ${numeric(input.requestQuantity ?? null)}, ${numeric(input.fulfilledQuantity ?? null)},
      ${numeric(input.standardUnitPrice ?? null)}, ${numeric(input.unitDiscount ?? null)},
      ${numeric(input.actualUnitPrice ?? null)}, ${numeric(input.amount ?? null)},
      ${numeric(input.supplyChainUnitCost)}, ${numeric(input.marketStandardUnitPrice)},
      ${numeric(input.marketUnitDiscount)}, ${numeric(input.marketActualUnitPrice)},
      ${numeric(input.storeStandardUnitPrice)}, ${numeric(input.storeUnitDiscount)},
      ${numeric(input.storeActualUnitPrice)}, ${text(input.promotionPlanId)},
      ${text(input.promotionPlanNoSnapshot)}, ${text(input.promotionPlanNameSnapshot)},
      ${text(input.promotionRuleTypeSnapshot)}, ${text(input.promotionSelectionMode)},
      ${text(input.reason)}, ${text(input.remark)}
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
    supplierId: text(row.supplier_id as string | null | undefined),
    marketId: text(row.market_id as string | null | undefined),
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
    source_org_node_id: string | null
    target_org_node_id: string | null
    market_id: string | null
    supplier_id: string | null
    supplier_name: string | null
    cancellation_request_reason: string | null
    cancellation_requested_by: string | null
    cancellation_requested_at: string | Date | null
  }>(await tx.execute(sql`
    SELECT id, doc_type, status, source_org_node_id, target_org_node_id, market_id,
           supplier_id, supplier_name,
           cancellation_request_reason, cancellation_requested_by, cancellation_requested_at
      FROM inventory_docs
     WHERE id = ${id}
     FOR UPDATE
  `))
  if (!row) throw new ApiError('NOT_FOUND', '库存单据不存在')
  return {
    id: row.id,
    docType: row.doc_type,
    status: row.status,
    sourceOrgNodeId: row.source_org_node_id,
    targetOrgNodeId: row.target_org_node_id,
    marketId: row.market_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    cancellationRequestReason: text(row.cancellation_request_reason),
    cancellationRequestedBy: text(row.cancellation_requested_by),
    cancellationRequestedAt: row.cancellation_requested_at,
  }
}

async function docItemForUpdate(tx: Tx, id: number, docId?: string): Promise<DocItemSnapshot> {
  const [row] = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, doc_id, lot_id, sku_id, sku_name, spec_name, supplier, supplier_id, market_id,
           product_series,
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
      WITH RECURSIVE ancestors(id, parent_id, type, path) AS (
        SELECT id, parent_id, type, ARRAY[id]
          FROM org_nodes
         WHERE id = ${employee.org_node_id}
        UNION ALL
        SELECT node.id, node.parent_id, node.type, ancestors.path || node.id
          FROM org_nodes node
          JOIN ancestors ON ancestors.parent_id = node.id
         WHERE NOT node.id = ANY(ancestors.path)
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

async function employeeForSupplyChain(
  tx: Tx,
  employeeId: string,
  locationId: string,
): Promise<{ id: string; name: string }> {
  const [employee] = rows<{ employee_id: string; name: string | null }>(await tx.execute(sql`
    WITH RECURSIVE descendants(id, path) AS (
      SELECT id, ARRAY[id]
        FROM org_nodes
       WHERE id = ${locationId}
      UNION ALL
      SELECT child.id, descendants.path || child.id
        FROM org_nodes child
        JOIN descendants ON child.parent_id = descendants.id
       WHERE NOT child.id = ANY(descendants.path)
    ), employee_ancestors(id, parent_id, type, path) AS (
      SELECT node.id, node.parent_id, node.type, ARRAY[node.id]
        FROM staff_wechat_users employee
        JOIN org_nodes node ON node.id = employee.org_node_id
       WHERE employee.employee_id = ${employeeId}
      UNION ALL
      SELECT node.id, node.parent_id, node.type, employee_ancestors.path || node.id
        FROM org_nodes node
        JOIN employee_ancestors ON employee_ancestors.parent_id = node.id
       WHERE NOT node.id = ANY(employee_ancestors.path)
    )
    SELECT employee.employee_id, employee.name
      FROM staff_wechat_users employee
     WHERE employee.employee_id = ${employeeId}
       AND employee.is_resigned = false
       AND employee.store_id IS NULL
       AND employee.org_node_id IN (SELECT id FROM descendants)
       AND NOT EXISTS (SELECT 1 FROM employee_ancestors WHERE type IN ('市场', '门店'))
     LIMIT 1
  `))
  if (!employee) {
    throw new ApiError('PERMISSION_DENIED', '员工不属于当前供应链总部或已经离职')
  }
  return { id: employee.employee_id, name: employee.name?.trim() || employee.employee_id }
}

export async function listMarketEmployeeOptions(
  session: AuthSession,
  marketIdInput: string,
): Promise<InventoryMarketEmployeeOption[]> {
  const marketId = required(marketIdInput, '市场')
  await syncLocations()
  const [market] = rows<{
    location_id: string
    org_node_id: string
    location_type: LocationType
    name: string
    parent_location_id: string | null
  }>(await db.execute(sql`
    SELECT location_id, org_node_id, location_type, name, parent_location_id
      FROM inventory_locations
     WHERE location_id = ${marketId}
       AND is_active = true
     LIMIT 1
  `))
  if (!market) throw new ApiError('NOT_FOUND', '市场库存主体不存在或已停用')
  const location: Location = {
    locationId: market.location_id,
    orgNodeId: market.org_node_id,
    locationType: market.location_type,
    name: market.name,
    parentLocationId: market.parent_location_id,
  }
  assertType(location, '市场', '员工购出库主体')
  assertLocationWritable(session, location)

  const employees = rows<{ employee_id: string; name: string | null }>(await db.execute(sql`
    WITH RECURSIVE descendants(id, path) AS (
      SELECT id, ARRAY[id]
        FROM org_nodes
       WHERE id = ${marketId}
      UNION ALL
      SELECT child.id, descendants.path || child.id
        FROM org_nodes child
        JOIN descendants ON child.parent_id = descendants.id
       WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT DISTINCT employee.employee_id, employee.name
      FROM staff_wechat_users employee
      LEFT JOIN inventory_locations store_location
        ON store_location.location_id = employee.store_id
     WHERE employee.is_resigned = false
       AND (
         store_location.parent_location_id = ${marketId}
         OR employee.org_node_id IN (SELECT id FROM descendants)
       )
  ORDER BY employee.name ASC NULLS LAST, employee.employee_id ASC
  `))
  return employees.map((employee) => ({
    employeeId: employee.employee_id,
    name: employee.name?.trim() || employee.employee_id,
  }))
}

export async function listSupplyChainEmployeeOptions(
  session: AuthSession,
  locationIdInput: string,
): Promise<InventoryMarketEmployeeOption[]> {
  const locationId = required(locationIdInput, '供应链库存主体')
  await syncLocations()
  const [row] = rows<{ location_id: string; org_node_id: string; location_type: LocationType; name: string; parent_location_id: string | null }>(await db.execute(sql`
    SELECT location_id, org_node_id, location_type, name, parent_location_id
      FROM inventory_locations
     WHERE location_id = ${locationId} AND is_active = true
     LIMIT 1
  `))
  if (!row) throw new ApiError('NOT_FOUND', '供应链库存主体不存在或已停用')
  const location: Location = { locationId: row.location_id, orgNodeId: row.org_node_id, locationType: row.location_type, name: row.name, parentLocationId: row.parent_location_id }
  assertType(location, '总部', '供应链员工购出库主体')
  assertLocationWritable(session, location)
  const employees = rows<{ employee_id: string; name: string | null }>(await db.execute(sql`
    WITH RECURSIVE descendants(id, path) AS (
      SELECT id, ARRAY[id] FROM org_nodes WHERE id = ${locationId}
      UNION ALL
      SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants ON child.parent_id = descendants.id
       WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT employee.employee_id, employee.name
      FROM staff_wechat_users employee
      JOIN descendants ON descendants.id = employee.org_node_id
     WHERE employee.is_resigned = false
       AND employee.store_id IS NULL
       AND NOT EXISTS (
         WITH RECURSIVE ancestors(id, parent_id, type, path) AS (
           SELECT id, parent_id, type, ARRAY[id] FROM org_nodes WHERE id = employee.org_node_id
           UNION ALL
           SELECT node.id, node.parent_id, node.type, ancestors.path || node.id FROM org_nodes node JOIN ancestors ON ancestors.parent_id = node.id
            WHERE NOT node.id = ANY(ancestors.path)
         )
         SELECT 1 FROM ancestors WHERE type IN ('市场', '门店')
       )
     ORDER BY employee.name NULLS LAST, employee.employee_id
  `))
  return employees.map((employee) => ({ employeeId: employee.employee_id, name: employee.name?.trim() || employee.employee_id }))
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

function assertSupplyChainSku(sku: Pick<SkuSnapshot, 'sourceType' | 'productName'>): void {
  if (sku.sourceType !== '供应链') {
    throw new ApiError('INVALID_STATE', `品项公司报货只能选择供应链 SKU：${sku.productName}`)
  }
}

function supplyChainCost(sku: Pick<SkuSnapshot, 'supplyChainPurchasePrice' | 'itemCompanyPurchasePrice'>): number | null {
  return sku.supplyChainPurchasePrice ?? sku.itemCompanyPurchasePrice ?? null
}

function requiredSupplyChainCost(
  sku: Pick<SkuSnapshot, 'productName' | 'supplyChainPurchasePrice' | 'itemCompanyPurchasePrice'>,
  snapshotCost?: number | null,
): number {
  const cost = snapshotCost ?? supplyChainCost(sku)
  if (cost === null) {
    throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置供应链采购价`)
  }
  return cost
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

function assertSelfPurchaseReceiptPermission(session: AuthSession): void {
  if (hasPermission(session, 'inventory:self_purchase_receive')) return
  throw new ApiError('PERMISSION_DENIED', '缺少市场自采入库权限')
}

function assertShipmentCancellationPermission(
  session: AuthSession,
  action: 'inventory:shipment_cancel_request' | 'inventory:shipment_cancel_approve',
): void {
  if (hasPermission(session, action)) return
  throw new ApiError('PERMISSION_DENIED', action === 'inventory:shipment_cancel_request'
    ? '缺少品项发货撤回申请权限'
    : '缺少品项发货撤回审批权限')
}

function isPromotionQuantityMatched(
  candidate: Pick<PromotionCandidate, 'reportMinQuantity' | 'reportMaxQuantity'>,
  quantity: number,
): boolean {
  return (candidate.reportMinQuantity === null || candidate.reportMinQuantity <= quantity)
    && (candidate.reportMaxQuantity === null || candidate.reportMaxQuantity >= quantity)
}

function comparePromotionCandidates(
  left: PromotionCandidate,
  right: PromotionCandidate,
  marketId: string,
): number {
  const leftScope = left.scopeMarketId === marketId ? 0 : 1
  const rightScope = right.scopeMarketId === marketId ? 0 : 1
  if (leftScope !== rightScope) return leftScope - rightScope
  // 组合方案本身表达了更具体的联动条件，在相同市场范围内优先于单品阶梯。
  const leftRule = left.ruleType === '组合' ? 0 : 1
  const rightRule = right.ruleType === '组合' ? 0 : 1
  if (leftRule !== rightRule) return leftRule - rightRule
  const leftMin = left.reportMinQuantity ?? 0
  const rightMin = right.reportMinQuantity ?? 0
  if (leftMin !== rightMin) return rightMin - leftMin
  if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt)
  return left.planId.localeCompare(right.planId)
}

function promotionThresholdScore(candidates: PromotionCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + (candidate.reportMinQuantity ?? 0), 0)
}

function comparePromotionUnits(
  left: PromotionCandidate[],
  right: PromotionCandidate[],
  marketId: string,
): number {
  const leftHead = left[0]!
  const rightHead = right[0]!
  const leftScope = leftHead.scopeMarketId === marketId ? 0 : 1
  const rightScope = rightHead.scopeMarketId === marketId ? 0 : 1
  if (leftScope !== rightScope) return leftScope - rightScope
  const leftRule = leftHead.ruleType === '组合' ? 0 : 1
  const rightRule = rightHead.ruleType === '组合' ? 0 : 1
  if (leftRule !== rightRule) return leftRule - rightRule
  const threshold = promotionThresholdScore(right) - promotionThresholdScore(left)
  if (Math.abs(threshold) > EPSILON) return threshold
  if (leftHead.createdAt !== rightHead.createdAt) {
    return rightHead.createdAt.localeCompare(leftHead.createdAt)
  }
  const plan = leftHead.planId.localeCompare(rightHead.planId)
  if (plan !== 0) return plan
  return leftHead.skuId.localeCompare(rightHead.skuId)
}

/**
 * 组合福利以整张市场报货的采购数量判断：方案内每个 SKU 都命中各自的数量范围时，
 * 才给方案中的各 SKU 应用单价优惠。单品阶梯仍只按对应 SKU 的数量取价。
 */
async function quoteMarketPricesInTx(
  tx: Tx,
  input: {
    marketId: string
    items: MarketQuoteRequest[]
    docDate: string
    selections?: MarketPromotionSelectionInput[]
  },
): Promise<MarketPromotionQuoteResult> {
  const quantityBySku = new Map<string, number>()
  for (const item of input.items) {
    const skuId = required(item.skuId, '库存 SKU')
    const quantity = positive(item.quantity, '采购数量')
    quantityBySku.set(skuId, fixed((quantityBySku.get(skuId) ?? 0) + quantity))
  }
  if (quantityBySku.size === 0) throw new ApiError('INVALID_PARAMS', '市场报货至少需要一条取价明细')

  const skuById = new Map<string, SkuSnapshot>()
  for (const skuId of quantityBySku.keys()) {
    const sku = await loadSku(tx, skuId, true)
    assertSkuAvailableToMarket(sku, input.marketId)
    if (sku.marketPurchasePrice === null) {
      throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置市场进货价`)
    }
    skuById.set(skuId, sku)
  }

  const promotionRows: PromotionCandidate[] = rows<{
    plan_id: string
    plan_no: string
    plan_name: string
    rule_type: '单品阶梯' | '组合'
    scope_market_id: string | null
    created_at: Date | string
    sku_id: string
    market_unit_discount: string | number | null
    report_min_quantity: string | number | null
    report_max_quantity: string | number | null
  }>(await tx.execute(sql`
    SELECT p.id AS plan_id,
           p.plan_no,
           p.name AS plan_name,
           p.rule_type,
           p.scope_market_id,
           p.created_at,
           i.sku_id,
           i.market_unit_discount,
           i.report_min_quantity,
           i.report_max_quantity
      FROM inventory_promotion_plans p
      JOIN inventory_promotion_plan_items i ON i.plan_id = p.id
     WHERE p.status = '启用'
       AND p.starts_at <= ${input.docDate}
       AND p.ends_at >= ${input.docDate}
       AND (p.scope_market_id IS NULL OR p.scope_market_id = ${input.marketId})
       AND p.scope_store_id IS NULL
     ORDER BY p.created_at DESC, i.id ASC
  `)).map((row) => ({
    planId: row.plan_id,
    planNo: row.plan_no,
    planName: row.plan_name,
    ruleType: row.rule_type === '组合' ? '组合' : '单品阶梯',
    scopeMarketId: row.scope_market_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    skuId: row.sku_id,
    marketUnitDiscount: numberOrNull(row.market_unit_discount) ?? 0,
    reportMinQuantity: numberOrNull(row.report_min_quantity),
    reportMaxQuantity: numberOrNull(row.report_max_quantity),
  }))

  const candidatesByPlan = new Map<string, PromotionCandidate[]>()
  for (const candidate of promotionRows) {
    const planCandidates = candidatesByPlan.get(candidate.planId) ?? []
    planCandidates.push(candidate)
    candidatesByPlan.set(candidate.planId, planCandidates)
  }

  const applicableBySku = new Map<string, PromotionCandidate[]>()
  const eligibleComboPlans: PromotionCandidate[][] = []
  for (const planCandidates of candidatesByPlan.values()) {
    const ruleType = planCandidates[0]?.ruleType
    if (!ruleType) continue
    if (ruleType === '组合') {
      const componentSkuIds = new Set(planCandidates.map((candidate) => candidate.skuId))
      // 旧数据若存在重复 SKU 的组合方案，不能把它降级为单品优惠执行。
      const matchesAllComponents = componentSkuIds.size >= 2
        && componentSkuIds.size === planCandidates.length
        && planCandidates.every((candidate) => {
          const quantity = quantityBySku.get(candidate.skuId)
          return quantity !== undefined && isPromotionQuantityMatched(candidate, quantity)
        })
      if (!matchesAllComponents) continue
      eligibleComboPlans.push(planCandidates)
      for (const candidate of planCandidates) {
        const collection = applicableBySku.get(candidate.skuId) ?? []
        collection.push(candidate)
        applicableBySku.set(candidate.skuId, collection)
      }
      continue
    }
    for (const candidate of planCandidates) {
      const quantity = quantityBySku.get(candidate.skuId)
      if (quantity === undefined || !isPromotionQuantityMatched(candidate, quantity)) continue
      const collection = applicableBySku.get(candidate.skuId) ?? []
      collection.push(candidate)
      applicableBySku.set(candidate.skuId, collection)
    }
  }

  const recommendationUnits: PromotionCandidate[][] = [
    ...eligibleComboPlans,
    ...Array.from(applicableBySku.values())
      .flat()
      .filter((candidate) => candidate.ruleType === '单品阶梯')
      .map((candidate) => [candidate]),
  ].sort((left, right) => comparePromotionUnits(left, right, input.marketId))

  const recommendedBySku = new Map<string, PromotionCandidate>()
  for (const unit of recommendationUnits) {
    if (unit.some((candidate) => recommendedBySku.has(candidate.skuId))) continue
    for (const candidate of unit) recommendedBySku.set(candidate.skuId, candidate)
  }

  const selectedBySku = new Map(recommendedBySku)
  const manualSelections = new Map<string, string>()
  for (const selection of input.selections ?? []) {
    const skuId = required(selection.skuId, '福利选择商品')
    const promotionPlanId = required(selection.promotionPlanId, '福利方案')
    if (!quantityBySku.has(skuId) || manualSelections.has(skuId)) {
      throw new ApiError('INVALID_PARAMS', '福利方案选择包含重复或无效商品')
    }
    const selected = applicableBySku.get(skuId)?.find((candidate) => candidate.planId === promotionPlanId)
    if (!selected) throw new ApiError('CONFLICT', '福利方案已变化，请重新取价')
    manualSelections.set(skuId, promotionPlanId)
    selectedBySku.set(skuId, selected)
  }

  for (const selected of selectedBySku.values()) {
    if (selected.ruleType !== '组合') continue
    const components = candidatesByPlan.get(selected.planId) ?? []
    if (
      components.length < 2 ||
      components.some((component) => selectedBySku.get(component.skuId)?.planId !== selected.planId)
    ) {
      throw new ApiError('CONFLICT', '组合福利必须整组选择，请重新取价')
    }
  }

  const quoteItems: MarketPromotionQuoteLine[] = []
  for (const [skuId, quantity] of quantityBySku) {
    const sku = skuById.get(skuId)!
    const recommended = recommendedBySku.get(skuId)
    const promotion = selectedBySku.get(skuId)
    const base = sku.marketPurchasePrice!
    const discount = promotion?.marketUnitDiscount ?? 0
    const actual = fixed(base - discount)
    if (discount < -EPSILON || actual < -EPSILON) {
      throw new ApiError('INVALID_STATE', '福利方案计算出的市场实际单价无效')
    }
    const eligibleOptions = [...(applicableBySku.get(skuId) ?? [])]
      .sort((left, right) => comparePromotionCandidates(left, right, input.marketId))
      .filter((candidate, index, rows) => rows.findIndex((row) => row.planId === candidate.planId) === index)
      .map((candidate): PromotionQuoteOption => {
        const candidateActual = fixed(base - candidate.marketUnitDiscount)
        if (candidate.marketUnitDiscount < -EPSILON || candidateActual < -EPSILON) {
          throw new ApiError('INVALID_STATE', '福利方案计算出的市场实际单价无效')
        }
        return {
          promotionPlanId: candidate.planId,
          promotionPlanNo: candidate.planNo,
          promotionName: candidate.planName,
          promotionRuleType: candidate.ruleType,
          scopeMarketId: candidate.scopeMarketId,
          marketUnitDiscount: fixed(candidate.marketUnitDiscount),
          marketActualUnitPrice: candidateActual,
          componentSkuIds: candidate.ruleType === '组合'
            ? (candidatesByPlan.get(candidate.planId) ?? []).map((item) => item.skuId).sort()
            : [skuId],
        }
      })
    quoteItems.push({
      skuId,
      marketId: input.marketId,
      quantity,
      marketStandardUnitPrice: fixed(base),
      marketUnitDiscount: fixed(discount),
      marketActualUnitPrice: fixed(actual),
      promotionPlanId: promotion?.planId ?? null,
      promotionPlanNo: promotion?.planNo ?? null,
      promotionName: promotion?.planName ?? null,
      promotionRuleType: promotion?.ruleType ?? null,
      recommendedPromotionPlanId: recommended?.planId ?? null,
      selectionMode: promotion
        ? promotion.planId === recommended?.planId ? '系统推荐' : '人工选择'
        : null,
      eligibleOptions,
    })
  }
  return {
    items: quoteItems,
    totalStandardAmount: fixed(quoteItems.reduce(
      (sum, item) => sum + item.quantity * item.marketStandardUnitPrice,
      0,
    )),
    totalDiscountAmount: fixed(quoteItems.reduce(
      (sum, item) => sum + item.quantity * item.marketUnitDiscount,
      0,
    )),
    totalActualAmount: fixed(quoteItems.reduce(
      (sum, item) => sum + item.quantity * item.marketActualUnitPrice,
      0,
    )),
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

/**
 * 市场报货可按库存情况少于门店待配量采购。只有实际采购覆盖到的部分才应占用门店报货，
 * 否则未采购余量会在下次汇总时被错误地视为已经处理。
 */
export function allocateMarketReportSourceLinks(
  sourceItems: Array<Pick<DocItemSnapshot, 'id' | 'quantity'>>,
  purchaseQuantity: number,
): Array<{ sourceItemId: number; quantity: number }> {
  let remainingQuantity = Math.max(0, fixed(purchaseQuantity))
  const links: Array<{ sourceItemId: number; quantity: number }> = []
  for (const sourceItem of [...sourceItems].sort((left, right) => left.id - right.id)) {
    if (remainingQuantity <= EPSILON) break
    const quantity = fixed(Math.min(sourceItem.quantity, remainingQuantity))
    if (quantity <= EPSILON) continue
    links.push({ sourceItemId: sourceItem.id, quantity })
    remainingQuantity = fixed(remainingQuantity - quantity)
  }
  return links
}

/**
 * `ARRAY_AGG(id)` 聚合出来的 bigint[] 在 postgres.js 下没有 parser，可能是 string[] 也可能是
 * `{1,2,3}` 形态的裸字符串（见 admin CLAUDE.md「原生 SQL 的 bigint 返回 string」）。两种都要认。
 */
function parseIdArray(value: number[] | string | null | undefined): number[] {
  if (Array.isArray(value)) return value.map(Number)
  return String(value ?? '')
    .replace(/[{}]/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number)
}

/**
 * 多张市场报货汇成一行时的单价口径：按各来源行的未汇总数量加权平均。
 *
 * 来源行可能命中不同的报货福利方案因而单价不同，取加权均价能让汇总行的金额
 * 与各来源行金额之和守恒；全部来源都没有价格快照时返回 null 而不是 0，
 * 避免把「未知价」写成「免费」。
 */
function weightedUnitPrice(
  sourceItems: DocItemSnapshot[],
  field: 'marketStandardUnitPrice' | 'marketActualUnitPrice',
): number | null {
  let quantity = 0
  let amount = 0
  let priced = false
  for (const item of sourceItems) {
    const price = item[field]
    if (price === null) continue
    priced = true
    quantity += item.quantity
    amount += item.quantity * price
  }
  if (!priced || quantity <= EPSILON) return null
  return fixed(amount / quantity)
}

function refreshInventoryPaths(): void {
  revalidatePath('/inventory')
  revalidatePath('/inventory/docs')
  revalidatePath('/inventory/stocks')
  revalidatePath('/inventory/operations', 'layout')
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
    await assertInventoryBusinessWritable(tx)
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
      sourceOrgNodeId: storeId,
      targetOrgNodeId: marketId,
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

/**
 * 品项公司自主采购需求只允许总部发起并选择供应链 SKU。
 * 需求单不产生库存流水，后续必须先转成独立采购订单，再由供应链采购入库。
 */
export async function createItemCompanyReplenishment(
  session: AuthSession,
  input: CreateItemCompanyReplenishmentInput,
): Promise<{ id: string }> {
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '品项公司报货需求至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '品项公司报货主体')
    assertLocationWritable(session, supplyChain)
    const seen = new Set<string>()
    const prepared: Array<{ sku: SkuSnapshot; quantity: number; cost: number; remark: string | null }> = []
    for (const line of input.items) {
      const skuId = required(line.skuId, '库存 SKU')
      if (seen.has(skuId)) throw new ApiError('INVALID_PARAMS', '同一 SKU 请合并为一条品项公司报货明细')
      seen.add(skuId)
      const sku = await loadSku(tx, skuId, true)
      assertSupplyChainSku(sku)
      prepared.push({
        sku,
        quantity: positive(line.quantity, '报货数量'),
        cost: requiredSupplyChainCost(sku),
        remark: text(line.remark),
      })
    }
    const docId = await generateDocId(tx, '品项公司报货需求')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity, 0))
    const totalAmount = prepared.reduce((sum, line) => sum + line.quantity * line.cost, 0)
    await insertDocHeader(tx, {
      id: docId,
      docType: '品项公司报货需求',
      status: '已完成',
      sourceOrgNodeId: null,
      targetOrgNodeId: supplyChainLocationId,
      totalQuantity,
      totalAmount: fixed(totalAmount),
      docDate: input.docDate,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      await insertDocItem(tx, {
        docId,
        skuId: line.sku.skuId,
        skuName: line.sku.productName,
        specName: line.sku.specName,
        supplier: line.sku.supplier,
        productSeries: line.sku.productSeries,
        quantity: line.quantity,
        requestQuantity: line.quantity,
        fulfilledQuantity: 0,
        standardUnitPrice: line.cost,
        actualUnitPrice: line.cost,
        amount: fixed(line.quantity * line.cost),
        supplyChainUnitCost: line.cost,
        marketStandardUnitPrice: null,
        marketUnitDiscount: null,
        marketActualUnitPrice: null,
        storeStandardUnitPrice: null,
        storeUnitDiscount: null,
        storeActualUnitPrice: null,
        remark: line.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.item_company_request.create', 'inventory_docs', id, {
    supplyChainLocationId,
  })
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
        const ids = parseIdArray(row.request_item_ids)
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
        // ⚠️ 这里是**可承诺量**（在手 − 已预留），不是盘点的账面数。
        // 盘点账面数刻意不扣预留（issue #131 Q0，见 engine.ts 的 skuOnHandByLocation）——
        // 上面那条在手量 SQL 与盘点那条**同结构**（都是按主体 + SKU 求在手量，
        // 只是这里查单个 SKU、盘点那条 GROUP BY 批量查），复用时别把这一行的扣减一起抄走。
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
  if ((input.promotionSelections?.length ?? 0) > 0 && !hasPermission(session, 'inventory:market_price_view')) {
    throw new ApiError('PERMISSION_DENIED', '无权切换市场报货福利方案')
  }
  await syncLocations()
  const result = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
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
      prepared.push({
        sku,
        sourceItems,
        requestQuantity,
        // ⚠️ 市场报货汇总的 stockSnapshot 是**可承诺量**（在手 − 已预留）。
        // 同一列在盘点单上写的是**未扣预留的在手量**（issue #131 Q0）——
        // 上面那条在手量 SQL 与盘点那条**同结构**（都是按主体 + SKU 求在手量），
        // 复用时别把这里的扣减一起抄走。
        stockSnapshot: Math.max(0, fixed(Number(stock?.quantity ?? 0) - Number(reserved?.quantity ?? 0))),
        purchaseQuantity,
      })
    }
    const quoteResult = await quoteMarketPricesInTx(tx, {
      marketId,
      items: prepared.map((line) => ({ skuId: line.sku.skuId, quantity: line.purchaseQuantity })),
      docDate,
      selections: input.promotionSelections,
    })
    const quoteBySku = new Map(quoteResult.items.map((quote) => [quote.skuId, quote]))
    const quoted = prepared.map((line) => {
      const quote = quoteBySku.get(line.sku.skuId)
      if (!quote) throw new ApiError('CONFLICT', '市场报货福利报价丢失，请重试')
      return { ...line, quote }
    })
    const docId = await generateDocId(tx, '市场报货')
    const totalQuantity = fixed(quoted.reduce((sum, line) => sum + line.purchaseQuantity, 0))
    const totalAmount = fixed(quoted.reduce((sum, line) => sum + line.purchaseQuantity * line.quote.marketActualUnitPrice, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '市场报货',
      status: '已完成',
      sourceOrgNodeId: marketId,
      targetOrgNodeId: supplyChainLocationId,
      marketId,
      docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of quoted) {
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
        promotionPlanId: line.quote.promotionPlanId,
        promotionPlanNoSnapshot: line.quote.promotionPlanNo,
        promotionPlanNameSnapshot: line.quote.promotionName,
        promotionRuleTypeSnapshot: line.quote.promotionRuleType,
        promotionSelectionMode: line.quote.selectionMode,
        remark: line.quote.promotionPlanNo ? `福利方案：${line.quote.promotionPlanNo}` : null,
      })
      for (const sourceLink of allocateMarketReportSourceLinks(
        line.sourceItems,
        line.purchaseQuantity,
      )) {
        const sourceItem = line.sourceItems.find((item) => item.id === sourceLink.sourceItemId)
        if (!sourceItem) throw new ApiError('CONFLICT', '市场报货明细关联丢失，请重试')
        await insertDocLink(tx, {
          fromDocId: sourceItem.docId,
          toDocId: docId,
          relationType: '门店报货汇总',
          fromItemId: sourceItem.id,
          toItemId: itemId,
          quantity: sourceLink.quantity,
        })
      }
    }
    return {
      id: docId,
      promotionSelections: quoted
        .filter((line) => line.quote.promotionPlanId)
        .map((line) => ({
          skuId: line.sku.skuId,
          promotionPlanId: line.quote.promotionPlanId,
          selectionMode: line.quote.selectionMode,
        })),
    }
  })
  await logOperation(session, 'inventory.market_request.create', 'inventory_docs', result.id, {
    marketId,
    promotionSelections: result.promotionSelections,
  })
  refreshInventoryPaths()
  return { id: result.id }
}

/**
 * 汇总各市场尚未被汇总单占用、也未被采购订单占用的市场报货需求（#193）。
 *
 * 与市场层的 `summarizeStoreReplenishmentRequests` 同构，两点差别：
 * 1. 跨市场，因此 **GROUP BY sku_id, market_id** —— 行上必须留住市场，否则下游采购订单
 *    既无法按市场发货，也无法把履约回写到正确的市场报货明细；
 * 2. 不计算可承诺量。报多少是市场层结合自身库存做出的决定（已经体现在市场报货单的数量里），
 *    供应链层只负责把各市场已提出的需求汇总起来向供应商下单。
 */
export async function summarizeMarketReplenishmentRequests(
  session: AuthSession,
  input: {
    supplyChainLocationId: string
    startDate?: string | null
    endDate?: string | null
    marketIds?: string[] | null
  },
): Promise<MarketReportSummary> {
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  await syncLocations()
  return db.transaction(async (tx) => {
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '供应链库存主体')
    assertLocationWritable(session, supplyChain)
    const startDate = input.startDate ? dateOrToday(input.startDate) : null
    const endDate = input.endDate ? dateOrToday(input.endDate) : null
    const marketIds = Array.isArray(input.marketIds) && input.marketIds.length > 0
      ? input.marketIds
      : null
    const result = rows<{
      sku_id: string
      market_id: string
      market_name: string | null
      sku_name: string
      spec_name: string | null
      supplier_id: string | null
      supplier_name: string | null
      requested_quantity: string | number
      outstanding_quantity: string | number
      market_actual_unit_price: string | number | null
      request_item_ids: number[] | string
    }>(await tx.execute(sql`
      WITH pending AS (
        SELECT i.id,
               i.sku_id,
               d.market_id,
               i.sku_name,
               i.spec_name,
               i.quantity,
               i.market_actual_unit_price,
               GREATEST(i.quantity - summarized.quantity - COALESCE(i.fulfilled_quantity, 0), 0)
                 AS outstanding_quantity
          FROM inventory_docs d
          JOIN inventory_doc_items i ON i.doc_id = d.id
          JOIN LATERAL (
            SELECT COALESCE(SUM(l.quantity), 0) AS quantity
              FROM inventory_doc_links l
              JOIN inventory_docs summary_doc ON summary_doc.id = l.to_doc_id
             WHERE l.from_item_id = i.id
               AND l.relation_type = '市场报货汇总'
               AND summary_doc.status <> '已取消'
          ) summarized ON true
         WHERE d.doc_type = '市场报货'
           AND d.status <> '已取消'
           AND d.market_id IS NOT NULL
           AND d.target_org_node_id = ${supplyChain.orgNodeId}
           AND (${startDate}::date IS NULL OR d.doc_date >= ${startDate}::date)
           AND (${endDate}::date IS NULL OR d.doc_date <= ${endDate}::date)
           AND (${marketIds}::text[] IS NULL OR d.market_id = ANY(${marketIds}::text[]))
      )
      SELECT p.sku_id,
             p.market_id,
             MAX(market.name) AS market_name,
             MAX(p.sku_name) AS sku_name,
             MAX(p.spec_name) AS spec_name,
             MAX(sku.supplier_id) AS supplier_id,
             MAX(supplier.name) AS supplier_name,
             SUM(p.quantity) AS requested_quantity,
             SUM(p.outstanding_quantity) AS outstanding_quantity,
             SUM(p.outstanding_quantity * COALESCE(p.market_actual_unit_price, 0))
               / NULLIF(SUM(p.outstanding_quantity), 0) AS market_actual_unit_price,
             ARRAY_AGG(p.id ORDER BY p.id) AS request_item_ids
        FROM pending p
        LEFT JOIN inventory_locations market ON market.org_node_id = p.market_id
        JOIN inventory_skus sku ON sku.sku_id = p.sku_id
        LEFT JOIN inventory_suppliers supplier ON supplier.supplier_id = sku.supplier_id
       WHERE p.outstanding_quantity > 0
       GROUP BY p.sku_id, p.market_id
       ORDER BY MAX(p.sku_name), p.sku_id, MAX(market.name)
    `))
    return {
      supplyChainLocationId,
      items: result.map((row) => ({
        skuId: row.sku_id,
        skuName: row.sku_name,
        specName: text(row.spec_name),
        marketId: row.market_id,
        marketName: row.market_name ?? row.market_id,
        requestedQuantity: Number(row.requested_quantity),
        outstandingQuantity: Math.max(0, fixed(Number(row.outstanding_quantity))),
        requestItemIds: parseIdArray(row.request_item_ids),
        supplierId: text(row.supplier_id),
        supplierName: text(row.supplier_name),
        marketActualUnitPrice: numberOrNull(row.market_actual_unit_price),
      })),
    }
  })
}

/**
 * 把选中的市场报货明细汇总成一张供应链侧的「市场报货汇总」单（#193）。
 *
 * **不回写来源行的 `fulfilled_quantity`**：数量占用仍由采购订单负责（`engine.ts` 里
 * 市场报货的「已采购」列也是按采购订单血缘算的），两处都回写会让同一批需求被扣两次。
 * 防止重复汇总靠 `市场报货汇总` 血缘上的已占用量，与门店报货→市场报货那层的做法一致。
 */
export async function createMarketReportSummary(
  session: AuthSession,
  input: CreateMarketReportSummaryInput,
): Promise<{ id: string }> {
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '市场报货汇总至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '供应链库存主体')
    assertLocationWritable(session, supplyChain)
    const docDate = dateOrToday(input.docDate)
    const seenSourceItems = new Set<number>()
    const seenLines = new Set<string>()
    const prepared: Array<{
      sku: SkuSnapshot
      marketId: string
      quantity: number
      sourceItems: DocItemSnapshot[]
      requestQuantity: number
      standardUnitPrice: number | null
      actualUnitPrice: number | null
    }> = []
    for (const line of input.items) {
      const skuId = required(line.skuId, '库存 SKU')
      const marketId = required(line.marketId, '报货市场')
      const lineKey = `${skuId}@${marketId}`
      if (seenLines.has(lineKey)) {
        throw new ApiError('INVALID_PARAMS', '同一商品在同一市场只能汇总成一行')
      }
      seenLines.add(lineKey)
      const quantity = positive(line.quantity, '汇总数量')
      if (!Array.isArray(line.sourceReportItemIds) || line.sourceReportItemIds.length === 0) {
        throw new ApiError('INVALID_PARAMS', '市场报货汇总必须选择来源明细')
      }
      const market = await locationForUpdate(tx, marketId)
      assertType(market, '市场', '报货市场')
      const sourceItems: DocItemSnapshot[] = []
      for (const rawItemId of line.sourceReportItemIds) {
        const sourceItemId = Number(rawItemId)
        if (!Number.isInteger(sourceItemId) || sourceItemId <= 0 || seenSourceItems.has(sourceItemId)) {
          throw new ApiError('INVALID_PARAMS', '市场报货明细不能重复引用')
        }
        seenSourceItems.add(sourceItemId)
        const item = await docItemForUpdate(tx, sourceItemId)
        const header = await docForUpdate(tx, item.docId)
        if (
          header.docType !== '市场报货' ||
          header.status === '已取消' ||
          header.marketId !== market.orgNodeId ||
          header.targetOrgNodeId !== supplyChain.orgNodeId ||
          item.skuId !== skuId
        ) {
          throw new ApiError('INVALID_STATE', '所选明细不是该市场可汇总的市场报货')
        }
        const alreadySummarized = await linkedQuantity(tx, item.id, '市场报货汇总')
        const alreadyFulfilled = item.fulfilledQuantity ?? 0
        const outstandingQuantity = fixed(item.quantity - alreadySummarized - alreadyFulfilled)
        if (!nearlyGreater(outstandingQuantity, 0)) {
          throw new ApiError('CONFLICT', '市场报货明细已全部汇总或已采购')
        }
        sourceItems.push({ ...item, quantity: outstandingQuantity })
      }
      const availableQuantity = fixed(sourceItems.reduce((sum, item) => sum + item.quantity, 0))
      if (nearlyGreater(quantity, availableQuantity)) {
        throw new ApiError('CONFLICT', '汇总数量不能超过所选市场报货的未汇总数量')
      }
      const sku = await loadSku(tx, skuId, false, false)
      assertSkuAvailableToMarket(sku, market.orgNodeId)
      prepared.push({
        sku,
        marketId: market.orgNodeId,
        quantity,
        sourceItems,
        requestQuantity: availableQuantity,
        standardUnitPrice: weightedUnitPrice(sourceItems, 'marketStandardUnitPrice'),
        actualUnitPrice: weightedUnitPrice(sourceItems, 'marketActualUnitPrice'),
      })
    }
    const docId = await generateDocId(tx, '市场报货汇总')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity, 0))
    const totalAmount = fixed(prepared.reduce(
      (sum, line) => sum + line.quantity * (line.actualUnitPrice ?? 0),
      0,
    ))
    await insertDocHeader(tx, {
      id: docId,
      docType: '市场报货汇总',
      status: '已完成',
      // 跨市场汇总没有单一来源市场：source 与 market 都留空，端点只有供应链一侧
      // （`chk_inventory_docs_org_endpoint` 只要求两个端点至少有一个非空）。
      sourceOrgNodeId: null,
      targetOrgNodeId: supplyChainLocationId,
      marketId: null,
      docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      const unitDiscount = line.standardUnitPrice !== null && line.actualUnitPrice !== null
        ? fixed(line.standardUnitPrice - line.actualUnitPrice)
        : null
      const itemId = await insertDocItem(tx, {
        docId,
        skuId: line.sku.skuId,
        skuName: line.sku.productName,
        specName: line.sku.specName,
        supplier: line.sku.supplier,
        supplierId: line.sku.supplierId,
        marketId: line.marketId,
        productSeries: line.sku.productSeries,
        quantity: line.quantity,
        requestQuantity: line.requestQuantity,
        fulfilledQuantity: 0,
        standardUnitPrice: line.standardUnitPrice,
        unitDiscount,
        actualUnitPrice: line.actualUnitPrice,
        amount: fixed(line.quantity * (line.actualUnitPrice ?? 0)),
        supplyChainUnitCost: line.sku.supplyChainPurchasePrice,
        marketStandardUnitPrice: line.standardUnitPrice,
        marketUnitDiscount: unitDiscount,
        marketActualUnitPrice: line.actualUnitPrice,
        storeStandardUnitPrice: line.sku.storePurchasePrice,
        storeUnitDiscount: 0,
        storeActualUnitPrice: line.sku.storePurchasePrice,
      })
      for (const sourceLink of allocateMarketReportSourceLinks(line.sourceItems, line.quantity)) {
        const sourceItem = line.sourceItems.find((item) => item.id === sourceLink.sourceItemId)
        if (!sourceItem) throw new ApiError('CONFLICT', '市场报货明细关联丢失，请重试')
        await insertDocLink(tx, {
          fromDocId: sourceItem.docId,
          toDocId: docId,
          relationType: '市场报货汇总',
          fromItemId: sourceItem.id,
          toItemId: itemId,
          quantity: sourceLink.quantity,
        })
      }
    }
    return docId
  })
  await logOperation(session, 'inventory.market_report_summary.create', 'inventory_docs', id, {
    supplyChainLocationId,
  })
  refreshInventoryPaths()
  return { id }
}

/**
 * 把一次采购量分摊回汇总行背后的原始市场报货明细（#194）。
 *
 * 汇总行与原始行之间是 `市场报货汇总` 血缘的一对多。每个原始行本次还能承接的量是
 * `min(该血缘占用量, 原始行数量 − 原始行已被采购占用量)` —— **后半截不能省**：
 * 同一张汇总行分两次采购时，只按血缘量分摊会把上一次已经用掉的额度重复算给同一个原始行，
 * 导致它的 `fulfilled_quantity` 涨过自身数量。
 */
async function allocateSummaryToMarketReportItems(
  tx: Tx,
  summaryItemId: number,
  quantity: number,
): Promise<Array<{ reportDocId: string; reportItemId: number; quantity: number }>> {
  const links = rows<{
    from_doc_id: string
    from_item_id: number | string
    link_quantity: string | number
    report_quantity: string | number
    purchased_quantity: string | number
  }>(await tx.execute(sql`
    SELECT l.from_doc_id,
           l.from_item_id,
           COALESCE(l.quantity, 0) AS link_quantity,
           report_item.quantity AS report_quantity,
           COALESCE(purchased.quantity, 0) AS purchased_quantity
      FROM inventory_doc_links l
      JOIN inventory_doc_items report_item ON report_item.id = l.from_item_id
      JOIN LATERAL (
        SELECT COALESCE(SUM(p.quantity), 0) AS quantity
          FROM inventory_doc_links p
          JOIN inventory_docs purchase_doc ON purchase_doc.id = p.to_doc_id
         WHERE p.from_item_id = l.from_item_id
           AND p.relation_type = '市场报货采购订单'
           AND purchase_doc.status <> '已取消'
      ) purchased ON true
     WHERE l.to_item_id = ${summaryItemId}
       AND l.relation_type = '市场报货汇总'
     ORDER BY l.from_item_id
  `))
  let remaining = Math.max(0, fixed(quantity))
  const allocations: Array<{ reportDocId: string; reportItemId: number; quantity: number }> = []
  for (const link of links) {
    if (remaining <= EPSILON) break
    const capacity = fixed(Math.min(
      Number(link.link_quantity),
      Number(link.report_quantity) - Number(link.purchased_quantity),
    ))
    if (capacity <= EPSILON) continue
    const allocated = fixed(Math.min(capacity, remaining))
    allocations.push({
      reportDocId: link.from_doc_id,
      reportItemId: Number(link.from_item_id),
      quantity: allocated,
    })
    remaining = fixed(remaining - allocated)
  }
  if (remaining > EPSILON) {
    throw new ApiError('CONFLICT', '市场报货汇总的来源需求已被其它采购订单占用，请刷新后重试')
  }
  return allocations
}

interface PreparedPurchaseSource {
  /** `市场` = 走品项公司发货的行；`供应链` = 走供应链采购入库的行。 */
  kind: '市场' | '供应链'
  source: DocItemSnapshot
  sku: SkuSnapshot
  quantity: number
  marketId: string | null
  standardUnitPrice: number | null
  unitDiscount: number | null
  actualUnitPrice: number | null
  supplyChainUnitCost: number | null
}

/**
 * 合并后的采购订单（#194）：一次汇总多张报货单，按 SKU × 市场 成行下单。
 *
 * 取代原先的 `createPurchaseOrderFromMarketReplenishment` /
 * `createPurchaseOrderFromItemCompanyReplenishment` 两个几乎逐行相同的入口。三点变化：
 *
 * 1. **来源可多张、可混类**（`市场报货汇总` + `品项公司报货需求`），同 SKU 同市场跨单并成一行；
 * 2. **供应商跟着商品走**：取 `inventory_skus.supplier_id`，单头不再挂供应商。缺档案的 SKU
 *    一次性收集后阻断提交，不允许带着空供应商下单；
 * 3. **单头不再写 market_id / supplier_id**，归属下沉到明细行，下游按行分流。
 *
 * 「已下单量」统一按血缘算（原先品项公司链路读的是 `fulfilled_quantity`）：血缘会排除已取消的
 * 采购单，而 `fulfilled_quantity` 不随取消回退，两者在有取消发生时会分叉。
 */
export async function createPurchaseOrder(
  session: AuthSession,
  input: CreateMergedPurchaseOrderInput,
): Promise<{ id: string }> {
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '采购订单至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '供应链库存主体')
    assertLocationWritable(session, supplyChain)
    const seen = new Set<number>()
    const prepared: PreparedPurchaseSource[] = []
    const missingSupplier = new Map<string, string>()
    for (const line of input.items) {
      const sourceItemId = Number(line.sourceItemId)
      if (!Number.isInteger(sourceItemId) || sourceItemId <= 0 || seen.has(sourceItemId)) {
        throw new ApiError('INVALID_PARAMS', '来源明细不能重复引用')
      }
      seen.add(sourceItemId)
      const quantity = positive(line.quantity, '采购数量')
      const source = await docItemForUpdate(tx, sourceItemId)
      const header = await docForUpdate(tx, source.docId)
      if (header.status === '已取消') {
        throw new ApiError('INVALID_STATE', '来源单据已取消')
      }
      if (header.targetOrgNodeId !== supplyChain.orgNodeId) {
        throw new ApiError('INVALID_STATE', '来源单据不属于所选供应链主体')
      }
      const sku = await loadSku(tx, source.skuId, false, false)
      // fail-closed：供应商现在是按商品带出的，缺档案就没法下单。先收集齐再一次性报，
      // 免得操作人补一个、报一个。
      if (!sku.supplierId) {
        missingSupplier.set(sku.skuId, sku.productName)
        continue
      }
      if (header.docType === '市场报货汇总') {
        const ordered = await linkedQuantity(tx, source.id, '报货汇总采购订单')
        if (nearlyGreater(quantity, source.quantity - ordered)) {
          throw new ApiError('CONFLICT', '采购数量不能超过市场报货汇总中的未下单数量')
        }
        const marketId = required(source.marketId, '汇总明细的市场归属')
        assertSkuAvailableToMarket(sku, marketId)
        prepared.push({
          kind: '市场',
          source,
          sku,
          quantity,
          marketId,
          standardUnitPrice: source.marketStandardUnitPrice,
          unitDiscount: source.marketUnitDiscount,
          actualUnitPrice: source.marketActualUnitPrice,
          supplyChainUnitCost: sku.supplyChainPurchasePrice,
        })
      } else if (header.docType === '品项公司报货需求') {
        if (header.status !== '已完成') {
          throw new ApiError('INVALID_STATE', '采购订单必须引用有效的品项公司报货需求单')
        }
        // source 兼容 null（历史形态）与总部主体（insertDocHeader 的同节点归一化形态）。
        // 这道守卫拦的是 source 指向市场、或带了市场归属的异常需求单 —— 它们不该走供应链链路。
        if (
          (header.sourceOrgNodeId !== null && header.sourceOrgNodeId !== supplyChain.orgNodeId)
          || header.marketId !== null
        ) {
          throw new ApiError('INVALID_STATE', '品项公司报货需求的供应链主体不一致')
        }
        const ordered = await linkedQuantity(tx, source.id, '品项公司报货采购订单')
        if (nearlyGreater(quantity, source.quantity - ordered)) {
          throw new ApiError('CONFLICT', '采购数量不能超过品项公司报货中的未下单数量')
        }
        assertSupplyChainSku(sku)
        const cost = requiredSupplyChainCost(sku, source.supplyChainUnitCost)
        prepared.push({
          kind: '供应链',
          source,
          sku,
          quantity,
          marketId: null,
          standardUnitPrice: cost,
          unitDiscount: null,
          actualUnitPrice: cost,
          supplyChainUnitCost: cost,
        })
      } else {
        throw new ApiError('INVALID_STATE', '采购订单只能引用市场报货汇总或品项公司报货需求')
      }
    }
    if (missingSupplier.size > 0) {
      const names = Array.from(missingSupplier.values()).join('、')
      throw new ApiError(
        'INVALID_STATE',
        `以下商品未绑定供应商档案，请先在商品资料补全后再下单：${names}`,
      )
    }
    if (prepared.length === 0) {
      throw new ApiError('INVALID_PARAMS', '采购订单至少需要一条明细')
    }
    // 同 SKU 同市场跨来源单合并成一行；市场行的 marketId 必非空、供应链行必为空，
    // 因此同一组里的 kind 一定一致。
    const groups = new Map<string, {
      kind: '市场' | '供应链'
      sku: SkuSnapshot
      marketId: string | null
      quantity: number
      amount: number
      standardAmount: number
      pricedQuantity: number
      supplyChainUnitCost: number | null
      sources: PreparedPurchaseSource[]
    }>()
    for (const line of prepared) {
      const key = `${line.sku.skuId}@${line.marketId ?? ''}`
      const group = groups.get(key) ?? {
        kind: line.kind,
        sku: line.sku,
        marketId: line.marketId,
        quantity: 0,
        amount: 0,
        standardAmount: 0,
        pricedQuantity: 0,
        supplyChainUnitCost: line.supplyChainUnitCost,
        sources: [],
      }
      group.quantity = fixed(group.quantity + line.quantity)
      if (line.actualUnitPrice !== null) {
        group.amount = fixed(group.amount + line.quantity * line.actualUnitPrice)
        group.standardAmount = fixed(
          group.standardAmount + line.quantity * (line.standardUnitPrice ?? line.actualUnitPrice),
        )
        group.pricedQuantity = fixed(group.pricedQuantity + line.quantity)
      }
      group.sources.push(line)
      groups.set(key, group)
    }
    const lines = Array.from(groups.values())
    // 含供应链行就得等收货；纯市场行的单沿用收敛前「建单即已完成」的口径（市场行不经供应链入库）。
    const hasSupplyChainLine = lines.some((line) => line.kind === '供应链')
    const docId = await generateDocId(tx, '采购订单')
    const totalQuantity = fixed(lines.reduce((sum, line) => sum + line.quantity, 0))
    const totalAmount = fixed(lines.reduce((sum, line) => sum + line.amount, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '采购订单',
      status: hasSupplyChainLine ? '待收货' : '已完成',
      // 一张单可含多市场多供应商，单头两列已无法表达，归属全部下沉到明细行。
      sourceOrgNodeId: null,
      targetOrgNodeId: supplyChainLocationId,
      marketId: null,
      supplierId: null,
      supplierName: null,
      docDate: input.docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of lines) {
      const actualUnitPrice = line.pricedQuantity > EPSILON
        ? fixed(line.amount / line.pricedQuantity)
        : null
      const standardUnitPrice = line.pricedQuantity > EPSILON
        ? fixed(line.standardAmount / line.pricedQuantity)
        : null
      const unitDiscount = standardUnitPrice !== null && actualUnitPrice !== null
        ? fixed(standardUnitPrice - actualUnitPrice)
        : null
      const isMarketLine = line.kind === '市场'
      const itemId = await insertDocItem(tx, {
        docId,
        skuId: line.sku.skuId,
        skuName: line.sku.productName,
        specName: line.sku.specName,
        supplier: line.sku.supplier,
        supplierId: line.sku.supplierId,
        marketId: line.marketId,
        productSeries: line.sku.productSeries,
        quantity: line.quantity,
        requestQuantity: fixed(line.sources.reduce((sum, item) => sum + item.source.quantity, 0)),
        fulfilledQuantity: 0,
        standardUnitPrice,
        unitDiscount,
        actualUnitPrice,
        amount: line.amount,
        supplyChainUnitCost: line.supplyChainUnitCost,
        marketStandardUnitPrice: isMarketLine ? standardUnitPrice : null,
        marketUnitDiscount: isMarketLine ? unitDiscount : null,
        marketActualUnitPrice: isMarketLine ? actualUnitPrice : null,
        storeStandardUnitPrice: isMarketLine ? line.sku.storePurchasePrice : null,
        storeUnitDiscount: isMarketLine ? 0 : null,
        storeActualUnitPrice: isMarketLine ? line.sku.storePurchasePrice : null,
      })
      for (const item of line.sources) {
        if (item.kind === '市场') {
          // 汇总单自身的履约进度
          await insertDocLink(tx, {
            fromDocId: item.source.docId,
            toDocId: docId,
            relationType: '报货汇总采购订单',
            fromItemId: item.source.id,
            toItemId: itemId,
            quantity: item.quantity,
          })
          await bumpFulfilledQuantity(tx, item.source.id, item.quantity)
          // 再跨过汇总单，直连到原始市场报货明细。这样 engine 里按
          // `市场报货采购订单` 统计「已采购」的 SQL 与 fulfilled_quantity 的回写口径
          // 都不必穿透两跳血缘，收敛前后保持一致。
          for (const allocation of await allocateSummaryToMarketReportItems(
            tx,
            item.source.id,
            item.quantity,
          )) {
            await insertDocLink(tx, {
              fromDocId: allocation.reportDocId,
              toDocId: docId,
              relationType: '市场报货采购订单',
              fromItemId: allocation.reportItemId,
              toItemId: itemId,
              quantity: allocation.quantity,
            })
            await bumpFulfilledQuantity(tx, allocation.reportItemId, allocation.quantity)
          }
        } else {
          await insertDocLink(tx, {
            fromDocId: item.source.docId,
            toDocId: docId,
            relationType: '品项公司报货采购订单',
            fromItemId: item.source.id,
            toItemId: itemId,
            quantity: item.quantity,
          })
          await bumpFulfilledQuantity(tx, item.source.id, item.quantity)
        }
      }
    }
    return docId
  })
  await logOperation(session, 'inventory.purchase_order.create', 'inventory_docs', id, {
    supplyChainLocationId,
    sourceItemCount: input.items.length,
  })
  refreshInventoryPaths()
  return { id }
}

async function bumpFulfilledQuantity(tx: Tx, itemId: number, quantity: number): Promise<void> {
  await tx.execute(sql`
    UPDATE inventory_doc_items
       SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(quantity)}
     WHERE id = ${itemId}
  `)
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
  const sourceOrgNodeId = required(input.sourceOrgNodeId, '发货总部')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '品项公司发货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const order = await docForUpdate(tx, purchaseOrderId)
    if (order.docType !== '采购订单' || order.status === '已取消') {
      throw new ApiError('INVALID_STATE', '品项公司发货必须引用有效采购订单')
    }
    if (order.targetOrgNodeId !== sourceOrgNodeId) {
      throw new ApiError('INVALID_STATE', '品项公司发货必须从采购订单指定的供应链主体发出')
    }
    const source = await locationForUpdate(tx, sourceOrgNodeId)
    assertType(source, '总部', '品项公司发货主体')
    assertLocationWritable(session, source)
    // 收敛后市场归属挂在明细行上，不再从单头取、也不再回溯血缘找唯一市场报货单
    // （一张采购单现在可以汇总多张报货单，「来源单唯一」这个前提已不成立）。
    // 发货单单头仍是单一市场，下游「市场采购入库 → 分院配货」不受影响，
    // 所以这里要求本次选中的明细行市场一致。
    let marketId: string | null = null
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
      if (!orderItem.marketId) {
        throw new ApiError(
          'INVALID_STATE',
          '该采购明细没有市场归属，属于品项公司自用采购，只能走供应链采购入库',
        )
      }
      if (marketId === null) {
        marketId = orderItem.marketId
      } else if (marketId !== orderItem.marketId) {
        throw new ApiError('INVALID_PARAMS', '一次品项公司发货只能发往同一个市场，请按市场分开发货')
      }
      const shipped = await linkedQuantity(tx, orderItem.id, '采购订单发货')
      if (nearlyGreater(quantity, orderItem.quantity - shipped)) {
        throw new ApiError('CONFLICT', '正常发货数量不能超过采购订单未发数量')
      }
      const lot = await lotForUpdate(tx, Number(line.lotId), source.locationId)
      if (lot.skuId !== orderItem.skuId) throw new ApiError('INVALID_PARAMS', '发货批次与采购订单 SKU 不一致')
      await loadLotSkuForMarket(tx, lot, marketIdForLocation(source))
      await assertLotAvailable(tx, lot, quantity + giftQuantity)
      prepared.push({ orderItem, lot, quantity, giftQuantity, remark: text(line.remark) })
    }
    if (marketId === null) {
      throw new ApiError('INVALID_PARAMS', '品项公司发货至少需要一条明细')
    }
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '采购明细所属市场')
    const docId = await generateDocId(tx, '品项公司发货')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity + line.giftQuantity, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '品项公司发货',
      status: '待收货',
      sourceOrgNodeId,
      targetOrgNodeId: marketId,
      marketId,
      // 采购单头不再挂供应商（一张单可含多个供应商），发货单头同样留空；
      // 供应商信息在明细行与批次快照上（`inventory_stock_lots.supplier`）。
      supplierId: null,
      supplierName: null,
      docDate: input.docDate,
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
          locationId: source.locationId,
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
          locationId: source.locationId,
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
    await assertInventoryBusinessWritable(tx)
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== expectedDocType || shipment.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '当前单据不能收货')
    }
    const source = await locationForUpdate(tx, required(shipment.sourceOrgNodeId, '发货主体'))
    const targetOrgNodeId = required(shipment.targetOrgNodeId, '收货主体')
    const target = await locationForUpdate(tx, targetOrgNodeId)
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
      const sourceLot = await lotForUpdate(tx, shipmentItem.lotId, source.locationId)
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
      sourceOrgNodeId: shipment.sourceOrgNodeId,
      targetOrgNodeId,
      marketId: shipment.marketId,
      supplierId: shipment.supplierId,
      supplierName: shipment.supplierName,
      docDate: input.docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const item of prepared) {
      const targetLot = await upsertLot(tx, {
        locationId: target.locationId,
        skuId: item.shipmentItem.skuId,
        skuName: item.shipmentItem.skuName,
        specName: item.shipmentItem.specName,
        supplier: item.shipmentItem.supplier,
        supplierId: item.sourceLot.supplierId ?? shipment.supplierId,
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
        sourceDocId: item.sourceLot.sourceDocId ?? docId,
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

async function completeSupplyChainPurchaseOrderIfFullyReceived(tx: Tx, purchaseOrderId: string): Promise<void> {
  const [row] = rows<{ completed: boolean }>(await tx.execute(sql`
    SELECT COALESCE(BOOL_AND(COALESCE(fulfilled_quantity, 0) >= quantity), false) AS completed
      FROM inventory_doc_items
     WHERE doc_id = ${purchaseOrderId}
  `))
  if (row?.completed) {
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已完成', updated_at = NOW()
       WHERE id = ${purchaseOrderId}
         AND status = '待收货'
    `)
  }
}

/**
 * 外部供应商到总部的实际收货。没有上游库存批次，不复用“品项公司发货 -> 市场收货”服务；
 * 每次收货直接以供应链采购订单的价格快照创建总部批次与入库流水。
 */
export async function receiveSupplyChainPurchaseOrder(
  session: AuthSession,
  input: ReceiveSupplyChainPurchaseOrderInput,
): Promise<{ id: string; purchaseOrderId: string }> {
  const purchaseOrderId = required(input.purchaseOrderId, '供应链采购订单')
  const supplyChainLocationId = required(input.supplyChainLocationId, '供应链库存主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '供应链采购入库至少需要一条明细')
  }
  await syncLocations()
  const inboundId = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const order = await docForUpdate(tx, purchaseOrderId)
    if (order.docType !== '采购订单' || order.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '供应链采购入库必须引用待收货的采购订单')
    }
    if (order.targetOrgNodeId !== supplyChainLocationId) {
      throw new ApiError('INVALID_STATE', '采购订单的库存主体不一致')
    }
    // 收敛后不再按单据类型分流，也不再回溯唯一的品项公司报货需求单
    // （一张采购单可以同时汇总多张需求单，「来源单唯一」这个前提已不成立）。
    // 能走供应链入库的只有**没有市场归属**的明细行，逐行校验见下面的循环。
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '供应链采购入库主体')
    assertLocationWritable(session, supplyChain)
    const seen = new Set<number>()
    const prepared: Array<{
      orderItem: DocItemSnapshot
      sku: SkuSnapshot
      quantity: number
      batchNo: string
      expiryDate: string | null
      isGift: boolean
      cost: number
      remark: string | null
    }> = []
    for (const line of input.items) {
      const itemId = Number(line.purchaseOrderItemId)
      if (!Number.isInteger(itemId) || itemId <= 0 || seen.has(itemId)) {
        throw new ApiError('INVALID_PARAMS', '供应链采购订单明细不能重复收货')
      }
      seen.add(itemId)
      const orderItem = await docItemForUpdate(tx, itemId, purchaseOrderId)
      if (orderItem.marketId) {
        throw new ApiError(
          'INVALID_STATE',
          '该采购明细有市场归属，应由品项公司发货送达市场，不能直接入供应链库存',
        )
      }
      const sku = await loadSku(tx, orderItem.skuId, false, false)
      assertSupplyChainSku(sku)
      if (line.isGift) {
        throw new ApiError('INVALID_PARAMS', '供应链采购入库不能将采购订单数量标记为赠送')
      }
      const quantity = positive(line.quantity, '实收数量')
      const received = await linkedQuantity(tx, orderItem.id, '采购订单供应链采购入库')
      if (nearlyGreater(quantity, orderItem.quantity - received)) {
        throw new ApiError('CONFLICT', '实收数量不能超过采购订单待收数量')
      }
      const expiryDate = text(line.expiryDate)
      if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
        throw new ApiError('INVALID_PARAMS', '效期格式应为 YYYY-MM-DD')
      }
      prepared.push({
        orderItem,
        sku,
        quantity,
        batchNo: text(line.batchNo) ?? '',
        expiryDate,
        isGift: false,
        cost: requiredSupplyChainCost(sku, orderItem.supplyChainUnitCost),
        remark: text(line.remark),
      })
    }
    const docId = await generateDocId(tx, '供应链采购入库')
    const totalQuantity = fixed(prepared.reduce((sum, line) => sum + line.quantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, line) => sum + line.quantity * line.cost, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '供应链采购入库',
      status: '已完成',
      sourceOrgNodeId: null,
      targetOrgNodeId: supplyChainLocationId,
      marketId: null,
      // 一次收货可能同时收到多个供应商的行，单头挂不住；供应商落在明细行与批次快照上。
      supplierId: null,
      supplierName: null,
      docDate: input.docDate,
      totalQuantity,
      totalAmount,
      remark: input.remark,
      createdBy: session.employeeId,
      confirmed: true,
    })
    for (const line of prepared) {
      const targetLot = await upsertLot(tx, {
        locationId: supplyChain.locationId,
        skuId: line.sku.skuId,
        skuName: line.sku.productName,
        specName: line.sku.specName,
        // 供应商取采购明细行的快照（收敛后单头不再挂供应商，#194），回落到商品档案。
        supplier: line.orderItem.supplier ?? line.sku.supplier,
        // 与上一行的回落对齐：只回落名称、不回落 id 的话，lot_key 的 supplier 段会退回
        // 名称锚点，供应商一改名同一批实物就裂成两行（#132）
        supplierId: line.orderItem.supplierId ?? line.sku.supplierId,
        productSeries: line.sku.productSeries,
        batchNo: line.batchNo,
        expiryDate: line.expiryDate,
        isGift: line.isGift,
        supplyChainUnitCost: line.cost,
        marketStandardUnitPrice: null,
        marketUnitDiscount: null,
        marketActualUnitPrice: null,
        storeStandardUnitPrice: null,
        storeUnitDiscount: null,
        storeActualUnitPrice: null,
        sourceDocId: docId,
      })
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
        quantity: line.quantity,
        stockSnapshot: targetLot.quantityOnHand,
        requestQuantity: line.orderItem.quantity,
        fulfilledQuantity: 0,
        standardUnitPrice: line.cost,
        actualUnitPrice: line.cost,
        amount: fixed(line.quantity * line.cost),
        ...priceFromLot(targetLot),
        remark: line.remark,
      })
      await applyLotDelta(tx, {
        lot: targetLot,
        docId,
        docItemId,
        direction: '入库',
        quantityDelta: line.quantity,
        createdBy: session.employeeId,
        movementKey: `supply-chain-receipt:${purchaseOrderId}:item:${docItemId}`,
        remark: input.remark,
      })
      await insertDocLink(tx, {
        fromDocId: purchaseOrderId,
        toDocId: docId,
        relationType: '采购订单供应链采购入库',
        fromItemId: line.orderItem.id,
        toItemId: docItemId,
        quantity: line.quantity,
      })
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + ${numeric(line.quantity)}
         WHERE id = ${line.orderItem.id}
      `)
    }
    await completeSupplyChainPurchaseOrderIfFullyReceived(tx, purchaseOrderId)
    return docId
  })
  await logOperation(session, 'inventory.supply_chain_purchase.receive', 'inventory_docs', inboundId, {
    purchaseOrderId,
  })
  refreshInventoryPaths()
  return { id: inboundId, purchaseOrderId }
}

/**
 * 供应商短供时关闭未收数量。已完成的入库记录与批次不回滚，
 * 只释放需求单上尚未实收的占用，使其可以转给新的采购订单。
 */
export async function cancelSupplyChainPurchaseOrder(
  session: AuthSession,
  input: CancelSupplyChainPurchaseOrderInput,
): Promise<{ success: true }> {
  const purchaseOrderId = required(input.purchaseOrderId, '供应链采购订单')
  const cancellationReason = required(input.cancellationReason, '关闭原因')
  await syncLocations()
  await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const order = await docForUpdate(tx, purchaseOrderId)
    if (order.docType !== '采购订单' || order.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '只有待收货的采购订单可以关闭')
    }
    const supplyChainLocationId = required(order.targetOrgNodeId, '供应链库存主体')
    const supplyChain = await locationForUpdate(tx, supplyChainLocationId)
    assertType(supplyChain, '总部', '采购订单主体')
    assertLocationWritable(session, supplyChain)

    const orderItems = await allDocItemsForUpdate(tx, purchaseOrderId)
    if (orderItems.length === 0) {
      throw new ApiError('INVALID_STATE', '采购订单没有可关闭的明细')
    }
    // 本流程只释放「供应链侧未收货」的额度。市场归属的行走的是品项公司发货，
    // 撤回要经市场财务申请 + 供应链审批（`requestItemCompanyShipmentCancellation`），
    // 不能在这里顺手取消掉，否则绕过了那道审批。
    if (orderItems.some((item) => item.marketId)) {
      throw new ApiError(
        'INVALID_STATE',
        '该采购订单含有市场归属明细，市场部分请走品项公司发货撤回流程',
      )
    }
    const sourceLinks = rows<{
      from_item_id: number | string
      to_item_id: number | string
      quantity: string | number | null
    }>(await tx.execute(sql`
      SELECT from_item_id, to_item_id, quantity
        FROM inventory_doc_links
       WHERE to_doc_id = ${purchaseOrderId}
         AND relation_type = '品项公司报货采购订单'
       FOR UPDATE
    `))
    // 合并后一条采购明细可以汇总自**多张**品项公司报货需求的多行，因此这里按采购行分组
    // 收集全部血缘（早先按 to_item_id 建一对一 Map，多来源时只会留下最后一条，
    // 数量断言随即误判、释放额度也会漏给其它来源行）。
    const sourceLinksByOrderItem = new Map<number, typeof sourceLinks>()
    for (const link of sourceLinks) {
      const orderItemId = Number(link.to_item_id)
      const grouped = sourceLinksByOrderItem.get(orderItemId) ?? []
      grouped.push(link)
      sourceLinksByOrderItem.set(orderItemId, grouped)
    }
    const remainingByRequestItem = new Map<number, number>()
    for (const orderItem of orderItems) {
      const itemSourceLinks = sourceLinksByOrderItem.get(orderItem.id) ?? []
      if (itemSourceLinks.length === 0 || itemSourceLinks.some((link) => Number(link.from_item_id) <= 0)) {
        throw new ApiError('INVALID_STATE', '采购订单明细缺少品项公司报货血缘')
      }
      const sourceLinkedQuantity = fixed(itemSourceLinks.reduce(
        (sum, link) => sum + Number(link.quantity ?? 0),
        0,
      ))
      if (Math.abs(sourceLinkedQuantity - orderItem.quantity) > EPSILON) {
        throw new ApiError('INVALID_STATE', '采购订单明细与品项公司报货数量不一致')
      }
      const receivedQuantity = await linkedQuantity(
        tx,
        orderItem.id,
        '采购订单供应链采购入库',
      )
      if (nearlyGreater(receivedQuantity, orderItem.quantity)) {
        throw new ApiError('CONFLICT', '采购订单实收数量异常，不能关闭')
      }
      const remainingQuantity = fixed(Math.max(0, orderItem.quantity - receivedQuantity))
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = ${numeric(receivedQuantity)}
         WHERE id = ${orderItem.id}
      `)
      // 未收货的额度按血缘顺序退还给各来源需求行，退满为止。
      let unreleasedQuantity = remainingQuantity
      for (const link of itemSourceLinks) {
        if (unreleasedQuantity <= EPSILON) break
        const releasable = fixed(Math.min(Number(link.quantity ?? 0), unreleasedQuantity))
        if (releasable <= EPSILON) continue
        const requestItemId = Number(link.from_item_id)
        remainingByRequestItem.set(
          requestItemId,
          fixed((remainingByRequestItem.get(requestItemId) ?? 0) + releasable),
        )
        unreleasedQuantity = fixed(unreleasedQuantity - releasable)
      }
    }
    for (const [requestItemId, remainingQuantity] of remainingByRequestItem) {
      // 来源可能分布在多张需求单上，这里不再限定单一 companyRequestId。
      const requestItem = await docItemForUpdate(tx, requestItemId)
      const currentFulfilledQuantity = requestItem.fulfilledQuantity ?? 0
      if (nearlyGreater(remainingQuantity, currentFulfilledQuantity)) {
        throw new ApiError('CONFLICT', '品项公司报货履约数量异常，不能关闭采购订单')
      }
      await tx.execute(sql`
        UPDATE inventory_doc_items
           SET fulfilled_quantity = ${numeric(fixed(currentFulfilledQuantity - remainingQuantity))}
         WHERE id = ${requestItem.id}
      `)
    }
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '已取消', cancellation_reason = ${cancellationReason},
             cancelled_by = ${session.employeeId}, cancelled_at = NOW(), updated_at = NOW()
       WHERE id = ${purchaseOrderId}
         AND status = '待收货'
    `)
  })
  await logOperation(session, 'inventory.supply_chain_purchase.cancel', 'inventory_docs', purchaseOrderId, {
    cancellationReason,
  })
  refreshInventoryPaths()
  return { success: true }
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
  const canViewPrice = inventoryPriceVisibility(session) === 'market' || inventoryPriceVisibility(session) === 'all'
  const storeUnitDiscounts = input.items.map((line) => {
    if (!canViewPrice) {
      const suppliedDiscount = line.storeUnitDiscount ?? 0
      const parsedDiscount = Number(suppliedDiscount)
      if (!Number.isFinite(parsedDiscount)) {
        throw new ApiError('INVALID_PARAMS', '门店单价优惠不是有效数字')
      }
      if (parsedDiscount !== 0) {
        throw new ApiError('PERMISSION_DENIED', '无权设置门店单价优惠')
      }
      return 0
    }
    return nonnegative(line.storeUnitDiscount, '门店单价优惠')
  })
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const request = await docForUpdate(tx, storeRequestId)
    if (request.docType !== '门店报货' || request.status === '已取消') {
      throw new ApiError('INVALID_STATE', '分院配货必须引用有效门店报货单')
    }
    const storeId = required(request.sourceOrgNodeId, '门店报货主体')
    const marketId = required(request.marketId, '门店报货所属市场')
    if (marketId !== sourceMarketId) throw new ApiError('INVALID_PARAMS', '配货市场必须与门店报货所属市场一致')
    if (request.targetOrgNodeId !== sourceMarketId) {
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
    for (const [lineIndex, line] of input.items.entries()) {
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
      const discount = storeUnitDiscounts[lineIndex]
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
      sourceOrgNodeId: sourceMarketId,
      targetOrgNodeId: storeId,
      marketId: sourceMarketId,
      docDate: input.docDate,
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
  const sourceOrgNodeId = required(input.sourceOrgNodeId, '退货主体')
  const targetOrgNodeId = required(input.targetOrgNodeId, '回库主体')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '退货至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const source = await locationForUpdate(tx, sourceOrgNodeId)
    const target = await locationForUpdate(tx, targetOrgNodeId)
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
      const lot = await lotForUpdate(tx, lotId, source.locationId)
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
      sourceOrgNodeId,
      targetOrgNodeId,
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
        locationId: source.locationId,
        skuId: item.lot.skuId,
        quantity: item.quantity,
        status: '已预留',
        createdBy: session.employeeId,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.return.create', 'inventory_docs', id, { sourceOrgNodeId, targetOrgNodeId })
  refreshInventoryPaths()
  return { id }
}

async function allDocItemsForUpdate(tx: Tx, docId: string): Promise<DocItemSnapshot[]> {
  const raw = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, doc_id, lot_id, sku_id, sku_name, spec_name, supplier, supplier_id, market_id,
           product_series,
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
    await assertInventoryBusinessWritable(tx)
    const returnDoc = await docForUpdate(tx, returnDocId)
    if (!['院退货', '市场退货'].includes(returnDoc.docType) || returnDoc.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '当前单据不能审批回库')
    }
    const sourceOrgNodeId = required(returnDoc.sourceOrgNodeId, '退货主体')
    const targetOrgNodeId = required(returnDoc.targetOrgNodeId, '回库主体')
    const source = await locationForUpdate(tx, sourceOrgNodeId)
    const target = await locationForUpdate(tx, targetOrgNodeId)
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
      sourceOrgNodeId,
      targetOrgNodeId,
      marketId: returnDoc.marketId,
      docDate: shanghaiToday(),
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
      const sourceLot = await lotForUpdate(tx, item.lotId, source.locationId)
      if (nearlyGreater(item.quantity, sourceLot.quantityOnHand)) {
        throw new ApiError('INVALID_STATE', '退货批次当前库存不足')
      }
      const sku = await loadLotSkuForMarket(tx, sourceLot, marketIdForLocation(source))
      assertSkuAvailableToMarket(sku, marketIdForLocation(target))
      const targetLot = await upsertLot(tx, {
        locationId: target.locationId,
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        supplier: item.supplier,
        supplierId: sourceLot.supplierId,
        productSeries: item.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        ...priceFromItem(item),
        sourceDocId: sourceLot.sourceDocId ?? docId,
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
    await assertInventoryBusinessWritable(tx)
    const returnDoc = await docForUpdate(tx, returnDocId)
    if (!['院退货', '市场退货'].includes(returnDoc.docType) || returnDoc.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '当前单据不能驳回')
    }
    const target = await locationForUpdate(tx, required(returnDoc.targetOrgNodeId, '回库主体'))
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

/** 具备撤回申请权限的用户只能提交申请，不能直接回滚总部库存。 */
export async function requestItemCompanyShipmentCancellation(
  session: AuthSession,
  input: RequestItemCompanyShipmentCancellationInput,
): Promise<{ success: true }> {
  const shipmentId = required(input.shipmentId, '品项公司发货单')
  const cancellationReason = required(input.cancellationReason, '撤回原因')
  assertShipmentCancellationPermission(session, 'inventory:shipment_cancel_request')
  await syncLocations()
  await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== '品项公司发货' || shipment.status !== '待收货') {
      throw new ApiError('INVALID_STATE', '只有待收货的品项公司发货单可以申请撤回')
    }
    const source = await locationForUpdate(tx, required(shipment.sourceOrgNodeId, '发货主体'))
    assertType(source, '总部', '发货主体')
    const target = await locationForUpdate(tx, required(shipment.targetOrgNodeId, '收货市场'))
    assertType(target, '市场', '收货主体')
    if (shipment.marketId !== target.locationId) {
      throw new ApiError('INVALID_STATE', '品项公司发货的市场归属不一致')
    }
    assertLocationWritable(session, target)
    const items = await allDocItemsForUpdate(tx, shipmentId)
    if (items.some((item) => (item.fulfilledQuantity ?? 0) > EPSILON)) {
      throw new ApiError('CONFLICT', '已有实收记录的发货单不可申请撤回')
    }
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '待审批', cancellation_request_reason = ${cancellationReason},
             cancellation_requested_by = ${session.employeeId}, cancellation_requested_at = NOW(),
             rejected_by = NULL, rejected_at = NULL, audit_remark = NULL, updated_at = NOW()
       WHERE id = ${shipmentId}
    `)
  })
  await logOperation(session, 'inventory.item_company_shipment.cancellation_request', 'inventory_docs', shipmentId, { cancellationReason })
  refreshInventoryPaths()
  return { success: true }
}

/** 具备撤回审批权限的用户审批后才真正回滚总部库存与采购订单履约数量。 */
export async function approveItemCompanyShipmentCancellation(
  session: AuthSession,
  input: ResolveItemCompanyShipmentCancellationInput,
): Promise<{ success: true }> {
  const shipmentId = required(input.shipmentId, '品项公司发货单')
  assertShipmentCancellationPermission(session, 'inventory:shipment_cancel_approve')
  await syncLocations()
  await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== '品项公司发货' || shipment.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '只有待审批的品项公司发货撤回申请可以审批')
    }
    const cancellationReason = required(shipment.cancellationRequestReason, '撤回申请原因')
    const source = await locationForUpdate(tx, required(shipment.sourceOrgNodeId, '发货主体'))
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
             cancelled_by = ${session.employeeId}, cancelled_at = NOW(),
             audit_remark = ${text(input.auditRemark)}, updated_at = NOW()
       WHERE id = ${shipmentId}
    `)
  })
  await logOperation(session, 'inventory.item_company_shipment.cancellation_approve', 'inventory_docs', shipmentId, {
    auditRemark: text(input.auditRemark),
  })
  refreshInventoryPaths()
  return { success: true }
}

/** 具备撤回审批权限的用户驳回后，发货单恢复待收货，市场可继续正常收货。 */
export async function rejectItemCompanyShipmentCancellation(
  session: AuthSession,
  input: ResolveItemCompanyShipmentCancellationInput & { auditRemark: string },
): Promise<{ success: true }> {
  const shipmentId = required(input.shipmentId, '品项公司发货单')
  const auditRemark = required(input.auditRemark, '驳回原因')
  assertShipmentCancellationPermission(session, 'inventory:shipment_cancel_approve')
  await syncLocations()
  await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const shipment = await docForUpdate(tx, shipmentId)
    if (shipment.docType !== '品项公司发货' || shipment.status !== '待审批') {
      throw new ApiError('INVALID_STATE', '只有待审批的品项公司发货撤回申请可以驳回')
    }
    const source = await locationForUpdate(tx, required(shipment.sourceOrgNodeId, '发货主体'))
    assertType(source, '总部', '发货主体')
    assertLocationWritable(session, source)
    await tx.execute(sql`
      UPDATE inventory_docs
         SET status = '待收货', rejected_by = ${session.employeeId}, rejected_at = NOW(),
             audit_remark = ${auditRemark}, updated_at = NOW()
       WHERE id = ${shipmentId}
    `)
  })
  await logOperation(session, 'inventory.item_company_shipment.cancellation_reject', 'inventory_docs', shipmentId, { auditRemark })
  refreshInventoryPaths()
  return { success: true }
}

/** @deprecated 使用撤回申请流程，避免市场端直接回滚总部库存。 */
export async function cancelItemCompanyShipment(
  session: AuthSession,
  input: RequestItemCompanyShipmentCancellationInput,
): Promise<{ success: true }> {
  return requestItemCompanyShipmentCancellation(session, input)
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
    await assertInventoryBusinessWritable(tx)
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
      sourceOrgNodeId: marketId,
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

/**
 * 供应链员工购只扣减所选总部库存，并使用供应链 SKU 的市场结算价计入单据金额。
 * 总部员工必须位于该总部组织树内，且其祖先链不能经过市场或门店。
 */
export async function createSupplyChainStaffPurchase(
  session: AuthSession,
  input: CreateSupplyChainStaffPurchaseInput,
): Promise<{ id: string }> {
  const locationId = required(input.locationId, '供应链库存主体')
  const employeeId = required(input.employeeId, '购买员工')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '供应链员工购至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const location = await locationForUpdate(tx, locationId)
    assertType(location, '总部', '供应链员工购出库主体')
    assertLocationWritable(session, location)
    const employee = await employeeForSupplyChain(tx, employeeId, locationId)
    const seenLots = new Set<number>()
    const prepared: Array<{ lot: LotSnapshot; quantity: number; price: number; remark: string | null }> = []
    for (const line of input.items) {
      const lotId = Number(line.lotId)
      if (!Number.isInteger(lotId) || lotId <= 0 || seenLots.has(lotId)) {
        throw new ApiError('INVALID_PARAMS', '供应链员工购库存批次不能重复')
      }
      seenLots.add(lotId)
      const lot = await lotForUpdate(tx, lotId, locationId)
      const quantity = positive(line.quantity, '供应链员工购数量')
      await assertLotAvailable(tx, lot, quantity)
      const sku = await loadLotSkuForMarket(tx, lot, null)
      assertSupplyChainSku(sku)
      if (sku.marketPurchasePrice === null) {
        throw new ApiError('INVALID_STATE', `SKU ${sku.productName} 未设置市场结算价`)
      }
      prepared.push({ lot, quantity, price: sku.marketPurchasePrice, remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, '供应链员工购出库')
    const totalQuantity = fixed(prepared.reduce((sum, item) => sum + item.quantity, 0))
    const totalAmount = fixed(prepared.reduce((sum, item) => sum + item.quantity * item.price, 0))
    await insertDocHeader(tx, {
      id: docId,
      docType: '供应链员工购出库',
      status: '已完成',
      sourceOrgNodeId: locationId,
      marketId: null,
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
        movementKey: `supply-chain-staff-purchase:${docId}:item:${docItemId}`,
        remark: input.remark,
      })
    }
    return docId
  })
  await logOperation(session, 'inventory.supply_chain_staff_purchase.create', 'inventory_docs', id, { locationId, employeeId })
  refreshInventoryPaths()
  return { id }
}

/** 具备自采入库权限的用户登记入库；只接收归属当前市场的市场自采/转让店 SKU。 */
export async function createSelfPurchasedReceipt(
  session: AuthSession,
  input: CreateSelfPurchasedReceiptInput,
): Promise<{ id: string }> {
  assertSelfPurchaseReceiptPermission(session)
  const marketId = required(input.marketId, '市场')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '自采产品入库至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '自采入库主体')
    assertLocationWritable(session, market)
    const supplier = await ensureSupplier(tx, required(input.supplierId, '供应商'))
    const supplierName = supplier.name
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
      targetOrgNodeId: marketId,
      marketId,
      supplierId: supplier.id,
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
        supplierId: supplier.id,
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
  const locationId = required(input.locationId, '供应链库存主体')
  const externalPartyName = required(input.externalPartyName, '外部对象')
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '非凤御市场出库至少需要一条明细')
  }
  await syncLocations()
  const id = await db.transaction(async (tx) => {
    await assertInventoryBusinessWritable(tx)
    const location = await locationForUpdate(tx, locationId)
    assertType(location, '总部', '非凤御市场出库主体')
    assertLocationWritable(session, location)
    const seenLots = new Set<number>()
    const prepared: Array<{ lot: LotSnapshot; quantity: number; remark: string | null }> = []
    for (const line of input.items) {
      const lotId = Number(line.lotId)
      if (!Number.isInteger(lotId) || lotId <= 0 || seenLots.has(lotId)) {
        throw new ApiError('INVALID_PARAMS', '出库库存批次不能重复')
      }
      seenLots.add(lotId)
      const lot = await lotForUpdate(tx, lotId, locationId)
      const quantity = positive(line.quantity, '出库数量')
      await assertLotAvailable(tx, lot, quantity)
      await loadLotSkuForMarket(tx, lot, null)
      prepared.push({ lot, quantity, remark: text(line.remark) })
    }
    const docId = await generateDocId(tx, '非凤御市场出库')
    await insertDocHeader(tx, {
      id: docId,
      docType: '非凤御市场出库',
      status: '已完成',
      sourceOrgNodeId: locationId,
      marketId: null,
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
  await logOperation(session, 'inventory.external_market_outbound.create', 'inventory_docs', id, { locationId, externalPartyName })
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
    await assertInventoryBusinessWritable(tx)
    const location = await locationForUpdate(tx, locationId)
    // 转换是主体内部 SKU↔SKU 动作，总部/市场/门店皆可发起（engine SPECIALIZED 注释亦归为
    // 通用库存动作）；主体归属由 assertLocationWritable 按 session scope 校验，不再限总部。
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
      sourceOrgNodeId: locationId,
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
      targetOrgNodeId: locationId,
      marketId,
      docDate: input.docDate,
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
        supplierId: item.sourceLot.supplierId,
        productSeries: item.targetSku.productSeries,
        batchNo: item.targetBatchNo,
        expiryDate: item.targetExpiryDate,
        isGift: item.sourceLot.isGift,
        ...priceFromLot(item.sourceLot),
        sourceDocId: item.sourceLot.sourceDocId ?? inboundId,
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
export async function quoteMarketReplenishmentPrices(
  session: AuthSession,
  input: {
    marketId: string
    items: MarketQuoteRequest[]
    docDate?: string | null
    selections?: MarketPromotionSelectionInput[]
  },
): Promise<MarketPromotionQuoteResult> {
  const marketId = required(input.marketId, '市场')
  if (!hasPermission(session, 'inventory:market_price_view')) {
    throw new ApiError('PERMISSION_DENIED', '无权查看市场报货价格')
  }
  await syncLocations()
  return db.transaction(async (tx) => {
    const market = await locationForUpdate(tx, marketId)
    assertType(market, '市场', '市场')
    assertLocationWritable(session, market)
    return quoteMarketPricesInTx(tx, {
      marketId,
      items: input.items,
      docDate: dateOrToday(input.docDate),
      selections: input.selections,
    })
  })
}

/** @deprecated 兼容旧调用；新页面统一使用批量报价，确保组合福利按整单判断。 */
export async function quoteMarketReplenishmentPrice(
  session: AuthSession,
  input: {
    marketId: string
    skuId: string
    quantity: number
    docDate?: string | null
    basketItems?: MarketQuoteRequest[]
  },
): Promise<PromotionQuote> {
  const skuId = required(input.skuId, '库存 SKU')
  const quantity = positive(input.quantity, '采购数量')
  const result = await quoteMarketReplenishmentPrices(session, {
    marketId: input.marketId,
    items: input.basketItems?.length ? input.basketItems : [{ skuId, quantity }],
    docDate: input.docDate,
  })
  const quote = result.items.find((item) => item.skuId === skuId)
  if (!quote) throw new ApiError('INVALID_PARAMS', '报价明细中未包含当前库存 SKU')
  return quote
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
    const source = shipment.sourceOrgNodeId ? await locationForUpdate(tx, shipment.sourceOrgNodeId) : null
    const target = shipment.targetOrgNodeId ? await locationForUpdate(tx, shipment.targetOrgNodeId) : null
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
