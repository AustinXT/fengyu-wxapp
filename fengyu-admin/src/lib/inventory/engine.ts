import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import { logOperation } from '@/lib/operation-log'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import {
  inventoryDocItems,
  inventoryDocs,
  inventoryLocations,
  inventoryMovements,
  inventoryPromotionPlanItems,
  inventoryPromotionPlans,
  inventorySkus,
  inventoryStockLots,
  inventorySuppliers,
} from '@db/inventory'
import { orgNodes, stores } from '@db/org'
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { AuthSession } from '@/lib/types'
import {
  INVENTORY_DOC_TYPES,
  INVENTORY_GENERIC_DOC_TYPES,
  INVENTORY_SKU_SOURCE_TYPES,
  type CreateInventoryDocInput,
  type InventoryCoreDocStatus,
  type InventoryDocDetail,
  type InventoryDocItemInput,
  type InventoryDocRow,
  type InventoryDocType,
  type InventoryLocationRow,
  type InventoryLocationType,
  type InventoryLotRow,
  type InventoryPromotionPlanInput,
  type InventoryPromotionPlanItemInput,
  type InventoryPromotionPlanRow,
  type InventorySkuInput,
  type InventorySkuRow,
  type InventorySkuSourceType,
  type InventorySupplierInput,
  type InventorySupplierRow,
} from './types'

const sourceLocation = alias(inventoryLocations, 'source_loc')
const targetLocation = alias(inventoryLocations, 'target_loc')

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

interface LockedLot {
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

const DOC_PREFIX: Record<InventoryDocType, string> = {
  门店报货: 'DBH',
  市场报货: 'MBH',
  采购订单: 'CGD',
  供应链采购入库: 'GRK',
  品项公司发货: 'GFH',
  市场采购入库: 'MRK',
  自采产品入库: 'ZRK',
  分院配货: 'FPH',
  院入库: 'YRK',
  分院调货出库: 'DTO',
  分院调货入库: 'DTI',
  市场间调货出库: 'MTO',
  市场间调货入库: 'MTI',
  员工购出库: 'YGG',
  内部领用: 'NLY',
  非凤御市场出库: 'FFY',
  市场退货: 'MTH',
  市场退货入库: 'MTR',
  供应链退货入库: 'GTR',
  院退货: 'YTH',
  院顾客产品出库: 'GCK',
  院顾客退货: 'GTH',
  市场产品报损: 'MBS',
  院产品报损: 'YBS',
  市场产品盘溢: 'MPY',
  市场库存盘点: 'MPD',
  分院库存盘点: 'YPD',
  库存转换出库: 'ZHO',
  库存转换入库: 'ZHI',
  期初库存: 'QC',
}

const NO_MOVEMENT_DOC_TYPES = new Set<InventoryDocType>(['门店报货', '市场报货', '采购订单'])
const RECEIVE_REQUIRED_DOC_TYPES = new Set<InventoryDocType>([
  '品项公司发货',
  '分院配货',
  '分院调货出库',
  '市场间调货出库',
])
const APPROVAL_DOC_TYPES = new Set<InventoryDocType>([
  '市场退货',
  '院退货',
  '市场产品报损',
  '院产品报损',
])
const INBOUND_DOC_TYPES = new Set<InventoryDocType>([
  '供应链采购入库',
  '市场采购入库',
  '自采产品入库',
  '院入库',
  '分院调货入库',
  '市场间调货入库',
  '院顾客退货',
  '市场退货入库',
  '供应链退货入库',
  '市场产品盘溢',
  '库存转换入库',
  '期初库存',
])
const OUTBOUND_DOC_TYPES = new Set<InventoryDocType>([
  '员工购出库',
  '内部领用',
  '非凤御市场出库',
  '市场退货',
  '院退货',
  '院顾客产品出库',
  '市场产品报损',
  '院产品报损',
  '库存转换出库',
])

const RECEIVE_INBOUND_TYPE: Partial<Record<InventoryDocType, InventoryDocType>> = {
  品项公司发货: '市场采购入库',
  分院配货: '院入库',
  分院调货出库: '分院调货入库',
  市场间调货出库: '市场间调货入库',
}

/**
 * 这些单据必须由专用业务服务创建，才能保留需求、优惠、批次与履约关系。
 * 通用建单只负责盘点、领用、报损、转换等没有上游业务血缘的库存动作。
 */
const SPECIALIZED_DOC_TYPES = new Set<InventoryDocType>([
  '门店报货',
  '市场报货',
  '采购订单',
  '品项公司发货',
  '市场采购入库',
  '自采产品入库',
  '分院配货',
  '院入库',
  '员工购出库',
  '非凤御市场出库',
  '市场退货',
  '市场退货入库',
  '供应链退货入库',
  '院退货',
  '库存转换出库',
  '库存转换入库',
])

/**
 * 这三类单据没有手工建单入口：调货入库必须由出库单收货确认生成，
 * 期初库存只能由 WorkFine 切换脚本写入，避免任意业务角色绕过库存血缘。
 */
const SYSTEM_DERIVED_DOC_TYPES = new Set<InventoryDocType>([
  '分院调货入库',
  '市场间调货入库',
  '期初库存',
])

const GENERIC_DOC_TYPE_SET = new Set<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES)

function isValidDocType(docType: string): docType is InventoryDocType {
  return (INVENTORY_DOC_TYPES as readonly string[]).includes(docType)
}

function normalizeText(v: string | null | undefined): string | null {
  const s = v?.trim()
  return s ? s : null
}

function normalizeRequired(v: string | null | undefined, label: string): string {
  const s = normalizeText(v)
  if (!s) throw new ApiError('INVALID_PARAMS', `缺少${label}`)
  return s
}

function normalizeYmd(v: string | null | undefined, label: string): string {
  const value = normalizeRequired(v, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('INVALID_PARAMS', `${label}格式应为 YYYY-MM-DD`)
  }
  return value
}

function numberOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function numString(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ApiError('INVALID_PARAMS', '金额或数量不是有效数字')
  return String(n)
}

function assertPositiveQuantity(quantity: number): number {
  const n = Number(quantity)
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError('INVALID_PARAMS', '明细数量必须大于 0')
  }
  return n
}

function defaultStatusForDoc(docType: InventoryDocType): InventoryCoreDocStatus {
  if (APPROVAL_DOC_TYPES.has(docType)) return '待审批'
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType)) return '待收货'
  return '已完成'
}

function movementPlan(
  docType: InventoryDocType,
  status: InventoryCoreDocStatus,
): { locationRole: 'source' | 'target'; direction: '入库' | '出库' } | null {
  if (status === '草稿' || status === '待审批' || status === '已驳回' || status === '已取消') {
    return null
  }
  if (NO_MOVEMENT_DOC_TYPES.has(docType)) return null
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType)) return { locationRole: 'source', direction: '出库' }
  if (INBOUND_DOC_TYPES.has(docType)) return { locationRole: 'target', direction: '入库' }
  if (OUTBOUND_DOC_TYPES.has(docType)) return { locationRole: 'source', direction: '出库' }
  return null
}

function actingLocationIdForDoc(input: CreateInventoryDocInput): string | null {
  if (RECEIVE_REQUIRED_DOC_TYPES.has(input.docType) || OUTBOUND_DOC_TYPES.has(input.docType)) {
    return normalizeText(input.sourceLocationId)
  }
  if (INBOUND_DOC_TYPES.has(input.docType)) return normalizeText(input.targetLocationId)
  return normalizeText(input.sourceLocationId) ?? normalizeText(input.targetLocationId)
}

function canViewPrice(session: AuthSession): boolean {
  return hasPermission(session, 'inventory:price_view')
}

function stripPriceInput(item: InventoryDocItemInput): InventoryDocItemInput {
  return {
    ...item,
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
  }
}

function skuPriceValues(
  input: Partial<InventorySkuInput>,
  allowPriceInput: boolean,
  existing?: {
    accountingPrice: string | number | null
    marketPurchaseDiscount: string | number | null
  },
) {
  if (!allowPriceInput) {
    return {
      retailPrice: undefined,
      accountingPrice: undefined,
      supplyChainPurchasePrice: undefined,
      marketPurchasePrice: undefined,
      storePurchasePrice: undefined,
      marketStaffPurchasePrice: undefined,
      marketPurchaseDiscount: undefined,
      storePurchaseDiscount: undefined,
      staffPurchaseDiscount: undefined,
      itemCompanyPurchasePrice: undefined,
    }
  }
  const accountingPrice = input.accountingPrice === undefined ? undefined : numString(input.accountingPrice)
  const marketPurchaseDiscount = input.marketPurchaseDiscount === undefined
    ? undefined
    : numString(input.marketPurchaseDiscount)
  const rawAccounting = input.accountingPrice === undefined
    ? numberOrNull(existing?.accountingPrice)
    : numberOrNull(input.accountingPrice)
  const rawDiscount = input.marketPurchaseDiscount === undefined
    ? numberOrNull(existing?.marketPurchaseDiscount)
    : numberOrNull(input.marketPurchaseDiscount)
  const hasMarketPriceFormula = rawAccounting !== null || rawDiscount !== null
  let marketPurchasePrice: string | null | undefined

  // 市场进货价是核算价与市场折扣的派生值，不能被前端或福利方案改写。
  // 旧 WorkFine 导入仍可保留历史快照；在线维护只在完整公式存在时重算。
  if (hasMarketPriceFormula) {
    if (rawAccounting === null || rawDiscount === null) {
      throw new ApiError('INVALID_PARAMS', '设置核算价或市场折扣时，必须同时具备两项数据')
    }
    const ratio = rawDiscount > 1 ? rawDiscount / 100 : rawDiscount
    if (!Number.isFinite(rawAccounting) || rawAccounting < 0 || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new ApiError('INVALID_PARAMS', '核算价或市场折扣无效')
    }
    marketPurchasePrice = numString(Math.round(rawAccounting * ratio * 100) / 100)
  } else if (input.marketPurchasePrice === null) {
    marketPurchasePrice = null
  } else if (input.marketPurchasePrice !== undefined) {
    throw new ApiError('INVALID_PARAMS', '市场进货价由核算价和市场折扣计算，不能手工填写')
  }
  return {
    retailPrice: input.retailPrice === undefined ? undefined : numString(input.retailPrice),
    accountingPrice,
    supplyChainPurchasePrice: input.supplyChainPurchasePrice === undefined ? undefined : numString(input.supplyChainPurchasePrice),
    marketPurchasePrice,
    storePurchasePrice: input.storePurchasePrice === undefined ? undefined : numString(input.storePurchasePrice),
    marketStaffPurchasePrice: input.marketStaffPurchasePrice === undefined ? undefined : numString(input.marketStaffPurchasePrice),
    marketPurchaseDiscount,
    storePurchaseDiscount: input.storePurchaseDiscount === undefined ? undefined : numString(input.storePurchaseDiscount),
    staffPurchaseDiscount: input.staffPurchaseDiscount === undefined ? undefined : numString(input.staffPurchaseDiscount),
    itemCompanyPurchasePrice: input.itemCompanyPurchasePrice === undefined ? undefined : numString(input.itemCompanyPurchasePrice),
  }
}

function makeLotKey(
  skuId: string,
  item: {
    batchNo?: string | null
    expiryDate?: string | null
    isGift?: boolean
    supplyChainUnitCost?: number | null
    marketActualUnitPrice?: number | null
    storeActualUnitPrice?: number | null
  },
): string {
  const priceKey = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? ''
      : Number(v).toFixed(4)
  return [
    skuId,
    normalizeText(item.batchNo) ?? '',
    normalizeText(item.expiryDate) ?? '',
    item.isGift ? 'gift' : 'normal',
    priceKey(item.supplyChainUnitCost),
    priceKey(item.marketActualUnitPrice),
    priceKey(item.storeActualUnitPrice),
  ].join('|')
}

export async function syncInventoryLocations(): Promise<void> {
  await db.execute(sql`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id, is_active)
    SELECT id, type, name, id, parent_id, is_active
      FROM org_nodes
     WHERE type IN ('总部','市场')
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

async function scopedLocationIds(session: AuthSession): Promise<string[] | null> {
  if (isAdminScope(session) || session.roles.some((r) => r.scopeType === '总部')) {
    return null
  }

  const ids = new Set<string>()
  const marketIds: string[] = []
  const storeNodeIds: string[] = []
  for (const role of session.roles) {
    if (role.scopeType === '市场') {
      ids.add(role.scopeId)
      marketIds.push(role.scopeId)
    } else if (role.scopeType === '门店') {
      storeNodeIds.push(role.scopeId)
    }
  }

  if (marketIds.length > 0) {
    const storeNodeRows = await db
      .select({ id: orgNodes.id })
      .from(orgNodes)
      .where(and(inArray(orgNodes.parentId, marketIds), eq(orgNodes.type, '门店')))
    const marketStoreNodeIds = storeNodeRows.map((row) => row.id)
    if (marketStoreNodeIds.length > 0) {
      const rows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(inArray(stores.orgNodeId, marketStoreNodeIds))
      for (const row of rows) {
        ids.add(row.storeId)
      }
    }
  }

  if (storeNodeIds.length > 0) {
    const rows = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .where(inArray(stores.orgNodeId, storeNodeIds))
    for (const row of rows) {
      ids.add(row.storeId)
    }
  }

  return Array.from(ids)
}

async function assertLocationVisible(session: AuthSession, locationId: string): Promise<void> {
  const scoped = await scopedLocationIds(session)
  if (scoped === null) return
  if (!scoped.includes(locationId)) {
    throw new ApiError('PERMISSION_DENIED', '无权操作该库存主体')
  }
}

async function loadTransferLocations(
  sourceLocationId: string | null | undefined,
  targetLocationId: string | null | undefined,
): Promise<{
  source: { locationId: string; locationType: string; parentLocationId: string | null }
  target: { locationId: string; locationType: string; parentLocationId: string | null }
}> {
  if (!sourceLocationId || !targetLocationId) {
    throw new ApiError('INVALID_PARAMS', '调货单据缺少出入库主体')
  }
  if (sourceLocationId === targetLocationId) {
    throw new ApiError('INVALID_PARAMS', '调货出入库主体不能相同')
  }
  const list = await db
    .select({
      locationId: inventoryLocations.locationId,
      locationType: inventoryLocations.locationType,
      parentLocationId: inventoryLocations.parentLocationId,
    })
    .from(inventoryLocations)
    .where(inArray(inventoryLocations.locationId, [sourceLocationId, targetLocationId]))
  if (list.length !== 2) {
    throw new ApiError('NOT_FOUND', '调货库存主体不存在')
  }
  const byId = new Map(list.map((row) => [row.locationId, row]))
  const source = byId.get(sourceLocationId)
  const target = byId.get(targetLocationId)
  if (!source || !target) {
    throw new ApiError('NOT_FOUND', '调货库存主体不存在')
  }
  return { source, target }
}

async function assertSameMarketForStoreTransfer(
  sourceLocationId: string | null | undefined,
  targetLocationId: string | null | undefined,
): Promise<void> {
  const { source, target } = await loadTransferLocations(sourceLocationId, targetLocationId)
  if (
    source.locationType !== '门店' ||
    target.locationType !== '门店'
  ) {
    throw new ApiError('INVALID_PARAMS', '分院调货的出入库主体必须均为门店')
  }
  if (!source.parentLocationId || source.parentLocationId !== target.parentLocationId) {
    throw new ApiError('INVALID_PARAMS', '同市场内部的门店才可调货')
  }
}

async function assertMarketTransferLocations(
  sourceLocationId: string | null | undefined,
  targetLocationId: string | null | undefined,
): Promise<void> {
  const { source, target } = await loadTransferLocations(sourceLocationId, targetLocationId)
  if (source.locationType !== '市场' || target.locationType !== '市场') {
    throw new ApiError('INVALID_PARAMS', '市场间调货的出入库主体必须均为市场')
  }
}

async function assertLocationType(
  locationId: string,
  expectedType: InventoryLocationType,
  label: string,
): Promise<void> {
  const [location] = await db
    .select({ locationType: inventoryLocations.locationType })
    .from(inventoryLocations)
    .where(eq(inventoryLocations.locationId, locationId))
    .limit(1)
  if (!location) throw new ApiError('NOT_FOUND', `${label}不存在`)
  if (location.locationType !== expectedType) {
    throw new ApiError('INVALID_PARAMS', `${label}必须是${expectedType}`)
  }
}

async function assertGenericDocLocationRules(
  input: CreateInventoryDocInput,
  sourceLocationId: string | null,
  targetLocationId: string | null,
  actingLocationId: string,
): Promise<void> {
  switch (input.docType) {
    case '供应链采购入库':
      if (!targetLocationId) throw new ApiError('INVALID_PARAMS', '供应链采购入库缺少入库主体')
      await assertLocationType(targetLocationId, '总部', '供应链采购入库主体')
      return
    case '分院调货出库':
      await assertSameMarketForStoreTransfer(sourceLocationId, targetLocationId)
      return
    case '市场间调货出库':
      await assertMarketTransferLocations(sourceLocationId, targetLocationId)
      return
    case '内部领用':
      if (!sourceLocationId) throw new ApiError('INVALID_PARAMS', '内部领用缺少出库主体')
      await assertLocationType(sourceLocationId, '总部', '内部领用出库主体')
      return
    case '院顾客产品出库':
    case '院产品报损':
      if (!sourceLocationId) throw new ApiError('INVALID_PARAMS', `${input.docType}缺少出库主体`)
      await assertLocationType(sourceLocationId, '门店', `${input.docType}出库主体`)
      return
    case '院顾客退货':
      if (!targetLocationId) throw new ApiError('INVALID_PARAMS', '院顾客退货缺少入库主体')
      await assertLocationType(targetLocationId, '门店', '院顾客退货入库主体')
      return
    case '市场产品报损':
      if (!sourceLocationId) throw new ApiError('INVALID_PARAMS', '市场产品报损缺少出库主体')
      await assertLocationType(sourceLocationId, '市场', '市场产品报损出库主体')
      return
    case '市场产品盘溢':
      if (!targetLocationId) throw new ApiError('INVALID_PARAMS', '市场产品盘溢缺少入库主体')
      await assertLocationType(targetLocationId, '市场', '市场产品盘溢入库主体')
      return
    case '市场库存盘点':
      await assertLocationType(actingLocationId, '市场', '市场库存盘点主体')
      return
    case '分院库存盘点':
      await assertLocationType(actingLocationId, '门店', '分院库存盘点主体')
      return
  }
}

async function ensureLocationExists(locationId: string): Promise<void> {
  await syncInventoryLocations()
  const rows = await db
    .select({ id: inventoryLocations.locationId })
    .from(inventoryLocations)
    .where(eq(inventoryLocations.locationId, locationId))
    .limit(1)
  if (rows.length === 0) throw new ApiError('NOT_FOUND', '库存主体不存在')
}

async function normalizeSkuOwnerMarket(
  session: AuthSession,
  sourceType: InventorySkuSourceType,
  ownerMarketIdInput: string | null | undefined,
): Promise<string | null> {
  const ownerMarketId = normalizeText(ownerMarketIdInput)
  if (sourceType === '供应链') {
    if (ownerMarketId) {
      throw new ApiError('INVALID_PARAMS', '供应链 SKU 不应设置自采归属市场')
    }
    return null
  }
  if (!ownerMarketId) {
    throw new ApiError('INVALID_PARAMS', '市场自采或转让店 SKU 必须设置归属市场')
  }
  await syncInventoryLocations()
  const [market] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(and(eq(orgNodes.id, ownerMarketId), eq(orgNodes.type, '市场'), eq(orgNodes.isActive, true)))
    .limit(1)
  if (!market) throw new ApiError('NOT_FOUND', '归属市场不存在或已停用')
  await assertLocationVisible(session, ownerMarketId)
  return ownerMarketId
}

function assertGenericDocTransition(docType: InventoryDocType): void {
  if (!GENERIC_DOC_TYPE_SET.has(docType)) {
    throw new ApiError('INVALID_STATE', '该库存单据必须通过对应的专用业务流程处理')
  }
}

function assertSelfPurchasedSkuEditor(session: AuthSession, sourceType: InventorySkuSourceType): void {
  if (sourceType === '供应链') return
  if (isAdminScope(session) || session.roles.some((role) => role.role === 'finance')) return
  throw new ApiError('PERMISSION_DENIED', '市场自采和转让店产品资料仅限市场财务维护')
}

async function generateDocNo(tx: Tx, docType: InventoryDocType): Promise<string> {
  const prefix = DOC_PREFIX[docType]
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_docs:${prefix}:${ymd}`}))`)
  const rows = await tx.execute(sql`
    SELECT id
      FROM inventory_docs
     WHERE id LIKE ${`${prefix}-${ymd}-%`}
  ORDER BY id DESC
     LIMIT 1
  `)
  const latest = (rows as unknown as Array<{ id: string }>)[0]?.id
  const seq = latest ? Number(latest.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function lockLotById(
  tx: Tx,
  lotId: number,
  locationId?: string | null,
): Promise<LockedLot> {
  const rows = await tx.execute(sql`
    SELECT id, location_id, sku_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity_on_hand,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price
      FROM inventory_stock_lots
     WHERE id = ${lotId}
       AND (${locationId ?? null}::text IS NULL OR location_id = ${locationId ?? null})
     FOR UPDATE
  `)
  const row = (rows as unknown as Array<{
    id: number
    location_id: string
    sku_id: string
    sku_name: string
    spec_name: string | null
    supplier: string | null
    product_series: string | null
    batch_no: string | null
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
  }>)[0]
  if (!row) throw new ApiError('NOT_FOUND', '库存批次不存在或不属于当前库存主体')
  return {
    id: Number(row.id),
    locationId: row.location_id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    specName: row.spec_name,
    supplier: row.supplier,
    productSeries: row.product_series,
    batchNo: row.batch_no ?? '',
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

async function assertSkuAvailableAtLocation(
  tx: Tx,
  sku: {
    productName: string
    sourceType: InventorySkuSourceType
    ownerMarketId: string | null
  },
  locationId: string,
): Promise<void> {
  if (sku.sourceType === '供应链') return
  const rows = await tx.execute(sql`
    SELECT location_id, location_type, parent_location_id
      FROM inventory_locations
     WHERE location_id = ${locationId}
     LIMIT 1
  `)
  const location = (rows as unknown as Array<{
    location_id: string
    location_type: InventoryLocationType
    parent_location_id: string | null
  }>)[0]
  if (!location) throw new ApiError('NOT_FOUND', '库存主体不存在')
  const marketId = location.location_type === '市场'
    ? location.location_id
    : location.location_type === '门店'
      ? location.parent_location_id
      : null
  if (!marketId || sku.ownerMarketId !== marketId) {
    throw new ApiError('INVALID_STATE', `${sku.sourceType} SKU ${sku.productName} 仅可在归属市场使用`)
  }
}

async function assertSkuIdAvailableAtLocation(
  tx: Tx,
  skuId: string,
  locationId: string,
): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT product_name, source_type, owner_market_id
      FROM inventory_skus
     WHERE sku_id = ${skuId}
     LIMIT 1
  `)
  const sku = (rows as unknown as Array<{
    product_name: string
    source_type: InventorySkuSourceType
    owner_market_id: string | null
  }>)[0]
  if (!sku) throw new ApiError('NOT_FOUND', '库存 SKU 不存在')
  await assertSkuAvailableAtLocation(tx, {
    productName: sku.product_name,
    sourceType: sku.source_type,
    ownerMarketId: sku.owner_market_id,
  }, locationId)
}

async function ensureLotFromSku(
  tx: Tx,
  locationId: string,
  item: InventoryDocItemInput,
  sourceDocId: string,
): Promise<LockedLot> {
  const skuId = normalizeRequired(item.skuId, '库存 SKU')
  const skuRows = await tx.execute(sql`
    SELECT sku_id, product_name, spec_name, supplier, product_series,
           source_type, owner_market_id, supply_chain_purchase_price,
           market_purchase_price, store_purchase_price
      FROM inventory_skus
     WHERE sku_id = ${skuId}
       AND is_active = true
     LIMIT 1
  `)
  const sku = (skuRows as unknown as Array<{
    sku_id: string
    product_name: string
    spec_name: string | null
    supplier: string | null
    product_series: string | null
    source_type: InventorySkuSourceType
    owner_market_id: string | null
    supply_chain_purchase_price: string | number | null
    market_purchase_price: string | number | null
    store_purchase_price: string | number | null
  }>)[0]
  if (!sku) throw new ApiError('NOT_FOUND', '库存 SKU 不存在或已停用')
  await assertSkuAvailableAtLocation(tx, {
    productName: sku.product_name,
    sourceType: sku.source_type,
    ownerMarketId: sku.owner_market_id,
  }, locationId)

  const batchNo = normalizeText(item.batchNo) ?? ''
  const expiryDate = normalizeText(item.expiryDate)
  const isGift = Boolean(item.isGift)
  const supplyChainUnitCost =
    item.supplyChainUnitCost ?? numberOrNull(sku.supply_chain_purchase_price)
  const marketStandardUnitPrice =
    item.marketStandardUnitPrice ?? numberOrNull(sku.market_purchase_price)
  const marketUnitDiscount = item.marketUnitDiscount ?? null
  const marketActualUnitPrice =
    item.marketActualUnitPrice ??
    (marketStandardUnitPrice == null
      ? null
      : marketStandardUnitPrice - Number(marketUnitDiscount ?? 0))
  const storeStandardUnitPrice =
    item.storeStandardUnitPrice ?? numberOrNull(sku.store_purchase_price)
  const storeUnitDiscount = item.storeUnitDiscount ?? null
  const storeActualUnitPrice =
    item.storeActualUnitPrice ??
    (storeStandardUnitPrice == null
      ? null
      : storeStandardUnitPrice - Number(storeUnitDiscount ?? 0))
  const lotKey = makeLotKey(skuId, {
    batchNo,
    expiryDate,
    isGift,
    supplyChainUnitCost,
    marketActualUnitPrice,
    storeActualUnitPrice,
  })

  const rows = await tx.execute(sql`
    INSERT INTO inventory_stock_lots (
      location_id, sku_id, lot_key, sku_name, spec_name, supplier, product_series,
      batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, source_doc_id
    )
    VALUES (
      ${locationId}, ${sku.sku_id}, ${lotKey}, ${sku.product_name}, ${sku.spec_name},
      ${sku.supplier}, ${sku.product_series}, ${batchNo}, ${expiryDate}, ${expiryDate ?? ''},
      ${isGift}, 0, ${numString(supplyChainUnitCost)}, ${numString(marketStandardUnitPrice)},
      ${numString(marketUnitDiscount)}, ${numString(marketActualUnitPrice)},
      ${numString(storeStandardUnitPrice)}, ${numString(storeUnitDiscount)},
      ${numString(storeActualUnitPrice)}, ${sourceDocId}
    )
    ON CONFLICT (location_id, lot_key)
    DO UPDATE SET
      sku_name = EXCLUDED.sku_name,
      spec_name = EXCLUDED.spec_name,
      supplier = EXCLUDED.supplier,
      product_series = EXCLUDED.product_series,
      updated_at = NOW()
    RETURNING id
  `)
  const id = Number((rows as unknown as Array<{ id: number }>)[0].id)
  return lockLotById(tx, id, locationId)
}

async function skuSnapshot(
  tx: Tx,
  skuId: string,
): Promise<Pick<LockedLot, 'skuId' | 'skuName' | 'specName' | 'supplier' | 'productSeries'>> {
  const rows = await tx.execute(sql`
    SELECT sku_id, product_name, spec_name, supplier, product_series
      FROM inventory_skus
     WHERE sku_id = ${skuId}
     LIMIT 1
  `)
  const row = (rows as unknown as Array<{
    sku_id: string
    product_name: string
    spec_name: string | null
    supplier: string | null
    product_series: string | null
  }>)[0]
  if (!row) throw new ApiError('NOT_FOUND', '库存 SKU 不存在')
  return {
    skuId: row.sku_id,
    skuName: row.product_name,
    specName: row.spec_name,
    supplier: row.supplier,
    productSeries: row.product_series,
  }
}

async function activeReservedQuantity(tx: Tx, lotId: number): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
      FROM inventory_stock_reservations
     WHERE lot_id = ${lotId}
       AND status = '已预留'
  `)
  return Number((rows as unknown as Array<{ quantity: string | number | null }>)[0]?.quantity ?? 0)
}

async function applyMovement(
  tx: Tx,
  params: {
    lot: LockedLot
    docId: string
    docItemId: number
    direction: '入库' | '出库' | '调整'
    quantity: number
    createdBy: string
    movementKey: string
    remark?: string | null
  },
): Promise<void> {
  const before = params.lot.quantityOnHand
  const delta = params.direction === '出库' ? -params.quantity : params.quantity
  const after = before + delta
  if (params.direction === '出库') {
    const reserved = await activeReservedQuantity(tx, params.lot.id)
    const available = before - reserved
    if (params.quantity > available) {
      throw new ApiError('INVALID_STATE', `库存不足：${params.lot.skuName} 可用 ${Math.max(available, 0)}`)
    }
  }
  if (after < 0) {
    throw new ApiError('INVALID_STATE', `库存不足：${params.lot.skuName} 当前 ${before}`)
  }
  await tx.execute(sql`
    UPDATE inventory_stock_lots
       SET quantity_on_hand = ${after},
           updated_at = NOW()
     WHERE id = ${params.lot.id}
  `)
  await tx.execute(sql`
    INSERT INTO inventory_movements (
      movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id,
      direction, quantity_delta, quantity_before, quantity_after, created_by, remark
    )
    VALUES (
      ${params.movementKey}, ${params.lot.id}, ${params.lot.locationId}, ${params.lot.skuId},
      ${params.docId}, ${params.docItemId}, ${params.direction}, ${delta},
      ${before}, ${after}, ${params.createdBy}, ${params.remark ?? null}
    )
  `)
  params.lot.quantityOnHand = after
}

function skuRow(row: {
  sku: typeof inventorySkus.$inferSelect
  ownerMarketName: string | null
  includePrice: boolean
}): InventorySkuRow {
  const sku = row.sku
  return {
    skuId: sku.skuId,
    productCode: sku.productCode,
    productName: sku.productName,
    specName: sku.specName,
    supplier: sku.supplier,
    manufacturer: sku.manufacturer,
    brand: sku.brand,
    productSeries: sku.productSeries,
    purchaseCategory: sku.purchaseCategory,
    sourceType: sku.sourceType as InventorySkuSourceType,
    ownerMarketId: sku.ownerMarketId,
    ownerMarketName: row.ownerMarketName,
    retailPrice: row.includePrice ? numberOrNull(sku.retailPrice) : null,
    accountingPrice: row.includePrice ? numberOrNull(sku.accountingPrice) : null,
    supplyChainPurchasePrice: row.includePrice ? numberOrNull(sku.supplyChainPurchasePrice) : null,
    marketPurchasePrice: row.includePrice ? numberOrNull(sku.marketPurchasePrice) : null,
    storePurchasePrice: row.includePrice ? numberOrNull(sku.storePurchasePrice) : null,
    marketStaffPurchasePrice: row.includePrice ? numberOrNull(sku.marketStaffPurchasePrice) : null,
    marketPurchaseDiscount: row.includePrice ? numberOrNull(sku.marketPurchaseDiscount) : null,
    storePurchaseDiscount: row.includePrice ? numberOrNull(sku.storePurchaseDiscount) : null,
    staffPurchaseDiscount: row.includePrice ? numberOrNull(sku.staffPurchaseDiscount) : null,
    itemCompanyPurchasePrice: row.includePrice ? numberOrNull(sku.itemCompanyPurchasePrice) : null,
    isReportable: sku.isReportable,
    isActive: sku.isActive,
    remark: sku.remark,
    createdAt: sku.createdAt.toISOString(),
    updatedAt: sku.updatedAt.toISOString(),
  }
}

function docRow(row: {
  doc: typeof inventoryDocs.$inferSelect
  sourceLocationName: string | null
  sourceLocationType: string | null
  targetLocationName: string | null
  targetLocationType: string | null
  includePrice: boolean
}): InventoryDocRow {
  const doc = row.doc
  return {
    id: doc.id,
    docType: doc.docType as InventoryDocType,
    status: doc.status as InventoryCoreDocStatus,
    sourceLocationId: doc.sourceLocationId,
    sourceLocationName: row.sourceLocationName,
    sourceLocationType: row.sourceLocationType as InventoryLocationType | null,
    targetLocationId: doc.targetLocationId,
    targetLocationName: row.targetLocationName,
    targetLocationType: row.targetLocationType as InventoryLocationType | null,
    marketId: doc.marketId,
    supplierId: doc.supplierId,
    docDate: doc.docDate,
    relatedDocId: doc.relatedDocId,
    requestDocId: doc.requestDocId,
    relatedSaleOrderId: doc.relatedSaleOrderId,
    customerName: doc.customerName,
    employeeName: doc.employeeName,
    supplierName: doc.supplierName,
    externalPartyName: doc.externalPartyName,
    logisticsCompany: doc.logisticsCompany,
    trackingNo: doc.trackingNo,
    receiptAttachmentUrl: doc.receiptAttachmentUrl,
    totalQuantity: Number(doc.totalQuantity),
    totalAmount: row.includePrice ? numberOrNull(doc.totalAmount) : undefined,
    remark: doc.remark,
    auditRemark: doc.auditRemark,
    createdBy: doc.createdBy,
    confirmedAt: doc.confirmedAt?.toISOString() ?? null,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    rejectedAt: doc.rejectedAt?.toISOString() ?? null,
    cancellationReason: doc.cancellationReason,
    cancelledAt: doc.cancelledAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

function lotRow(
  row: {
    lot: typeof inventoryStockLots.$inferSelect
    locationName: string | null
    locationType: string | null
  },
  includePrice: boolean,
): InventoryLotRow {
  return {
    id: row.lot.id,
    locationId: row.lot.locationId,
    locationName: row.locationName,
    locationType: row.locationType as InventoryLocationType | null,
    skuId: row.lot.skuId,
    skuName: row.lot.skuName,
    specName: row.lot.specName,
    supplier: row.lot.supplier,
    productSeries: row.lot.productSeries,
    batchNo: row.lot.batchNo,
    expiryDate: row.lot.expiryDate,
    isGift: row.lot.isGift,
    quantityOnHand: Number(row.lot.quantityOnHand),
    supplyChainUnitCost: includePrice ? numberOrNull(row.lot.supplyChainUnitCost) : undefined,
    marketActualUnitPrice: includePrice ? numberOrNull(row.lot.marketActualUnitPrice) : undefined,
    storeActualUnitPrice: includePrice ? numberOrNull(row.lot.storeActualUnitPrice) : undefined,
    remark: row.lot.remark,
    updatedAt: row.lot.updatedAt.toISOString(),
  }
}

export const listInventoryLocations = withPermission(
  'inventory:stock_list',
  async (session): Promise<InventoryLocationRow[]> => {
    await syncInventoryLocations()
    const scoped = await scopedLocationIds(session)
    const conditions: (SQL | undefined)[] = [eq(inventoryLocations.isActive, true)]
    if (scoped !== null) {
      conditions.push(scoped.length > 0 ? inArray(inventoryLocations.locationId, scoped) : sql`FALSE`)
    }
    const rows = await db
      .select()
      .from(inventoryLocations)
      .where(and(...conditions))
      .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name))
    return rows.map((row) => ({
      locationId: row.locationId,
      locationType: row.locationType as InventoryLocationType,
      name: row.name,
      orgNodeId: row.orgNodeId,
      storeId: row.storeId,
      parentLocationId: row.parentLocationId,
      isActive: row.isActive,
    }))
  },
)

export const listInventorySkus = withPermission(
  'inventory:stock_list',
  async (
    session,
    filters: { keyword?: string; sourceType?: InventorySkuSourceType; onlyActive?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<{ data: InventorySkuRow[]; total: number }> => {
    await syncInventoryLocations()
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = []
    const scoped = await scopedLocationIds(session)
    if (scoped !== null) {
      const marketRows = scoped.length === 0
        ? []
        : await db
          .select({ locationId: inventoryLocations.locationId, locationType: inventoryLocations.locationType, parentLocationId: inventoryLocations.parentLocationId })
          .from(inventoryLocations)
          .where(inArray(inventoryLocations.locationId, scoped))
      const marketIds = Array.from(new Set(marketRows.flatMap((location) => {
        if (location.locationType === '市场') return [location.locationId]
        return location.parentLocationId ? [location.parentLocationId] : []
      })))
      conditions.push(
        marketIds.length > 0
          ? or(eq(inventorySkus.sourceType, '供应链'), inArray(inventorySkus.ownerMarketId, marketIds))
          : eq(inventorySkus.sourceType, '供应链'),
      )
    }
    if (filters.onlyActive ?? true) conditions.push(eq(inventorySkus.isActive, true))
    if (filters.sourceType) conditions.push(eq(inventorySkus.sourceType, filters.sourceType))
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(inventorySkus.skuId, pattern),
          ilike(inventorySkus.productCode, pattern),
          ilike(inventorySkus.productName, pattern),
          ilike(inventorySkus.specName, pattern),
          ilike(inventorySkus.productSeries, pattern),
        ),
      )
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventorySkus)
      .where(whereClause)
    const rows = await db
      .select({ sku: inventorySkus, ownerMarketName: orgNodes.name })
      .from(inventorySkus)
      .leftJoin(orgNodes, eq(inventorySkus.ownerMarketId, orgNodes.id))
      .where(whereClause)
      .orderBy(asc(inventorySkus.productCode))
      .limit(pageSize)
      .offset(offset)
    const priceVisible = canViewPrice(session)
    return { data: rows.map((row) => skuRow({ ...row, includePrice: priceVisible })), total: countRow?.count ?? 0 }
  },
)

export const createInventorySku = withPermission(
  'inventory:create',
  async (session, input: InventorySkuInput): Promise<{ success: true; skuId: string }> => {
    const productCode = normalizeRequired(input.productCode, '产品编号')
    const productName = normalizeRequired(input.productName, '产品名称')
    const skuId = normalizeText(input.skuId) ?? productCode
    const sourceType = input.sourceType ?? '供应链'
    if (!INVENTORY_SKU_SOURCE_TYPES.includes(sourceType)) {
      throw new ApiError('INVALID_PARAMS', '无效库存商品来源')
    }
    assertSelfPurchasedSkuEditor(session, sourceType)
    const ownerMarketId = await normalizeSkuOwnerMarket(session, sourceType, input.ownerMarketId)
    const priceValues = skuPriceValues(input, canViewPrice(session))
    await db.insert(inventorySkus).values({
      skuId,
      productCode,
      productName,
      specName: normalizeText(input.specName),
      supplier: normalizeText(input.supplier),
      manufacturer: normalizeText(input.manufacturer),
      brand: normalizeText(input.brand),
      productSeries: normalizeText(input.productSeries),
      purchaseCategory: normalizeText(input.purchaseCategory),
      sourceType,
      ownerMarketId,
      ...priceValues,
      isReportable: input.isReportable ?? true,
      isActive: input.isActive ?? true,
      remark: normalizeText(input.remark),
    })
    await logOperation(session, 'create', 'inventory_skus', skuId, { productCode, productName })
    revalidatePath('/inventory')
    revalidatePath('/inventory/skus')
    return { success: true, skuId }
  },
)

export const updateInventorySku = withPermission(
  'inventory:update',
  async (session, skuId: string, input: Partial<InventorySkuInput>): Promise<{ success: true }> => {
    const id = normalizeRequired(skuId, '库存 SKU')
    if (input.sourceType && !INVENTORY_SKU_SOURCE_TYPES.includes(input.sourceType)) {
      throw new ApiError('INVALID_PARAMS', '无效库存商品来源')
    }
    const [current] = await db
      .select({
        accountingPrice: inventorySkus.accountingPrice,
        marketPurchaseDiscount: inventorySkus.marketPurchaseDiscount,
        sourceType: inventorySkus.sourceType,
        ownerMarketId: inventorySkus.ownerMarketId,
      })
      .from(inventorySkus)
      .where(eq(inventorySkus.skuId, id))
      .limit(1)
    if (!current) throw new ApiError('NOT_FOUND', '库存 SKU 不存在')
    const currentSourceType = current.sourceType as InventorySkuSourceType
    const sourceType = (input.sourceType ?? currentSourceType) as InventorySkuSourceType
    const requestedOwnerMarketId = input.ownerMarketId === undefined
      ? current.ownerMarketId
      : normalizeText(input.ownerMarketId)
    if (sourceType !== currentSourceType || requestedOwnerMarketId !== current.ownerMarketId) {
      throw new ApiError('INVALID_STATE', '库存 SKU 的来源和归属市场创建后不可修改，请停用后新建正确资料')
    }
    assertSelfPurchasedSkuEditor(session, currentSourceType)
    assertSelfPurchasedSkuEditor(session, sourceType)
    if (current.ownerMarketId) await assertLocationVisible(session, current.ownerMarketId)
    const ownerMarketId = await normalizeSkuOwnerMarket(
      session,
      sourceType,
      requestedOwnerMarketId,
    )
    const priceValues = skuPriceValues(input, canViewPrice(session), current)
    await db
      .update(inventorySkus)
      .set({
        productCode: normalizeText(input.productCode) ?? undefined,
        productName: normalizeText(input.productName) ?? undefined,
        specName: input.specName === undefined ? undefined : normalizeText(input.specName),
        supplier: input.supplier === undefined ? undefined : normalizeText(input.supplier),
        manufacturer: input.manufacturer === undefined ? undefined : normalizeText(input.manufacturer),
        brand: input.brand === undefined ? undefined : normalizeText(input.brand),
        productSeries: input.productSeries === undefined ? undefined : normalizeText(input.productSeries),
        purchaseCategory: input.purchaseCategory === undefined ? undefined : normalizeText(input.purchaseCategory),
        sourceType,
        ownerMarketId,
        ...priceValues,
        isReportable: input.isReportable,
        isActive: input.isActive,
        remark: input.remark === undefined ? undefined : normalizeText(input.remark),
        updatedAt: new Date(),
      })
      .where(eq(inventorySkus.skuId, id))
    await logOperation(session, 'update', 'inventory_skus', id, input)
    revalidatePath('/inventory/skus')
    return { success: true }
  },
)

export const listInventoryLots = withPermission(
  'inventory:stock_list',
  async (
    session,
    filters: {
      locationId?: string
      locationType?: InventoryLocationType
      skuId?: string
      keyword?: string
      onlyPositive?: boolean
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: InventoryLotRow[]; total: number; canViewPrice: boolean }> => {
    await syncInventoryLocations()
    const scoped = await scopedLocationIds(session)
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = []
    if (scoped !== null) {
      conditions.push(scoped.length > 0 ? inArray(inventoryStockLots.locationId, scoped) : sql`FALSE`)
    }
    if (filters.locationId) conditions.push(eq(inventoryStockLots.locationId, filters.locationId))
    if (filters.locationType) conditions.push(eq(inventoryLocations.locationType, filters.locationType))
    if (filters.skuId) conditions.push(eq(inventoryStockLots.skuId, filters.skuId))
    if (filters.onlyPositive) conditions.push(sql`${inventoryStockLots.quantityOnHand} > 0`)
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(inventoryStockLots.skuId, pattern),
          ilike(inventoryStockLots.skuName, pattern),
          ilike(inventoryStockLots.specName, pattern),
          ilike(inventoryStockLots.batchNo, pattern),
          ilike(inventoryLocations.name, pattern),
        ),
      )
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(whereClause)
    const rows = await db
      .select({ lot: inventoryStockLots, locationName: inventoryLocations.name, locationType: inventoryLocations.locationType })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(whereClause)
      .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo))
      .limit(pageSize)
      .offset(offset)
    const priceVisible = canViewPrice(session)
    return {
      data: rows.map((row) => lotRow(row, priceVisible)),
      total: countRow?.count ?? 0,
      canViewPrice: priceVisible,
    }
  },
)

export const listInventoryLotOptions = withPermission(
  'inventory:stock_list',
  async (session, locationId: string, skuId: string): Promise<InventoryLotRow[]> => {
    const normalizedLocationId = normalizeRequired(locationId, '出库主体')
    const normalizedSkuId = normalizeRequired(skuId, '库存 SKU')
    await syncInventoryLocations()
    await assertLocationVisible(session, normalizedLocationId)
    const rows = await db
      .select({
        lot: inventoryStockLots,
        locationName: inventoryLocations.name,
        locationType: inventoryLocations.locationType,
      })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(and(
        eq(inventoryStockLots.locationId, normalizedLocationId),
        eq(inventoryStockLots.skuId, normalizedSkuId),
        sql`${inventoryStockLots.quantityOnHand} > 0`,
      ))
      .orderBy(asc(inventoryStockLots.expiryDate), asc(inventoryStockLots.batchNo), asc(inventoryStockLots.id))
    const priceVisible = canViewPrice(session)
    return rows.map((row) => lotRow(row, priceVisible))
  },
)

export const exportInventoryLots = withPermission(
  'inventory:export',
  async (
    session,
    params: Record<string, string | undefined> = {},
  ): Promise<{ rows: InventoryLotRow[]; truncated: boolean; canViewPrice: boolean }> => {
    const LIMIT = 10000
    await syncInventoryLocations()
    const scoped = await scopedLocationIds(session)
    const locationId = params.locationId ?? params.location
    const locationType = params.locationType ?? params.type
    const keyword = params.keyword ?? params.q
    const conditions: (SQL | undefined)[] = []
    if (scoped !== null) {
      conditions.push(scoped.length > 0 ? inArray(inventoryStockLots.locationId, scoped) : sql`FALSE`)
    }
    if (locationId) conditions.push(eq(inventoryStockLots.locationId, locationId))
    if (locationType) conditions.push(eq(inventoryLocations.locationType, locationType))
    if (params.skuId) conditions.push(eq(inventoryStockLots.skuId, params.skuId))
    if (params.onlyPositive === '1') conditions.push(sql`${inventoryStockLots.quantityOnHand} > 0`)
    if (keyword) {
      const pattern = `%${keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(inventoryStockLots.skuId, pattern),
          ilike(inventoryStockLots.skuName, pattern),
          ilike(inventoryStockLots.specName, pattern),
          ilike(inventoryStockLots.batchNo, pattern),
          ilike(inventoryLocations.name, pattern),
        ),
      )
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
    const rows = await db
      .select({ lot: inventoryStockLots, locationName: inventoryLocations.name, locationType: inventoryLocations.locationType })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(whereClause)
      .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo))
      .limit(LIMIT + 1)
    const priceVisible = canViewPrice(session)
    const truncated = rows.length > LIMIT
    return {
      rows: rows.slice(0, LIMIT).map((row) => lotRow(row, priceVisible)),
      truncated,
      canViewPrice: priceVisible,
    }
  },
)

export const listInventoryCoreDocs = withPermission(
  'inventory:list',
  async (
    session,
    filters: {
      locationId?: string
      docType?: InventoryDocType
      status?: InventoryCoreDocStatus
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: InventoryDocRow[]; total: number; canViewPrice: boolean }> => {
    await syncInventoryLocations()
    const scoped = await scopedLocationIds(session)
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = []
    if (scoped !== null) {
      conditions.push(scoped.length > 0
        ? or(inArray(inventoryDocs.sourceLocationId, scoped), inArray(inventoryDocs.targetLocationId, scoped))
        : sql`FALSE`)
    }
    if (filters.locationId) {
      conditions.push(or(eq(inventoryDocs.sourceLocationId, filters.locationId), eq(inventoryDocs.targetLocationId, filters.locationId)))
    }
    if (filters.docType) conditions.push(eq(inventoryDocs.docType, filters.docType))
    if (filters.status) conditions.push(eq(inventoryDocs.status, filters.status))
    if (filters.startDate) conditions.push(gte(inventoryDocs.docDate, filters.startDate))
    if (filters.endDate) conditions.push(lte(inventoryDocs.docDate, filters.endDate))
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(
        or(
          ilike(inventoryDocs.id, pattern),
          ilike(inventoryDocs.customerName, pattern),
          ilike(inventoryDocs.employeeName, pattern),
          ilike(inventoryDocs.remark, pattern),
        ),
      )
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryDocs)
      .where(whereClause)
    const rows = await db
      .select({
        doc: inventoryDocs,
        sourceLocationName: sourceLocation.name,
        sourceLocationType: sourceLocation.locationType,
        targetLocationName: targetLocation.name,
        targetLocationType: targetLocation.locationType,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.locationId, inventoryDocs.sourceLocationId))
      .leftJoin(targetLocation, eq(targetLocation.locationId, inventoryDocs.targetLocationId))
      .where(whereClause)
      .orderBy(desc(inventoryDocs.docDate), desc(inventoryDocs.createdAt))
      .limit(pageSize)
      .offset(offset)
    const priceVisible = canViewPrice(session)
    return {
      data: rows.map((row) => docRow({ ...row, includePrice: priceVisible })),
      total: countRow?.count ?? 0,
      canViewPrice: priceVisible,
    }
  },
)

export const getInventoryCoreDocById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<InventoryDocDetail | null> => {
    const priceVisible = canViewPrice(session)
    const scoped = await scopedLocationIds(session)
    const conditions: (SQL | undefined)[] = [eq(inventoryDocs.id, id)]
    if (scoped !== null) {
      conditions.push(scoped.length > 0
        ? or(inArray(inventoryDocs.sourceLocationId, scoped), inArray(inventoryDocs.targetLocationId, scoped))
        : sql`FALSE`)
    }
    const [headRow] = await db
      .select({
        doc: inventoryDocs,
        sourceLocationName: sourceLocation.name,
        sourceLocationType: sourceLocation.locationType,
        targetLocationName: targetLocation.name,
        targetLocationType: targetLocation.locationType,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.locationId, inventoryDocs.sourceLocationId))
      .leftJoin(targetLocation, eq(targetLocation.locationId, inventoryDocs.targetLocationId))
      .where(and(...conditions))
      .limit(1)
    if (!headRow) return null
    const head = docRow({ ...headRow, includePrice: priceVisible })
    const items = await db
      .select()
      .from(inventoryDocItems)
      .where(eq(inventoryDocItems.docId, id))
      .orderBy(asc(inventoryDocItems.id))
    return {
      ...head,
      items: items.map((item) => ({
        id: item.id,
        docId: item.docId,
        lotId: item.lotId,
        skuId: item.skuId,
        saleItemId: item.saleItemId,
        skuName: item.skuName,
        specName: item.specName,
        supplier: item.supplier,
        productSeries: item.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        quantity: Number(item.quantity),
        stockSnapshot: numberOrNull(item.stockSnapshot),
        requestQuantity: numberOrNull(item.requestQuantity),
        fulfilledQuantity: numberOrNull(item.fulfilledQuantity),
        standardUnitPrice: priceVisible ? numberOrNull(item.standardUnitPrice) : undefined,
        unitDiscount: priceVisible ? numberOrNull(item.unitDiscount) : undefined,
        actualUnitPrice: priceVisible ? numberOrNull(item.actualUnitPrice) : undefined,
        amount: priceVisible ? numberOrNull(item.amount) : undefined,
        supplyChainUnitCost: priceVisible ? numberOrNull(item.supplyChainUnitCost) : undefined,
        marketActualUnitPrice: priceVisible ? numberOrNull(item.marketActualUnitPrice) : undefined,
        storeActualUnitPrice: priceVisible ? numberOrNull(item.storeActualUnitPrice) : undefined,
        reason: item.reason,
        remark: item.remark,
        createdAt: item.createdAt.toISOString(),
      })),
    }
  },
)

export const createInventoryCoreDoc = withPermission(
  'inventory:create_doc',
  async (session, input: CreateInventoryDocInput): Promise<{ success: true; id: string }> => {
    if (!isValidDocType(input.docType)) throw new ApiError('INVALID_PARAMS', '无效库存单据类型')
    if (SPECIALIZED_DOC_TYPES.has(input.docType)) {
      throw new ApiError('INVALID_STATE', '该库存单据必须从对应的专用业务流程创建')
    }
    if (SYSTEM_DERIVED_DOC_TYPES.has(input.docType)) {
      throw new ApiError('INVALID_STATE', '该库存单据只能由收货确认或期初迁移流程生成')
    }
    if (!(INVENTORY_GENERIC_DOC_TYPES as readonly string[]).includes(input.docType)) {
      throw new ApiError('INVALID_STATE', '该库存单据不支持通用建单')
    }
    const status = defaultStatusForDoc(input.docType)
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ApiError('INVALID_PARAMS', '库存单据至少需要一条明细')
    }
    const allowPriceInput = canViewPrice(session)
    const sourceLocationId = normalizeText(input.sourceLocationId)
    const targetLocationId = normalizeText(input.targetLocationId)
    if (RECEIVE_REQUIRED_DOC_TYPES.has(input.docType) && !targetLocationId) {
      throw new ApiError('INVALID_PARAMS', '待收货单据缺少接收主体')
    }
    const actingLocationId = actingLocationIdForDoc(input)
    if (!actingLocationId) throw new ApiError('INVALID_PARAMS', '缺少当前操作库存主体')
    await ensureLocationExists(actingLocationId)
    if (sourceLocationId) await ensureLocationExists(sourceLocationId)
    if (targetLocationId) await ensureLocationExists(targetLocationId)
    await assertLocationVisible(session, actingLocationId)

    const plan = movementPlan(input.docType, status)
    if (plan?.locationRole === 'source' && !sourceLocationId) {
      throw new ApiError('INVALID_PARAMS', '出库类单据缺少出库主体')
    }
    if (plan?.locationRole === 'target' && !targetLocationId) {
      throw new ApiError('INVALID_PARAMS', '入库类单据缺少入库主体')
    }
    await assertGenericDocLocationRules(input, sourceLocationId, targetLocationId, actingLocationId)

    const totalQuantity = input.items.reduce((sum, item) => sum + assertPositiveQuantity(item.quantity), 0)
    const totalAmount = allowPriceInput
      ? input.totalAmount ??
        input.items.reduce((sum, item) => {
          const qty = Number(item.quantity || 0)
          const amount = item.amount ?? (item.actualUnitPrice == null ? null : item.actualUnitPrice * qty)
          return sum + Number(amount ?? 0)
        }, 0)
      : null

    const id = await db.transaction(async (tx) => {
      const docId = await generateDocNo(tx, input.docType)
      await tx.insert(inventoryDocs).values({
        id: docId,
        docType: input.docType,
        status,
        sourceLocationId,
        targetLocationId,
        marketId: normalizeText(input.marketId),
        supplierId: normalizeText(input.supplierId),
        docDate: normalizeText(input.docDate) ?? shanghaiToday(),
        relatedDocId: normalizeText(input.relatedDocId),
        requestDocId: normalizeText(input.requestDocId),
        relatedSaleOrderId: normalizeText(input.relatedSaleOrderId),
        clientUserId: normalizeText(input.clientUserId),
        customerName: normalizeText(input.customerName),
        employeeId: normalizeText(input.employeeId),
        employeeName: normalizeText(input.employeeName),
        supplierName: normalizeText(input.supplierName),
        externalPartyName: normalizeText(input.externalPartyName),
        logisticsCompany: normalizeText(input.logisticsCompany),
        trackingNo: normalizeText(input.trackingNo),
        receiptAttachmentUrl: normalizeText(input.receiptAttachmentUrl),
        totalQuantity: String(totalQuantity),
        totalAmount: numString(totalAmount),
        remark: normalizeText(input.remark),
        createdBy: session.employeeId,
        confirmedBy: status === '已完成' || status === '待收货' ? session.employeeId : null,
        confirmedAt: status === '已完成' || status === '待收货' ? new Date() : null,
      })

      for (const item of input.items) {
        const quantity = assertPositiveQuantity(item.quantity)
        const pricedItem = allowPriceInput ? item : stripPriceInput(item)
        let lot: LockedLot | null = null
        let snapshot: Pick<LockedLot, 'skuId' | 'skuName' | 'specName' | 'supplier' | 'productSeries'> & Partial<LockedLot>
        const shouldCaptureSourceLot =
          plan?.locationRole === 'source' ||
          (status === '待审批' && OUTBOUND_DOC_TYPES.has(input.docType))

        if (shouldCaptureSourceLot) {
          if (!pricedItem.lotId) throw new ApiError('INVALID_PARAMS', '出库类明细必须选择库存批次')
          lot = await lockLotById(tx, pricedItem.lotId, sourceLocationId)
          await assertSkuIdAvailableAtLocation(tx, lot.skuId, sourceLocationId!)
          if (input.docType === '市场间调货出库' && targetLocationId) {
            await assertSkuIdAvailableAtLocation(tx, lot.skuId, targetLocationId)
          }
          snapshot = lot
        } else if (plan?.locationRole === 'target') {
          lot = await ensureLotFromSku(tx, targetLocationId!, pricedItem, docId)
          snapshot = lot
        } else {
          const skuId = normalizeRequired(pricedItem.skuId, '库存 SKU')
          await assertSkuIdAvailableAtLocation(tx, skuId, actingLocationId)
          snapshot = await skuSnapshot(tx, skuId)
        }

        const standardUnitPrice =
          pricedItem.standardUnitPrice ??
          pricedItem.marketStandardUnitPrice ??
          pricedItem.storeStandardUnitPrice ??
          lot?.storeStandardUnitPrice ??
          null
        const unitDiscount =
          pricedItem.unitDiscount ??
          pricedItem.marketUnitDiscount ??
          pricedItem.storeUnitDiscount ??
          lot?.storeUnitDiscount ??
          null
        const actualUnitPrice =
          pricedItem.actualUnitPrice ??
          pricedItem.marketActualUnitPrice ??
          pricedItem.storeActualUnitPrice ??
          lot?.storeActualUnitPrice ??
          (standardUnitPrice == null ? null : standardUnitPrice - Number(unitDiscount ?? 0))
        const amount = pricedItem.amount ?? (actualUnitPrice == null ? null : actualUnitPrice * quantity)
        const [createdItem] = await tx
          .insert(inventoryDocItems)
          .values({
            docId,
            lotId: lot?.id ?? null,
            skuId: snapshot.skuId,
            saleItemId: normalizeText(pricedItem.saleItemId),
            skuName: snapshot.skuName,
            specName: snapshot.specName,
            supplier: snapshot.supplier,
            productSeries: snapshot.productSeries,
            batchNo: lot?.batchNo ?? normalizeText(pricedItem.batchNo) ?? '',
            expiryDate: lot?.expiryDate ?? normalizeText(pricedItem.expiryDate),
            isGift: lot?.isGift ?? Boolean(pricedItem.isGift),
            quantity: String(quantity),
            stockSnapshot: lot ? String(lot.quantityOnHand) : null,
            requestQuantity: numString(pricedItem.requestQuantity),
            fulfilledQuantity: numString(pricedItem.fulfilledQuantity),
            standardUnitPrice: numString(standardUnitPrice),
            unitDiscount: numString(unitDiscount),
            actualUnitPrice: numString(actualUnitPrice),
            amount: numString(amount),
            supplyChainUnitCost: numString(pricedItem.supplyChainUnitCost ?? lot?.supplyChainUnitCost ?? null),
            marketStandardUnitPrice: numString(pricedItem.marketStandardUnitPrice ?? lot?.marketStandardUnitPrice ?? null),
            marketUnitDiscount: numString(pricedItem.marketUnitDiscount ?? lot?.marketUnitDiscount ?? null),
            marketActualUnitPrice: numString(pricedItem.marketActualUnitPrice ?? lot?.marketActualUnitPrice ?? null),
            storeStandardUnitPrice: numString(pricedItem.storeStandardUnitPrice ?? lot?.storeStandardUnitPrice ?? null),
            storeUnitDiscount: numString(pricedItem.storeUnitDiscount ?? lot?.storeUnitDiscount ?? null),
            storeActualUnitPrice: numString(pricedItem.storeActualUnitPrice ?? lot?.storeActualUnitPrice ?? null),
            reason: normalizeText(pricedItem.reason),
            remark: normalizeText(pricedItem.remark),
          })
          .returning({ id: inventoryDocItems.id })

        if (plan && lot) {
          await applyMovement(tx, {
            lot,
            docId,
            docItemId: createdItem.id,
            direction: plan.direction,
            quantity,
            createdBy: session.employeeId,
            movementKey: `doc:${docId}:item:${createdItem.id}:${plan.direction}`,
            remark: input.remark,
          })
        }
      }

      return docId
    })

    await logOperation(session, 'create', 'inventory_docs', id, {
      docType: input.docType,
      sourceLocationId,
      targetLocationId,
      totalQuantity,
    })
    revalidatePath('/inventory')
    revalidatePath('/inventory/docs')
    revalidatePath('/inventory/stocks')
    return { success: true, id }
  },
)

export const approveInventoryCoreDoc = withPermission(
  'inventory:approve',
  async (session, id: string, auditRemark?: string | null): Promise<{ success: true }> => {
    const docId = normalizeRequired(id, '单据号')
    await db.transaction(async (tx) => {
      const headRows = await tx.execute(sql`
        SELECT id, doc_type, status, source_location_id
          FROM inventory_docs
         WHERE id = ${docId}
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_location_id: string | null
      }>)[0]
      if (!head) throw new ApiError('NOT_FOUND', '库存单据不存在')
      assertGenericDocTransition(head.doc_type)
      if (head.status !== '待审批') throw new ApiError('INVALID_STATE', '只有待审批单据可以审批')
      if (!OUTBOUND_DOC_TYPES.has(head.doc_type)) {
        throw new ApiError('INVALID_STATE', '该单据类型不需要审批扣减库存')
      }
      if (!head.source_location_id) throw new ApiError('INVALID_STATE', '审批单据缺少出库主体')
      await assertLocationVisible(session, head.source_location_id)

      const items = await tx.execute(sql`
        SELECT id, lot_id, quantity
          FROM inventory_doc_items
         WHERE doc_id = ${docId}
         ORDER BY id
      `)
      for (const item of items as unknown as Array<{ id: number; lot_id: number | null; quantity: string | number }>) {
        if (!item.lot_id) throw new ApiError('INVALID_STATE', '单据明细缺少库存批次')
        const lot = await lockLotById(tx, Number(item.lot_id), head.source_location_id)
        await applyMovement(tx, {
          lot,
          docId,
          docItemId: Number(item.id),
          direction: '出库',
          quantity: Number(item.quantity),
          createdBy: session.employeeId,
          movementKey: `approve:${docId}:item:${item.id}`,
          remark: auditRemark,
        })
      }
      await tx
        .update(inventoryDocs)
        .set({
          status: '已完成',
          approvedBy: session.employeeId,
          approvedAt: new Date(),
          auditRemark: normalizeText(auditRemark),
          updatedAt: new Date(),
        })
        .where(eq(inventoryDocs.id, docId))
    })
    await logOperation(session, 'approve', 'inventory_docs', docId, { auditRemark })
    revalidatePath('/inventory/docs')
    revalidatePath('/inventory/stocks')
    return { success: true }
  },
)

export const rejectInventoryCoreDoc = withPermission(
  'inventory:approve',
  async (session, id: string, auditRemark?: string | null): Promise<{ success: true }> => {
    const docId = normalizeRequired(id, '单据号')
    await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT doc_type, status, source_location_id, target_location_id
          FROM inventory_docs
         WHERE id = ${docId}
         FOR UPDATE
      `)
      const doc = (rows as unknown as Array<{
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_location_id: string | null
        target_location_id: string | null
      }>)[0]
      if (!doc) throw new ApiError('NOT_FOUND', '库存单据不存在')
      assertGenericDocTransition(doc.doc_type)
      if (doc.status !== '待审批') throw new ApiError('INVALID_STATE', '只有待审批单据可以驳回')
      await assertLocationVisible(session, doc.source_location_id ?? doc.target_location_id ?? '')

      const updated = await tx.execute(sql`
        UPDATE inventory_docs
           SET status = '已驳回',
               rejected_by = ${session.employeeId},
               rejected_at = NOW(),
               audit_remark = ${normalizeText(auditRemark)},
               updated_at = NOW()
         WHERE id = ${docId}
           AND status = '待审批'
        RETURNING id
      `)
      if ((updated as unknown as Array<{ id: string }>).length === 0) {
        throw new ApiError('CONFLICT', '单据状态已被其他操作修改')
      }
    })
    await logOperation(session, 'reject', 'inventory_docs', docId, { auditRemark })
    revalidatePath('/inventory/docs')
    return { success: true }
  },
)

export const confirmInventoryCoreReceive = withPermission(
  'inventory:create_doc',
  async (session, outboundDocId: string, remark?: string | null): Promise<{ success: true; inboundDocId: string }> => {
    const id = normalizeRequired(outboundDocId, '出库单号')
    let inboundDocId = ''
    await db.transaction(async (tx) => {
      const headRows = await tx.execute(sql`
        SELECT id, doc_type, status, source_location_id, target_location_id,
               total_quantity, request_doc_id, remark
          FROM inventory_docs
         WHERE id = ${id}
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_location_id: string | null
        target_location_id: string | null
        total_quantity: string | number
        request_doc_id: string | null
        remark: string | null
      }>)[0]
      if (!head) throw new ApiError('NOT_FOUND', '出库单不存在')
      assertGenericDocTransition(head.doc_type)
      if (head.status !== '待收货') throw new ApiError('INVALID_STATE', '该单据不是待收货状态')
      const inboundType = RECEIVE_INBOUND_TYPE[head.doc_type]
      if (!inboundType) throw new ApiError('INVALID_STATE', '该单据类型不支持收货确认')
      if (!head.target_location_id) throw new ApiError('INVALID_STATE', '出库单缺少收货主体')
      if (head.doc_type === '分院调货出库') {
        await assertSameMarketForStoreTransfer(head.source_location_id, head.target_location_id)
      } else if (head.doc_type === '市场间调货出库') {
        await assertMarketTransferLocations(head.source_location_id, head.target_location_id)
      }
      await assertLocationVisible(session, head.target_location_id)

      inboundDocId = await generateDocNo(tx, inboundType)
      await tx.insert(inventoryDocs).values({
        id: inboundDocId,
        docType: inboundType,
        status: '已完成',
        sourceLocationId: head.source_location_id,
        targetLocationId: head.target_location_id,
        docDate: shanghaiToday(),
        relatedDocId: id,
        requestDocId: head.request_doc_id,
        totalQuantity: String(head.total_quantity),
        remark: normalizeText(remark) ?? head.remark,
        createdBy: session.employeeId,
        confirmedBy: session.employeeId,
        confirmedAt: new Date(),
      })

      const itemRows = await tx.execute(sql`
        SELECT sku_id, batch_no, expiry_date, is_gift, quantity,
               standard_unit_price, unit_discount, actual_unit_price, amount,
               supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
               market_actual_unit_price, store_standard_unit_price, store_unit_discount,
               store_actual_unit_price, reason, remark
          FROM inventory_doc_items
         WHERE doc_id = ${id}
         ORDER BY id
      `)
      for (const item of itemRows as unknown as Array<{
        sku_id: string
        batch_no: string | null
        expiry_date: string | null
        is_gift: boolean
        quantity: string | number
        standard_unit_price: string | number | null
        unit_discount: string | number | null
        actual_unit_price: string | number | null
        amount: string | number | null
        supply_chain_unit_cost: string | number | null
        market_standard_unit_price: string | number | null
        market_unit_discount: string | number | null
        market_actual_unit_price: string | number | null
        store_standard_unit_price: string | number | null
        store_unit_discount: string | number | null
        store_actual_unit_price: string | number | null
        reason: string | null
        remark: string | null
      }>) {
        const lot = await ensureLotFromSku(tx, head.target_location_id, {
          skuId: item.sku_id,
          batchNo: item.batch_no,
          expiryDate: item.expiry_date,
          isGift: item.is_gift,
          quantity: Number(item.quantity),
          standardUnitPrice: numberOrNull(item.standard_unit_price),
          unitDiscount: numberOrNull(item.unit_discount),
          actualUnitPrice: numberOrNull(item.actual_unit_price),
          amount: numberOrNull(item.amount),
          supplyChainUnitCost: numberOrNull(item.supply_chain_unit_cost),
          marketStandardUnitPrice: numberOrNull(item.market_standard_unit_price),
          marketUnitDiscount: numberOrNull(item.market_unit_discount),
          marketActualUnitPrice: numberOrNull(item.market_actual_unit_price),
          storeStandardUnitPrice: numberOrNull(item.store_standard_unit_price),
          storeUnitDiscount: numberOrNull(item.store_unit_discount),
          storeActualUnitPrice: numberOrNull(item.store_actual_unit_price),
          reason: item.reason,
          remark: item.remark,
        }, inboundDocId)
        const [createdItem] = await tx
          .insert(inventoryDocItems)
          .values({
            docId: inboundDocId,
            lotId: lot.id,
            skuId: lot.skuId,
            skuName: lot.skuName,
            specName: lot.specName,
            supplier: lot.supplier,
            productSeries: lot.productSeries,
            batchNo: lot.batchNo,
            expiryDate: lot.expiryDate,
            isGift: lot.isGift,
            quantity: String(item.quantity),
            stockSnapshot: String(lot.quantityOnHand),
            standardUnitPrice: item.standard_unit_price == null ? null : String(item.standard_unit_price),
            unitDiscount: item.unit_discount == null ? null : String(item.unit_discount),
            actualUnitPrice: item.actual_unit_price == null ? null : String(item.actual_unit_price),
            amount: item.amount == null ? null : String(item.amount),
            supplyChainUnitCost: item.supply_chain_unit_cost == null ? null : String(item.supply_chain_unit_cost),
            marketStandardUnitPrice: item.market_standard_unit_price == null ? null : String(item.market_standard_unit_price),
            marketUnitDiscount: item.market_unit_discount == null ? null : String(item.market_unit_discount),
            marketActualUnitPrice: item.market_actual_unit_price == null ? null : String(item.market_actual_unit_price),
            storeStandardUnitPrice: item.store_standard_unit_price == null ? null : String(item.store_standard_unit_price),
            storeUnitDiscount: item.store_unit_discount == null ? null : String(item.store_unit_discount),
            storeActualUnitPrice: item.store_actual_unit_price == null ? null : String(item.store_actual_unit_price),
            reason: item.reason,
            remark: item.remark,
          })
          .returning({ id: inventoryDocItems.id })
        await applyMovement(tx, {
          lot,
          docId: inboundDocId,
          docItemId: createdItem.id,
          direction: '入库',
          quantity: Number(item.quantity),
          createdBy: session.employeeId,
          movementKey: `receive:${id}:item:${createdItem.id}`,
          remark,
        })
      }

      await tx
        .update(inventoryDocs)
        .set({
          status: '已完成',
          confirmedBy: session.employeeId,
          confirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(inventoryDocs.id, id))
    })
    await logOperation(session, 'confirm_receive', 'inventory_docs', id, { inboundDocId })
    revalidatePath('/inventory/docs')
    revalidatePath('/inventory/stocks')
    return { success: true, inboundDocId }
  },
)

function supplierRow(row: typeof inventorySuppliers.$inferSelect): InventorySupplierRow {
  return {
    supplierId: row.supplierId,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    address: row.address,
    isActive: row.isActive,
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const listInventorySuppliers = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: { keyword?: string; onlyActive?: boolean } = {},
  ): Promise<InventorySupplierRow[]> => {
    const conditions: (SQL | undefined)[] = []
    if (filters.onlyActive ?? true) conditions.push(eq(inventorySuppliers.isActive, true))
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(or(
        ilike(inventorySuppliers.name, pattern),
        ilike(inventorySuppliers.contactName, pattern),
        ilike(inventorySuppliers.phone, pattern),
      ))
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
    const rows = await db
      .select()
      .from(inventorySuppliers)
      .where(whereClause)
      .orderBy(asc(inventorySuppliers.name))
    return rows.map(supplierRow)
  },
)

export const createInventorySupplier = withPermission(
  'inventory:create',
  async (session, input: InventorySupplierInput): Promise<{ supplierId: string }> => {
    const supplierId = normalizeText(input.supplierId) ?? `INV-SUP-${crypto.randomUUID()}`
    const name = normalizeRequired(input.name, '供应商名称')
    await db.insert(inventorySuppliers).values({
      supplierId,
      name,
      contactName: normalizeText(input.contactName),
      phone: normalizeText(input.phone),
      address: normalizeText(input.address),
      isActive: input.isActive ?? true,
      remark: normalizeText(input.remark),
    })
    await logOperation(session, 'inventory.supplier.create', 'inventory_suppliers', supplierId, { name })
    revalidatePath('/inventory/suppliers')
    return { supplierId }
  },
)

export const updateInventorySupplier = withPermission(
  'inventory:update',
  async (
    session,
    supplierIdInput: string,
    input: Partial<InventorySupplierInput>,
  ): Promise<{ success: true }> => {
    const supplierId = normalizeRequired(supplierIdInput, '供应商')
    const [current] = await db
      .select({ supplierId: inventorySuppliers.supplierId })
      .from(inventorySuppliers)
      .where(eq(inventorySuppliers.supplierId, supplierId))
      .limit(1)
    if (!current) throw new ApiError('NOT_FOUND', '供应商不存在')
    if (input.name !== undefined) normalizeRequired(input.name, '供应商名称')
    await db
      .update(inventorySuppliers)
      .set({
        name: input.name === undefined ? undefined : normalizeRequired(input.name, '供应商名称'),
        contactName: input.contactName === undefined ? undefined : normalizeText(input.contactName),
        phone: input.phone === undefined ? undefined : normalizeText(input.phone),
        address: input.address === undefined ? undefined : normalizeText(input.address),
        isActive: input.isActive,
        remark: input.remark === undefined ? undefined : normalizeText(input.remark),
        updatedAt: new Date(),
      })
      .where(eq(inventorySuppliers.supplierId, supplierId))
    await logOperation(session, 'inventory.supplier.update', 'inventory_suppliers', supplierId, input)
    revalidatePath('/inventory/suppliers')
    return { success: true }
  },
)

async function assertPromotionMarketScope(
  session: AuthSession,
  marketId: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeText(marketId)
  if (!normalized) {
    if (!isAdminScope(session) && !session.roles.some((role) => role.scopeType === '总部')) {
      throw new ApiError('PERMISSION_DENIED', '市场用户只能维护本市场的福利方案')
    }
    return null
  }
  await syncInventoryLocations()
  const [location] = await db
    .select({ locationType: inventoryLocations.locationType })
    .from(inventoryLocations)
    .where(eq(inventoryLocations.locationId, normalized))
    .limit(1)
  if (!location || location.locationType !== '市场') {
    throw new ApiError('INVALID_PARAMS', '福利方案所属主体必须是市场')
  }
  await assertLocationVisible(session, normalized)
  return normalized
}

async function assertPromotionPlanMutableScope(
  session: AuthSession,
  scopeMarketId: string | null,
): Promise<void> {
  if (scopeMarketId === null) {
    if (isAdminScope(session) || session.roles.some((role) => role.scopeType === '总部')) return
    throw new ApiError('PERMISSION_DENIED', '市场用户不能修改或停用全局福利方案')
  }
  await assertLocationVisible(session, scopeMarketId)
}

async function lockPromotionPlanScopeForMutation(tx: Tx, id: string): Promise<string | null> {
  const rows = await tx.execute(sql`
    SELECT scope_market_id
      FROM inventory_promotion_plans
     WHERE id = ${id}
     FOR UPDATE
  `)
  const row = (rows as unknown as Array<{ scope_market_id: string | null }>)[0]
  if (!row) throw new ApiError('NOT_FOUND', '福利方案不存在或无权查看')
  return row.scope_market_id ?? null
}

function normalizePromotionItems(
  items: InventoryPromotionPlanItemInput[],
): Array<{
  skuId: string
  marketUnitDiscount: number
  reportMinQuantity: number | null
  reportMaxQuantity: number | null
  remark: string | null
}> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('INVALID_PARAMS', '福利方案至少需要一条产品明细')
  }
  const normalized = items.map((item) => {
    const skuId = normalizeRequired(item.skuId, '福利产品')
    const marketUnitDiscount = Number(item.marketUnitDiscount)
    const legacyBasePrice = (item as { marketBasePrice?: unknown }).marketBasePrice
    const reportMinQuantity = item.reportMinQuantity == null ? null : Number(item.reportMinQuantity)
    const reportMaxQuantity = item.reportMaxQuantity == null ? null : Number(item.reportMaxQuantity)
    if (!Number.isFinite(marketUnitDiscount) || marketUnitDiscount < 0) {
      throw new ApiError('INVALID_PARAMS', '单价优惠必须是非负数字')
    }
    if (legacyBasePrice !== undefined && legacyBasePrice !== null) {
      throw new ApiError('INVALID_PARAMS', '福利方案只允许设置单价优惠，市场基础价取商品资料')
    }
    if (reportMinQuantity !== null && (!Number.isFinite(reportMinQuantity) || reportMinQuantity <= 0)) {
      throw new ApiError('INVALID_PARAMS', '数量下限必须大于 0')
    }
    if (reportMaxQuantity !== null && (!Number.isFinite(reportMaxQuantity) || reportMaxQuantity <= 0)) {
      throw new ApiError('INVALID_PARAMS', '数量上限必须大于 0')
    }
    if (reportMinQuantity !== null && reportMaxQuantity !== null && reportMaxQuantity < reportMinQuantity) {
      throw new ApiError('INVALID_PARAMS', '数量上限不能小于数量下限')
    }
    return {
      skuId,
      marketUnitDiscount,
      reportMinQuantity,
      reportMaxQuantity,
      remark: normalizeText(item.remark),
    }
  })

  // 同一产品的数量区间必须互斥，避免市场报货时出现两条同优先级的取价规则。
  for (let index = 0; index < normalized.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < normalized.length; otherIndex += 1) {
      const left = normalized[index]
      const right = normalized[otherIndex]
      if (left.skuId !== right.skuId) continue
      const leftMin = left.reportMinQuantity ?? 0
      const leftMax = left.reportMaxQuantity ?? Number.POSITIVE_INFINITY
      const rightMin = right.reportMinQuantity ?? 0
      const rightMax = right.reportMaxQuantity ?? Number.POSITIVE_INFINITY
      if (leftMin <= rightMax && rightMin <= leftMax) {
        throw new ApiError('INVALID_PARAMS', '同一产品的福利数量区间不能重叠')
      }
    }
  }
  return normalized
}

async function assertPromotionSkus(
  items: Array<{ skuId: string; marketUnitDiscount: number }>,
): Promise<void> {
  const skuIds = Array.from(new Set(items.map((item) => item.skuId)))
  const rows = await db
    .select({ skuId: inventorySkus.skuId, productName: inventorySkus.productName, marketPurchasePrice: inventorySkus.marketPurchasePrice })
    .from(inventorySkus)
    .where(and(inArray(inventorySkus.skuId, skuIds), eq(inventorySkus.isActive, true)))
  if (rows.length !== skuIds.length) {
    throw new ApiError('NOT_FOUND', '福利方案包含不存在或已停用的库存 SKU')
  }
  const skuById = new Map(rows.map((row) => [row.skuId, row]))
  for (const item of items) {
    const sku = skuById.get(item.skuId)
    const marketPurchasePrice = numberOrNull(sku?.marketPurchasePrice)
    if (marketPurchasePrice === null) {
      throw new ApiError('INVALID_STATE', `SKU ${sku?.productName ?? item.skuId} 未设置市场进货价，不能配置报货福利`)
    }
    if (item.marketUnitDiscount > marketPurchasePrice) {
      throw new ApiError('INVALID_PARAMS', `SKU ${sku?.productName ?? item.skuId} 的单价优惠不能高于市场进货价`)
    }
  }
}

function promotionItemRow(row: {
  id: number
  skuId: string
  skuName: string
  marketUnitDiscount: string | number | null
  reportMinQuantity: string | number | null
  reportMaxQuantity: string | number | null
  remark: string | null
}): InventoryPromotionPlanRow['items'][number] {
  return {
    id: row.id,
    skuId: row.skuId,
    skuName: row.skuName,
    marketUnitDiscount: Number(row.marketUnitDiscount ?? 0),
    reportMinQuantity: numberOrNull(row.reportMinQuantity),
    reportMaxQuantity: numberOrNull(row.reportMaxQuantity),
    remark: row.remark,
  }
}

async function promotionPlanRows(
  session: AuthSession,
  onlyId?: string,
): Promise<InventoryPromotionPlanRow[]> {
  const priceVisible = canViewPrice(session)
  const scoped = await scopedLocationIds(session)
  const conditions: (SQL | undefined)[] = []
  if (onlyId) conditions.push(eq(inventoryPromotionPlans.id, onlyId))
  if (scoped !== null) {
    conditions.push(scoped.length > 0
      ? or(isNull(inventoryPromotionPlans.scopeMarketId), inArray(inventoryPromotionPlans.scopeMarketId, scoped))
      : isNull(inventoryPromotionPlans.scopeMarketId))
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined
  const plans = await db
    .select({
      id: inventoryPromotionPlans.id,
      planNo: inventoryPromotionPlans.planNo,
      name: inventoryPromotionPlans.name,
      startsAt: inventoryPromotionPlans.startsAt,
      endsAt: inventoryPromotionPlans.endsAt,
      scopeMarketId: inventoryPromotionPlans.scopeMarketId,
      scopeMarketName: orgNodes.name,
      status: inventoryPromotionPlans.status,
      remark: inventoryPromotionPlans.remark,
      createdAt: inventoryPromotionPlans.createdAt,
      updatedAt: inventoryPromotionPlans.updatedAt,
    })
    .from(inventoryPromotionPlans)
    .leftJoin(orgNodes, eq(inventoryPromotionPlans.scopeMarketId, orgNodes.id))
    .where(whereClause)
    .orderBy(desc(inventoryPromotionPlans.startsAt), asc(inventoryPromotionPlans.planNo))
  if (plans.length === 0) return []
  const items = await db
    .select({
      id: inventoryPromotionPlanItems.id,
      planId: inventoryPromotionPlanItems.planId,
      skuId: inventoryPromotionPlanItems.skuId,
      skuName: inventorySkus.productName,
      marketUnitDiscount: inventoryPromotionPlanItems.marketUnitDiscount,
      reportMinQuantity: inventoryPromotionPlanItems.reportMinQuantity,
      reportMaxQuantity: inventoryPromotionPlanItems.reportMaxQuantity,
      remark: inventoryPromotionPlanItems.remark,
    })
    .from(inventoryPromotionPlanItems)
    .innerJoin(inventorySkus, eq(inventoryPromotionPlanItems.skuId, inventorySkus.skuId))
    .where(inArray(inventoryPromotionPlanItems.planId, plans.map((plan) => plan.id)))
    .orderBy(asc(inventoryPromotionPlanItems.skuId), asc(inventoryPromotionPlanItems.reportMinQuantity))
  const itemsByPlan = new Map<string, InventoryPromotionPlanRow['items']>()
  for (const item of items) {
    const collection = itemsByPlan.get(item.planId) ?? []
    collection.push(promotionItemRow(item))
    itemsByPlan.set(item.planId, collection)
  }
  return plans.map((plan) => ({
    id: plan.id,
    planNo: plan.planNo,
    name: plan.name,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    scopeMarketId: plan.scopeMarketId,
    scopeMarketName: plan.scopeMarketName,
    status: plan.status as '启用' | '停用',
    remark: plan.remark,
    items: (itemsByPlan.get(plan.id) ?? []).map((item) => priceVisible
      ? item
      : { ...item, marketUnitDiscount: 0 }),
    itemCount: (itemsByPlan.get(plan.id) ?? []).length,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  }))
}

export const listInventoryPromotionPlans = withPermission(
  'inventory:stock_list',
  async (session): Promise<InventoryPromotionPlanRow[]> => promotionPlanRows(session),
)

export const getInventoryPromotionPlanById = withPermission(
  'inventory:stock_list',
  async (session, idInput: string): Promise<InventoryPromotionPlanRow | null> => {
    const id = normalizeRequired(idInput, '福利方案')
    return (await promotionPlanRows(session, id))[0] ?? null
  },
)

export const createInventoryPromotionPlan = withPermission(
  'inventory:create',
  async (session, input: InventoryPromotionPlanInput): Promise<{ id: string }> => {
    const planNo = normalizeRequired(input.planNo, '方案编号')
    const name = normalizeRequired(input.name, '方案名称')
    const startsAt = normalizeYmd(input.startsAt, '开始日期')
    const endsAt = normalizeYmd(input.endsAt, '结束日期')
    if (endsAt < startsAt) throw new ApiError('INVALID_PARAMS', '结束日期不能早于开始日期')
    if (input.status && input.status !== '启用' && input.status !== '停用') {
      throw new ApiError('INVALID_PARAMS', '福利方案状态无效')
    }
    const scopeMarketId = await assertPromotionMarketScope(session, input.scopeMarketId)
    const items = normalizePromotionItems(input.items)
    await assertPromotionSkus(items)
    const id = `INV-PROMO-${crypto.randomUUID()}`
    await db.transaction(async (tx) => {
      await tx.insert(inventoryPromotionPlans).values({
        id,
        planNo,
        name,
        startsAt,
        endsAt,
        scopeMarketId,
        status: input.status ?? '启用',
        remark: normalizeText(input.remark),
        createdBy: session.employeeId,
      })
      await tx.insert(inventoryPromotionPlanItems).values(items.map((item) => ({
        planId: id,
        skuId: item.skuId,
        marketBasePrice: null,
        marketUnitDiscount: numString(item.marketUnitDiscount),
        marketActualPrice: null,
        reportMinQuantity: numString(item.reportMinQuantity),
        reportMaxQuantity: numString(item.reportMaxQuantity),
        isTiered: item.reportMinQuantity !== null || item.reportMaxQuantity !== null,
        remark: item.remark,
      })))
    })
    await logOperation(session, 'inventory.promotion.create', 'inventory_promotion_plans', id, { planNo, scopeMarketId })
    revalidatePath('/inventory/promotions')
    return { id }
  },
)

export const updateInventoryPromotionPlan = withPermission(
  'inventory:update',
  async (
    session,
    idInput: string,
    input: InventoryPromotionPlanInput,
  ): Promise<{ success: true }> => {
    const id = normalizeRequired(idInput, '福利方案')
    const planNo = normalizeRequired(input.planNo, '方案编号')
    const name = normalizeRequired(input.name, '方案名称')
    const startsAt = normalizeYmd(input.startsAt, '开始日期')
    const endsAt = normalizeYmd(input.endsAt, '结束日期')
    if (endsAt < startsAt) throw new ApiError('INVALID_PARAMS', '结束日期不能早于开始日期')
    if (input.status && input.status !== '启用' && input.status !== '停用') {
      throw new ApiError('INVALID_PARAMS', '福利方案状态无效')
    }
    const current = (await promotionPlanRows(session, id))[0]
    if (!current) throw new ApiError('NOT_FOUND', '福利方案不存在或无权查看')
    const scopeMarketId = await assertPromotionMarketScope(session, input.scopeMarketId)
    const items = normalizePromotionItems(input.items)
    await db.transaction(async (tx) => {
      const currentScopeMarketId = await lockPromotionPlanScopeForMutation(tx, id)
      await assertPromotionPlanMutableScope(session, currentScopeMarketId)
      await assertPromotionSkus(items)
      await tx
        .update(inventoryPromotionPlans)
        .set({
          planNo,
          name,
          startsAt,
          endsAt,
          scopeMarketId,
          status: input.status ?? '启用',
          remark: normalizeText(input.remark),
          updatedAt: new Date(),
        })
        .where(eq(inventoryPromotionPlans.id, id))
      await tx.delete(inventoryPromotionPlanItems).where(eq(inventoryPromotionPlanItems.planId, id))
      await tx.insert(inventoryPromotionPlanItems).values(items.map((item) => ({
        planId: id,
        skuId: item.skuId,
        marketBasePrice: null,
        marketUnitDiscount: numString(item.marketUnitDiscount),
        marketActualPrice: null,
        reportMinQuantity: numString(item.reportMinQuantity),
        reportMaxQuantity: numString(item.reportMaxQuantity),
        isTiered: item.reportMinQuantity !== null || item.reportMaxQuantity !== null,
        remark: item.remark,
      })))
    })
    await logOperation(session, 'inventory.promotion.update', 'inventory_promotion_plans', id, { planNo, scopeMarketId })
    revalidatePath('/inventory/promotions')
    return { success: true }
  },
)

export const disableInventoryPromotionPlan = withPermission(
  'inventory:update',
  async (session, idInput: string): Promise<{ success: true }> => {
    const id = normalizeRequired(idInput, '福利方案')
    const current = (await promotionPlanRows(session, id))[0]
    if (!current) throw new ApiError('NOT_FOUND', '福利方案不存在或无权查看')
    await db.transaction(async (tx) => {
      const currentScopeMarketId = await lockPromotionPlanScopeForMutation(tx, id)
      await assertPromotionPlanMutableScope(session, currentScopeMarketId)
      await tx
        .update(inventoryPromotionPlans)
        .set({ status: '停用', updatedAt: new Date() })
        .where(eq(inventoryPromotionPlans.id, id))
    })
    await logOperation(session, 'inventory.promotion.disable', 'inventory_promotion_plans', id)
    revalidatePath('/inventory/promotions')
    return { success: true }
  },
)
