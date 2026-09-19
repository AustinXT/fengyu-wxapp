import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode } from '@/lib/pg-error'
import { rowsAffected } from '@/lib/pg-rows'
import { fmtDate, shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import { logOperation } from '@/lib/operation-log'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { withAnyPermission, withPermission } from '@/lib/with-permission'
import {
  offsetPageResult,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import {
  inventoryDocItems,
  inventoryDocLinks,
  inventoryDocs,
  inventoryLocations,
  inventoryMovements,
  inventoryPromotionPlanItems,
  inventoryPromotionPlans,
  inventorySkuProductSkuMappings,
  inventorySkus,
  inventoryStockLots,
  inventorySuppliers,
} from '@db/inventory'
import { orgNodes, stores } from '@db/org'
import { productSkus } from '@db/product'
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { AuthSession } from '@/lib/types'
import { assertInventoryBusinessWritable } from './cutover'
// 账面数按**主体 + SKU 汇总**记录 —— 口径由甲方 2026-09-16 拍板（issue #131 Q1）：
// 现场就是按商品数总盘、不区分批次，按批次记会造成假精确。类型清单与详情页共用单源。
import { STOCKTAKE_DOC_TYPES } from './stocktake'
import {
  INVENTORY_DOC_TYPES,
  INVENTORY_GENERIC_DOC_TYPES,
  INVENTORY_SKU_SOURCE_TYPES,
  type CreateInventoryDocInput,
  type InventoryCoreDocStatus,
  type InventoryDocDetail,
  type InventoryDocFulfillmentProgress,
  type InventoryDocItemInput,
  type InventoryDocLineageRow,
  type InventoryDocRow,
  type InventoryDocType,
  type InventoryLocationRow,
  type InventoryLocationFilterOptions,
  type InventoryLocationType,
  type InventoryLotRow,
  type InventoryPromotionPlanInput,
  type InventoryPromotionPlanItemInput,
  type InventoryPromotionPlanRow,
  type InventoryPromotionRuleType,
  type InventorySkuInput,
  type InventoryCompositionInput,
  type InventoryCompositionOptions,
  type InventoryCompositionRow,
  type InventorySkuRow,
  type InventorySkuSourceType,
  type InventorySupplierInput,
  type InventorySupplierOption,
  type InventorySupplierRow,
} from './types'
import { buildInventoryLocationFilterOptions } from './location-filter'
import {
  inventoryPriceScopeByTier,
  inventoryPriceVisibility,
  inventoryPriceVisibilityForOrgNodes,
  inventoryScopedLocationIds,
  inventoryScopedOrgNodeIds,
} from './access'

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

const DOC_PREFIX: Record<InventoryDocType, string> = {
  门店报货: 'DBH',
  市场报货: 'MBH',
  市场报货汇总: 'MHZ',
  品项公司报货需求: 'ZBH',
  // `供应链采购订单`（旧前缀 PCG）已并入 `采购订单`；存量单号保留 PCG-*，新单一律 CGD-*。
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
  供应链员工购出库: 'GYG',
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

/**
 * 分页页长白名单。必须与各列表组件的 `PAGE_SIZE_OPTIONS` 一致 ——
 * 两侧不同源时，`?size=7` 会让服务端每页 7 条而 UI 按 20 条算页数，
 * 尾部数据翻到哪一页都够不到，且不会有任何报错。
 */
const PAGE_SIZE_WHITELIST = [10, 20, 50, 100]

/**
 * 页码归一化。`Math.max(1, page || 1)` 只兜得住 NaN 和 0，兜不住小数与 Infinity：
 * - `?page=1.5` → offset 变成 `(1.5-1)*20 = 10`，返回第 11–30 条，
 *   而客户端 `Pagination` 内部 `Math.floor` 后高亮的是第 1 页 ——
 *   用户看到的既不是第 1 页也不是第 2 页，且翻页时会重复/跳过行
 * - `?page=Infinity` → offset 为 Infinity，直接把 SQL 打挂
 * 客户端已经 floor + clamp（pagination.tsx:23），服务端这里做同样的兜底。
 */
const MAX_PAGE = 1_000_000

function normalizePage(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1
  // 还要夹上界：`Number.isFinite` 放行 1e308 这种**有限但巨大**的值，
  // 乘以页长之后 offset 会溢出成 Infinity，PG 直接拒绝 → 列表页 500。
  // 100 万页 × 100 条/页 = 1 亿行，远超任何业务规模，夹到这里不会误伤真实翻页。
  return Math.min(Math.max(1, Math.trunc(value as number)), MAX_PAGE)
}

const NO_MOVEMENT_DOC_TYPES = new Set<InventoryDocType>([
  '门店报货',
  '市场报货',
  '市场报货汇总',
  '品项公司报货需求',
  '采购订单',
])
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
  '供应链员工购出库',
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
  '市场报货汇总',
  '品项公司报货需求',
  '采购订单',
  '供应链采购入库',
  '品项公司发货',
  '市场采购入库',
  '自采产品入库',
  '分院配货',
  '院入库',
  '员工购出库',
  '供应链员工购出库',
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
const INTERNAL_SAME_NODE_DOC_TYPES = new Set<InventoryDocType>([
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

function calculateAmount(unitPrice: number | null, quantity: number): number | null {
  return unitPrice === null ? null : Number((unitPrice * quantity).toFixed(2))
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

function canViewPrice(session: AuthSession): boolean {
  return inventoryPriceVisibility(session) !== 'none'
}

function assertPromotionPriceWritable(session: AuthSession): void {
  if (!canViewPrice(session)) {
    throw new ApiError('PERMISSION_DENIED', '无权设置市场报货福利价格')
  }
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
  priceVisibility: import('./types').InventoryPriceVisibility,
  sourceType: InventorySkuSourceType,
  existing?: {
    accountingPrice: string | number | null
    marketPurchaseDiscount: string | number | null
    marketPurchasePrice: string | number | null
    marketPurchasePriceMode: string | null
    marketPurchasePriceOverrideReason: string | null
  },
) {
  if (priceVisibility === 'none') {
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
      marketPurchasePriceMode: undefined,
      marketPurchasePriceOverrideReason: undefined,
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
  const existingMarketPurchasePrice = numberOrNull(existing?.marketPurchasePrice)
  const marketPurchasePriceInput = input.marketPurchasePrice === undefined
    ? undefined
    : numString(input.marketPurchasePrice)
  const formulaChanged = input.accountingPrice !== undefined || input.marketPurchaseDiscount !== undefined
  let marketPurchasePrice: string | null | undefined

  if (rawAccounting !== null && (!Number.isFinite(rawAccounting) || rawAccounting < 0)) {
    throw new ApiError('INVALID_PARAMS', '核算价无效')
  }
  let calculatedMarketPurchasePrice: string | null = null
  if (rawDiscount !== null) {
    const ratio = rawDiscount > 1 ? rawDiscount / 100 : rawDiscount
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new ApiError('INVALID_PARAMS', '市场折扣无效')
    }
    if (rawAccounting !== null) {
      calculatedMarketPurchasePrice = numString(Math.round(rawAccounting * ratio * 100) / 100)
    }
  }

  const marketPurchasePriceMode = sourceType === '供应链'
    ? (input.marketPurchasePriceMode ?? existing?.marketPurchasePriceMode ?? '公式')
    : null
  if (sourceType === '供应链' && !['公式', '手工覆盖'].includes(String(marketPurchasePriceMode))) {
    throw new ApiError('INVALID_PARAMS', '市场进货价来源必须是公式或手工覆盖')
  }
  if (sourceType !== '供应链' && input.marketPurchasePriceMode != null) {
    throw new ApiError('INVALID_PARAMS', '非供应链 SKU 不使用市场公式价模式')
  }
  const overrideReason = normalizeText(
    input.marketPurchasePriceOverrideReason === undefined
      ? existing?.marketPurchasePriceOverrideReason
      : input.marketPurchasePriceOverrideReason,
  )
  if (sourceType === '供应链' && marketPurchasePriceMode === '手工覆盖') {
    const manualPrice = marketPurchasePriceInput === undefined
      ? existingMarketPurchasePrice
      : numberOrNull(marketPurchasePriceInput)
    if (manualPrice === null || !overrideReason) {
      throw new ApiError('INVALID_PARAMS', '手工覆盖市场进货价必须填写价格和原因')
    }
    marketPurchasePrice = numString(manualPrice)
  } else if (sourceType === '供应链') {
    if (overrideReason) throw new ApiError('INVALID_PARAMS', '公式价不能填写手工覆盖原因')
    marketPurchasePrice = calculatedMarketPurchasePrice
      ?? (formulaChanged ? null : existingMarketPurchasePrice == null ? undefined : numString(existingMarketPurchasePrice))
  } else if (marketPurchasePriceInput !== undefined) {
    // 手填市场进货价优先；显式传 null（清空）时回退公式完整时的派生值。
    marketPurchasePrice = marketPurchasePriceInput ?? calculatedMarketPurchasePrice
  } else if (!existing) {
    // 新建非供应链 SKU 未提交进货价时按公式初始化。
    marketPurchasePrice = calculatedMarketPurchasePrice
  } else if (existingMarketPurchasePrice === null && formulaChanged && calculatedMarketPurchasePrice !== null) {
    // 历史值为空且公式输入发生变化时补算派生值；其余情况保持 undefined，
    // 调用方不更新该列，避免编辑其他资料误覆盖 WorkFine 快照。
    marketPurchasePrice = calculatedMarketPurchasePrice
  }
  const supplyVisible = priceVisibility === 'all' || priceVisibility === 'supply_chain'
  const marketVisible = priceVisibility === 'all' || priceVisibility === 'market'
  return {
    retailPrice: priceVisibility === 'all' ? (input.retailPrice === undefined ? undefined : numString(input.retailPrice)) : undefined,
    accountingPrice: supplyVisible ? accountingPrice : undefined,
    supplyChainPurchasePrice: supplyVisible && input.supplyChainPurchasePrice !== undefined ? numString(input.supplyChainPurchasePrice) : undefined,
    marketPurchasePrice,
    storePurchasePrice: marketVisible && input.storePurchasePrice !== undefined ? numString(input.storePurchasePrice) : undefined,
    marketStaffPurchasePrice: marketVisible && input.marketStaffPurchasePrice !== undefined ? numString(input.marketStaffPurchasePrice) : undefined,
    marketPurchaseDiscount,
    storePurchaseDiscount: marketVisible && input.storePurchaseDiscount !== undefined ? numString(input.storePurchaseDiscount) : undefined,
    staffPurchaseDiscount: marketVisible && input.staffPurchaseDiscount !== undefined ? numString(input.staffPurchaseDiscount) : undefined,
    itemCompanyPurchasePrice: supplyVisible && input.itemCompanyPurchasePrice !== undefined ? numString(input.itemCompanyPurchasePrice) : undefined,
    marketPurchasePriceMode: supplyVisible ? marketPurchasePriceMode : undefined,
    marketPurchasePriceOverrideReason: supplyVisible && sourceType === '供应链' && marketPurchasePriceMode === '手工覆盖'
      ? overrideReason
      : supplyVisible ? null : undefined,
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
    supplier?: string | null
    supplierId?: string | null
    sourceDocId?: string | null
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
    `supplier:${normalizeText(item.supplierId) ?? normalizeText(item.supplier) ?? ''}`,
    `source:${normalizeText(item.sourceDocId) ?? ''}`,
  ].join('|')
}

/**
 * 热路径短路：migration 0009 的 org_nodes / stores 触发器（INSERT + 相关列 UPDATE）
 * 已实时维护 inventory_locations，本函数只是漂移自愈兜底。先跑只读反连接探测，
 * 无缺失/漂移时跳过两条全表 UPSERT（原实现每次调用都重写全部主体行 + updated_at churn）。
 * 探测无结果或结果异常时保守回退旧行为（照常 UPSERT）。
 * ⚠ 与 staff routes/inventory.js 的 syncInventoryLocations 保持字面一致（各自副本，
 * 由 cross-end-inventory-snapshot.test.js 守护）。
 */
export async function syncInventoryLocations(): Promise<void> {
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
  return inventoryScopedLocationIds(session)
}

async function assertLocationVisible(session: AuthSession, locationId: string): Promise<void> {
  const scoped = await scopedLocationIds(session)
  if (scoped === null) return
  if (!scoped.includes(locationId)) {
    throw new ApiError('PERMISSION_DENIED', '无权操作该库存主体')
  }
}

async function assertOrgNodeVisible(session: AuthSession, orgNodeId: string): Promise<void> {
  const scoped = inventoryScopedOrgNodeIds(session)
  if (scoped === null) return
  if (!scoped.includes(orgNodeId)) {
    throw new ApiError('PERMISSION_DENIED', '无权操作该组织节点单据')
  }
}

async function loadTransferLocations(
  sourceOrgNodeId: string | null | undefined,
  targetOrgNodeId: string | null | undefined,
): Promise<{
  source: { locationId: string; orgNodeId: string; locationType: string; parentLocationId: string | null }
  target: { locationId: string; orgNodeId: string; locationType: string; parentLocationId: string | null }
}> {
  if (!sourceOrgNodeId || !targetOrgNodeId) {
    throw new ApiError('INVALID_PARAMS', '调货单据缺少出入库主体')
  }
  if (sourceOrgNodeId === targetOrgNodeId) {
    throw new ApiError('INVALID_PARAMS', '调货出入库主体不能相同')
  }
  const list = await db
    .select({
      locationId: inventoryLocations.locationId,
      orgNodeId: inventoryLocations.orgNodeId,
      locationType: inventoryLocations.locationType,
      parentLocationId: inventoryLocations.parentLocationId,
    })
    .from(inventoryLocations)
    .where(inArray(inventoryLocations.orgNodeId, [sourceOrgNodeId, targetOrgNodeId]))
  if (list.length !== 2) {
    throw new ApiError('NOT_FOUND', '调货库存主体不存在')
  }
  const byId = new Map(list.map((row) => [row.orgNodeId, { ...row, orgNodeId: row.orgNodeId! }]))
  const source = byId.get(sourceOrgNodeId)
  const target = byId.get(targetOrgNodeId)
  if (!source || !target) {
    throw new ApiError('NOT_FOUND', '调货库存主体不存在')
  }
  return { source, target }
}

async function assertSameMarketForStoreTransfer(
  sourceOrgNodeId: string | null | undefined,
  targetOrgNodeId: string | null | undefined,
): Promise<void> {
  const { source, target } = await loadTransferLocations(sourceOrgNodeId, targetOrgNodeId)
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
  sourceOrgNodeId: string | null | undefined,
  targetOrgNodeId: string | null | undefined,
): Promise<void> {
  const { source, target } = await loadTransferLocations(sourceOrgNodeId, targetOrgNodeId)
  if (source.locationType !== '市场' || target.locationType !== '市场') {
    throw new ApiError('INVALID_PARAMS', '市场间调货的出入库主体必须均为市场')
  }
}

async function assertLocationType(
  orgNodeId: string,
  expectedType: InventoryLocationType,
  label: string,
): Promise<void> {
  const [location] = await db
    .select({ locationType: inventoryLocations.locationType })
    .from(inventoryLocations)
    .where(eq(inventoryLocations.orgNodeId, orgNodeId))
    .limit(1)
  if (!location) throw new ApiError('NOT_FOUND', `${label}不存在`)
  if (location.locationType !== expectedType) {
    throw new ApiError('INVALID_PARAMS', `${label}必须是${expectedType}`)
  }
}

async function assertGenericDocLocationRules(
  input: CreateInventoryDocInput,
  sourceOrgNodeId: string | null,
  targetOrgNodeId: string | null,
  actingOrgNodeId: string,
): Promise<void> {
  switch (input.docType) {
    case '供应链采购入库':
      if (!targetOrgNodeId) throw new ApiError('INVALID_PARAMS', '供应链采购入库缺少入库主体')
      await assertLocationType(targetOrgNodeId, '总部', '供应链采购入库主体')
      return
    case '分院调货出库':
      await assertSameMarketForStoreTransfer(sourceOrgNodeId, targetOrgNodeId)
      return
    case '市场间调货出库':
      await assertMarketTransferLocations(sourceOrgNodeId, targetOrgNodeId)
      return
    case '内部领用':
      if (!sourceOrgNodeId) throw new ApiError('INVALID_PARAMS', '内部领用缺少出库主体')
      await assertLocationType(sourceOrgNodeId, '总部', '内部领用出库主体')
      return
    case '院顾客产品出库':
    case '院产品报损':
      if (!sourceOrgNodeId) throw new ApiError('INVALID_PARAMS', `${input.docType}缺少出库主体`)
      await assertLocationType(sourceOrgNodeId, '门店', `${input.docType}出库主体`)
      return
    case '院顾客退货':
      if (!targetOrgNodeId) throw new ApiError('INVALID_PARAMS', '院顾客退货缺少入库主体')
      await assertLocationType(targetOrgNodeId, '门店', '院顾客退货入库主体')
      return
    case '市场产品报损':
      if (!sourceOrgNodeId) throw new ApiError('INVALID_PARAMS', '市场产品报损缺少出库主体')
      await assertLocationType(sourceOrgNodeId, '市场', '市场产品报损出库主体')
      return
    case '市场产品盘溢':
      if (!targetOrgNodeId) throw new ApiError('INVALID_PARAMS', '市场产品盘溢缺少入库主体')
      await assertLocationType(targetOrgNodeId, '市场', '市场产品盘溢入库主体')
      return
    case '市场库存盘点':
      await assertLocationType(actingOrgNodeId, '市场', '市场库存盘点主体')
      return
    case '分院库存盘点':
      await assertLocationType(actingOrgNodeId, '门店', '分院库存盘点主体')
      return
  }
}

async function ensureOrgNodeLocation(orgNodeId: string): Promise<{
  locationId: string
  orgNodeId: string
  locationType: InventoryLocationType
  parentLocationId: string | null
}> {
  await syncInventoryLocations()
  const rows = await db
    .select({
      locationId: inventoryLocations.locationId,
      orgNodeId: inventoryLocations.orgNodeId,
      locationType: inventoryLocations.locationType,
      parentLocationId: inventoryLocations.parentLocationId,
      isActive: inventoryLocations.isActive,
    })
    .from(inventoryLocations)
    .where(eq(inventoryLocations.orgNodeId, orgNodeId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new ApiError('NOT_FOUND', '组织节点没有对应库存主体')
  if (row.isActive === false) throw new ApiError('INVALID_STATE', '组织节点对应库存主体已停用')
  return {
    locationId: row.locationId ?? orgNodeId,
    orgNodeId: row.orgNodeId ?? orgNodeId,
    locationType: row.locationType as InventoryLocationType,
    parentLocationId: row.parentLocationId ?? null,
  }
}

/**
 * 事务内按组织节点取库存主体 location_id。
 * 与 ensureOrgNodeLocation 的区别：走 tx 连接（不触发 syncInventoryLocations 抢全局池
 * 第二连接，避免事务持锁期间池自锁），且单据端点列有 FK 保证行必存在，无需「无则建」。
 * FOR UPDATE 顺带锁主体行，与 approveDoc/confirm 的 doc→location 锁序一致。
 */
async function orgNodeLocationIdForUpdate(tx: Tx, orgNodeId: string): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT location_id
      FROM inventory_locations
     WHERE org_node_id = ${orgNodeId}
       AND is_active = true
     FOR UPDATE
  `)
  const row = (rows as unknown as Array<{ location_id: string }>)[0]
  if (!row) throw new ApiError('NOT_FOUND', '组织节点没有对应库存主体')
  return row.location_id
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
  if (sourceType === '供应链') {
    if (hasPermission(session, 'inventory:supply_chain_master_data_manage')) return
    throw new ApiError('PERMISSION_DENIED', '缺少供应链库存资料维护权限')
  }
  if (hasPermission(session, 'inventory:market_sku_manage')) return
  throw new ApiError('PERMISSION_DENIED', '缺少市场自采或转让店产品资料维护权限')
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

async function generateInventorySkuNo(tx: Tx): Promise<string> {
  const prefix = 'INV-SKU'
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_skus:${prefix}:${ymd}`}))`)
  const rows = await tx.execute(sql`
    SELECT product_code AS value
      FROM inventory_skus
     WHERE product_code LIKE ${`${prefix}-${ymd}-%`}
  ORDER BY product_code DESC
     LIMIT 1
  `)
  const latest = (rows as unknown as Array<{ value: string }>)[0]?.value
  const seq = latest ? Number(latest.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function generateInventoryPromotionNo(tx: Tx): Promise<string> {
  const prefix = 'PROMO'
  const ymd = shanghaiYmd()
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory_promotion_plans:${prefix}:${ymd}`}))`)
  const rows = await tx.execute(sql`
    SELECT plan_no AS value
      FROM inventory_promotion_plans
     WHERE plan_no LIKE ${`${prefix}-${ymd}-%`}
  ORDER BY plan_no DESC
     LIMIT 1
  `)
  const latest = (rows as unknown as Array<{ value: string }>)[0]?.value
  const seq = latest ? Number(latest.slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function lockLotById(
  tx: Tx,
  lotId: number,
  locationId?: string | null,
): Promise<LockedLot> {
  const rows = await tx.execute(sql`
    SELECT id, location_id, sku_id, sku_name, spec_name, supplier, supplier_id, product_series,
           batch_no, expiry_date, is_gift, quantity_on_hand,
           supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
           market_actual_unit_price, store_standard_unit_price, store_unit_discount,
           store_actual_unit_price, source_doc_id
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
    supplier_id: string | null
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
    source_doc_id: string | null
  }>)[0]
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
    sourceDocId: row.source_doc_id,
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
  trace: {
    sourceDocId: string
    supplierId?: string | null
    supplier?: string | null
  },
): Promise<LockedLot> {
  const skuId = normalizeRequired(item.skuId, '库存 SKU')
  const skuRows = await tx.execute(sql`
    SELECT sku_id, product_name, spec_name, supplier, supplier_id, product_series,
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
    supplier_id: string | null
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
  // 批次键锚在 supplier_id 而不是名称（#132）：makeLotKey 的 supplier 段取 supplierId ?? supplier，
  // 单据头不带供应商的入库（内部领用 / 调货 / 报损…）若只落到文本，供应商一改名，
  // 同批号同效期同价的下一次入库就会算出新的 lot_key，把同一批实物拆成两行库存。
  const supplierId = normalizeText(trace.supplierId) ?? sku.supplier_id
  const supplier = normalizeText(trace.supplier) ?? sku.supplier
  const sourceDocId = normalizeRequired(trace.sourceDocId, '批次来源单据')
  const lotKey = makeLotKey(skuId, {
    batchNo,
    expiryDate,
    isGift,
    supplyChainUnitCost,
    marketActualUnitPrice,
    storeActualUnitPrice,
    supplier,
    supplierId,
    sourceDocId,
  })

  const rows = await tx.execute(sql`
    INSERT INTO inventory_stock_lots (
      location_id, sku_id, lot_key, sku_name, spec_name, supplier, supplier_id, product_series,
      batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
      supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
      market_actual_unit_price, store_standard_unit_price, store_unit_discount,
      store_actual_unit_price, source_doc_id
    )
    VALUES (
      ${locationId}, ${sku.sku_id}, ${lotKey}, ${sku.product_name}, ${sku.spec_name},
      ${supplier}, ${supplierId}, ${sku.product_series}, ${batchNo}, ${expiryDate}, ${expiryDate ?? ''},
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
      supplier_id = COALESCE(EXCLUDED.supplier_id, inventory_stock_lots.supplier_id),
      product_series = EXCLUDED.product_series,
      updated_at = NOW()
    RETURNING id
  `)
  const id = Number((rows as unknown as Array<{ id: number }>)[0].id)
  return lockLotById(tx, id, locationId)
}

/**
 * 某主体下一批 SKU 各自的**在手量**（所有批次求和），返回 `skuId → 数量`。
 *
 * 盘点账面数刻意**不扣预留**（issue #131 的 Q0）：盘点比的是「账面 vs 货架上数出来的实物」，
 * 预留是对外承诺、货还在架上；扣了预留会让所有有在途预留的 SKU 天然显示为盘亏。
 * `stock_snapshot` 这一列在不同单据上有三种含义，别互相套用：
 *   - 绝大多数单据：**单个批次**的在手量（`lot.quantityOnHand`）
 *   - 盘点单（本函数）：**主体 + SKU 汇总**的在手量 —— 与上面同为「在手量」，只是**粒度**不同
 *   - 市场报货汇总（`business.ts` 里另算另写）：在手 − 已预留 = **可承诺量** —— 这个才是**口径**不同
 * 真正会算错账的是把最后那种与前两种混用。
 *
 * **一次 GROUP BY 取齐，不逐行查**：建单事务全程持有 `inventory_cutover_states` 的行锁
 * （`assertInventoryBusinessWritable` 的 `SELECT ... FOR UPDATE`），那是整个库存域的串行点；
 * 逐行往返会把别人的库存写入一起堵在这把锁后面，且连接池 max=5。
 * 一次查询还顺带让同一张单所有行的账面数取自**同一个语句快照**（READ COMMITTED 下
 * 逐条 SELECT 各取各的快照，会让一张「账面 vs 实盘」单失去单一时点语义）。
 *
 * GROUP BY 不出行 = 该 SKU 在该主体一个批次都没有 → 调用方落 0（不是 NULL）。
 */
async function skuOnHandByLocation(
  tx: Tx,
  locationId: string,
  skuIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (skuIds.length === 0) return result
  // ⚠️ 不能写 `= ANY(${skuIds}::text[])`：drizzle 的 sql 模板把 JS 数组当**单个**参数绑，
  // PG 收到的是裸字符串 → `22P02 malformed array literal`（2026-09-16 实机复现）。
  // 仓内既有写法是 sql.join 逐个参数化展开成 IN（见 actions/dashboard.ts:135），不拼接不注入。
  const rows = await tx.execute(sql`
    SELECT sku_id, COALESCE(SUM(quantity_on_hand), 0) AS quantity
      FROM inventory_stock_lots
     WHERE location_id = ${locationId}
       AND sku_id IN (${sql.join(skuIds.map((skuId) => sql`${skuId}`), sql`, `)})
     GROUP BY sku_id
  `)
  // 原生 SQL 的 numeric 聚合经 postgres.js 回来是 string，必须显式 Number()
  for (const row of rows as unknown as Array<{ sku_id: string; quantity: string | number | null }>) {
    result.set(row.sku_id, Number(row.quantity ?? 0))
  }
  return result
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
  const after = Number((before + delta).toFixed(2))
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
  supplierName: string | null
  priceVisibility: import('./types').InventoryPriceVisibility
}): InventorySkuRow {
  const sku = row.sku
  const supplyVisible = row.priceVisibility === 'all' || row.priceVisibility === 'supply_chain'
  const marketVisible = row.priceVisibility === 'all' || row.priceVisibility === 'market'
  const anyPriceVisible = supplyVisible || marketVisible
  return {
    skuId: sku.skuId,
    productCode: sku.productCode,
    productName: sku.productName,
    specName: sku.specName,
    supplier: sku.supplier,
    supplierId: sku.supplierId,
    supplierName: row.supplierName,
    manufacturer: sku.manufacturer,
    brand: sku.brand,
    productSeries: sku.productSeries,
    purchaseCategory: sku.purchaseCategory,
    sourceType: sku.sourceType as InventorySkuSourceType,
    ownerMarketId: sku.ownerMarketId,
    ownerMarketName: row.ownerMarketName,
    retailPrice: row.priceVisibility === 'all' ? numberOrNull(sku.retailPrice) : null,
    accountingPrice: supplyVisible ? numberOrNull(sku.accountingPrice) : null,
    supplyChainPurchasePrice: supplyVisible ? numberOrNull(sku.supplyChainPurchasePrice) : null,
    marketPurchasePrice: anyPriceVisible ? numberOrNull(sku.marketPurchasePrice) : null,
    marketPurchasePriceMode: supplyVisible ? sku.marketPurchasePriceMode as InventorySkuRow['marketPurchasePriceMode'] : null,
    marketPurchasePriceOverrideReason: supplyVisible ? sku.marketPurchasePriceOverrideReason : null,
    storePurchasePrice: marketVisible ? numberOrNull(sku.storePurchasePrice) : null,
    marketStaffPurchasePrice: marketVisible ? numberOrNull(sku.marketStaffPurchasePrice) : null,
    marketPurchaseDiscount: anyPriceVisible ? numberOrNull(sku.marketPurchaseDiscount) : null,
    storePurchaseDiscount: marketVisible ? numberOrNull(sku.storePurchaseDiscount) : null,
    staffPurchaseDiscount: marketVisible ? numberOrNull(sku.staffPurchaseDiscount) : null,
    itemCompanyPurchasePrice: supplyVisible ? numberOrNull(sku.itemCompanyPurchasePrice) : null,
    isReportable: sku.isReportable,
    isActive: sku.isActive,
    remark: sku.remark,
    createdAt: sku.createdAt.toISOString(),
    updatedAt: sku.updatedAt.toISOString(),
  }
}

/**
 * 品项公司发货单业务响应不携带金额（说明.md §5.3/§10.4）：明细价格快照本就为空，
 * 但赠送行金额被 DB 触发器按赠品规则置 0，会让单头 total_amount 汇总出 0.00 的假金额。
 * DB 保留该快照供审计追溯，响应层对此单据类型统一遮蔽。
 */
const AMOUNTLESS_DOC_TYPES = new Set<InventoryDocType>(['品项公司发货'])

function docRow(row: {
  doc: typeof inventoryDocs.$inferSelect
  sourceOrgNodeName: string | null
  sourceOrgNodeType: string | null
  targetOrgNodeName: string | null
  targetOrgNodeType: string | null
  includePrice: boolean
}): InventoryDocRow {
  const doc = row.doc
  const includeAmount = row.includePrice && !AMOUNTLESS_DOC_TYPES.has(doc.docType as InventoryDocType)
  return {
    id: doc.id,
    docType: doc.docType as InventoryDocType,
    status: doc.status as InventoryCoreDocStatus,
    sourceOrgNodeId: doc.sourceOrgNodeId,
    sourceOrgNodeName: row.sourceOrgNodeName,
    sourceOrgNodeType: row.sourceOrgNodeType as InventoryLocationType | null,
    targetOrgNodeId: doc.targetOrgNodeId,
    targetOrgNodeName: row.targetOrgNodeName,
    targetOrgNodeType: row.targetOrgNodeType as InventoryLocationType | null,
    marketId: doc.marketId,
    supplierId: doc.supplierId,
    docDate: doc.docDate,
    relatedSaleOrderId: doc.relatedSaleOrderId,
    customerName: doc.customerName,
    employeeName: doc.employeeName,
    supplierName: doc.supplierName,
    externalPartyName: doc.externalPartyName,
    logisticsCompany: doc.logisticsCompany,
    trackingNo: doc.trackingNo,
    receiptAttachmentUrl: doc.receiptAttachmentUrl,
    totalQuantity: Number(doc.totalQuantity),
    totalAmount: includeAmount ? numberOrNull(doc.totalAmount) : undefined,
    remark: doc.remark,
    auditRemark: doc.auditRemark,
    createdBy: doc.createdBy,
    confirmedAt: doc.confirmedAt?.toISOString() ?? null,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    rejectedAt: doc.rejectedAt?.toISOString() ?? null,
    cancellationRequestReason: doc.cancellationRequestReason,
    cancellationRequestedBy: doc.cancellationRequestedBy,
    cancellationRequestedAt: doc.cancellationRequestedAt?.toISOString() ?? null,
    cancellationReason: doc.cancellationReason,
    cancelledAt: doc.cancelledAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

/**
 * 未完成预留（提货预约等）标量子查询：与 activeReservedQuantity / pickup-records
 * 的 GREATEST 口径一致，可用量 = 在手数量 − SUM(quantity − fulfilled − released)。
 */
const activeReservedQuantitySql = sql<string | number | null>`(
  SELECT COALESCE(SUM(reservation.quantity - reservation.fulfilled_quantity - reservation.released_quantity), 0)
    FROM inventory_stock_reservations reservation
   WHERE reservation.lot_id = ${inventoryStockLots.id}
     AND reservation.status = '已预留'
)`

function lotRow(
  row: {
    lot: typeof inventoryStockLots.$inferSelect
    locationName: string | null
    locationType: string | null
    locationOrgNodeId?: string | null
    reservedQuantity?: string | number | null
  },
  priceTiers: import('./access').InventoryPriceTierScopes,
): InventoryLotRow {
  // 行级档位（§9.3/§9.5）：价格权限只对授予它的那条角色绑定覆盖的 org 生效，
  // 批次行按其 location 对应 org 判定，防混合绑定会话跨绑定借权看价。
  const priceVisibility = inventoryPriceVisibilityForOrgNodes(priceTiers, [row.locationOrgNodeId])
  const supplyVisible = priceVisibility === 'all' || priceVisibility === 'supply_chain'
  const marketVisible = priceVisibility === 'all' || priceVisibility === 'market'
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
    availableQuantity: Math.max(0, Number((Number(row.lot.quantityOnHand) - Number(row.reservedQuantity ?? 0)).toFixed(2))),
    supplyChainUnitCost: supplyVisible ? numberOrNull(row.lot.supplyChainUnitCost) : undefined,
    marketActualUnitPrice: supplyVisible || marketVisible ? numberOrNull(row.lot.marketActualUnitPrice) : undefined,
    storeActualUnitPrice: marketVisible ? numberOrNull(row.lot.storeActualUnitPrice) : undefined,
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

async function inventoryLocationFilterOptions(
  session: AuthSession,
): Promise<InventoryLocationFilterOptions> {
  await syncInventoryLocations()
  const scoped = await scopedLocationIds(session)
  const rows = await db
    .select()
    .from(inventoryLocations)
    .where(eq(inventoryLocations.isActive, true))
    .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name))
  return buildInventoryLocationFilterOptions(
    rows.map((row) => ({
      locationId: row.locationId,
      locationType: row.locationType as InventoryLocationType,
      name: row.name,
      orgNodeId: row.orgNodeId,
      storeId: row.storeId,
      parentLocationId: row.parentLocationId,
      isActive: row.isActive,
    })),
    scoped,
  )
}

async function inventoryDocLocationFilterOptions(
  session: AuthSession,
): Promise<InventoryLocationFilterOptions> {
  await syncInventoryLocations()
  const scoped = inventoryScopedOrgNodeIds(session)
  const rows = await db
    .select()
    .from(inventoryLocations)
    .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name))
  return buildInventoryLocationFilterOptions(
    rows
      .filter((row) => row.orgNodeId)
      .map((row) => ({
        locationId: row.orgNodeId!,
        locationType: row.locationType as InventoryLocationType,
        name: row.isActive ? row.name : `${row.name}（已停用）`,
        orgNodeId: row.orgNodeId,
        storeId: row.storeId,
        parentLocationId: row.parentLocationId,
        isActive: row.isActive,
      })),
    scoped,
  )
}

export const listInventoryLocationFilterOptions = withPermission(
  'inventory:stock_list',
  inventoryLocationFilterOptions,
)

export const listInventoryDocLocationFilterOptions = withPermission(
  'inventory:list',
  inventoryDocLocationFilterOptions,
)

/**
 * 把表单提交的 `supplierId` 解析成 `supplier_id` + `supplier`（冗余名称）两列的写入值（#132）。
 *
 * 返回 `null` 表示**这两列都不要动** —— 对应 `input.supplierId === undefined`。
 * 存量里有一批 `supplier` 文本没匹配上档案的旧 SKU（migration 0042 按名称精确匹配回填，
 * 匹配不上的留 NULL），编辑这类 SKU 时前端不提交 `supplierId`，靠这条分支保住原文本。
 *
 * `currentSupplierId` 用来放行「已关联的档案后来被停用」：编辑这类 SKU 时下拉仍会带上它，
 * 保存不应被拒；但**换成**另一个已停用的档案要拦（停用 = 不再采购）。
 */
async function resolveSkuSupplier(
  tx: Tx,
  supplierIdInput: string | null | undefined,
  currentSupplierId: string | null,
): Promise<{ supplierId: string | null; supplier: string | null; onlyIfCurrent: boolean } | null> {
  if (supplierIdInput === undefined) return null
  const id = normalizeText(supplierIdInput)
  if (!id) return { supplierId: null, supplier: null, onlyIfCurrent: false }
  // `FOR SHARE` 而不是默认快照读，也不是 `FOR KEY SHARE`：
  // 改名改的是 name 这个**非键列**，走 FOR NO KEY UPDATE —— FOR KEY SHARE 挡不住它。
  // 挡不住的话这条时序会留下永久不一致：
  //   ① 本事务读到「旧名」→ ② updateInventorySupplier 改名并把所有关联 SKU 同步成新名并提交
  //   → ③ 本事务用缓存的旧名写回 → supplier_id 指向的档案叫新名，而 SKU 快照是旧名，
  //      之后建的批次 / 单据把旧名永久冻结进去。
  // 锁序统一为 inventory_suppliers → inventory_skus（改名事务也是先改档案再同步 SKU），
  // 两条路径在供应商行上互斥，进不到同时操作 SKU 的阶段，不构成死锁。
  const [supplier] = await tx
    .select({ name: inventorySuppliers.name, isActive: inventorySuppliers.isActive })
    .from(inventorySuppliers)
    .where(eq(inventorySuppliers.supplierId, id))
    .limit(1)
    .for('share')
  if (!supplier) throw new ApiError('NOT_FOUND', '供应商不存在')
  if (!supplier.isActive && id !== currentSupplierId) {
    throw new ApiError('INVALID_STATE', `供应商「${supplier.name}」已停用，无法关联到库存商品`)
  }
  // 放行了一个**已停用**的档案，靠的是「它就是当前关联值」。但 currentSupplierId 是
  // 事务外读到的快照：别人可能已经把这条 SKU 改挂到别的档案上，那样这次写入实际是
  // 「换成另一个停用档案」—— 恰恰是上面那条要拦的。所以把这个前提下推到 UPDATE 的
  // WHERE 里，用行的**当前值**再判一次（见 updateInventorySku 的 supplierGuard）。
  return { supplierId: id, supplier: supplier.name, onlyIfCurrent: !supplier.isActive }
}

export const listInventorySkus = withPermission(
  'inventory:stock_list',
  async (
    session,
    filters: { keyword?: string; sourceType?: InventorySkuSourceType; onlyActive?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<{ data: InventorySkuRow[]; total: number }> => {
    await syncInventoryLocations()
    const page = normalizePage(filters.page)
    const pageSize = PAGE_SIZE_WHITELIST.includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
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
      .select({ sku: inventorySkus, ownerMarketName: orgNodes.name, supplierName: inventorySuppliers.name })
      .from(inventorySkus)
      .leftJoin(orgNodes, eq(inventorySkus.ownerMarketId, orgNodes.id))
      // 关联档案名走实时 JOIN 而不是读 supplier 文本快照：供应商改名后列表立刻跟随，
      // 而批次快照（inventory_stock_lots.supplier）保留下单时的旧名，两者语义不同。
      .leftJoin(inventorySuppliers, eq(inventorySkus.supplierId, inventorySuppliers.supplierId))
      .where(whereClause)
      .orderBy(asc(inventorySkus.productCode))
      .limit(pageSize)
      .offset(offset)
    const priceVisibility = inventoryPriceVisibility(session)
    return { data: rows.map((row) => skuRow({ ...row, priceVisibility })), total: countRow?.count ?? 0 }
  },
)

export const createInventorySku = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_sku_manage'],
  async (session, input: InventorySkuInput): Promise<{ success: true; skuId: string }> => {
    const productName = normalizeRequired(input.productName, '产品名称')
    const sourceType = input.sourceType ?? '供应链'
    if (!INVENTORY_SKU_SOURCE_TYPES.includes(sourceType)) {
      throw new ApiError('INVALID_PARAMS', '无效库存商品来源')
    }
    assertSelfPurchasedSkuEditor(session, sourceType)
    const ownerMarketId = await normalizeSkuOwnerMarket(session, sourceType, input.ownerMarketId)
    const priceValues = skuPriceValues(input, inventoryPriceVisibility(session), sourceType)
    const skuId = await db.transaction(async (tx) => {
      // 在事务内、且对档案行加 FOR SHARE —— 见 resolveSkuSupplier 的注释
      const supplierValues = await resolveSkuSupplier(tx, input.supplierId, null)
      const generatedNo = await generateInventorySkuNo(tx)
      await tx.insert(inventorySkus).values({
        skuId: generatedNo,
        productCode: generatedNo,
        productName,
        specName: normalizeText(input.specName),
        supplier: supplierValues?.supplier ?? null,
        supplierId: supplierValues?.supplierId ?? null,
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
      return generatedNo
    })
    await logOperation(session, 'create', 'inventory_skus', skuId, { productCode: skuId, productName })
    revalidatePath('/inventory')
    revalidatePath('/inventory/skus')
    return { success: true, skuId }
  },
)

export const updateInventorySku = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_sku_manage'],
  async (session, skuId: string, input: Partial<InventorySkuInput>): Promise<{ success: true }> => {
    const id = normalizeRequired(skuId, '库存 SKU')
    if (input.sourceType && !INVENTORY_SKU_SOURCE_TYPES.includes(input.sourceType)) {
      throw new ApiError('INVALID_PARAMS', '无效库存商品来源')
    }
    const [current] = await db
      .select({
        accountingPrice: inventorySkus.accountingPrice,
        marketPurchaseDiscount: inventorySkus.marketPurchaseDiscount,
        marketPurchasePrice: inventorySkus.marketPurchasePrice,
        marketPurchasePriceMode: inventorySkus.marketPurchasePriceMode,
        marketPurchasePriceOverrideReason: inventorySkus.marketPurchasePriceOverrideReason,
        sourceType: inventorySkus.sourceType,
        ownerMarketId: inventorySkus.ownerMarketId,
        supplierId: inventorySkus.supplierId,
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
    const priceValues = skuPriceValues(input, inventoryPriceVisibility(session), sourceType, current)
    // 供应商解析与 SKU 写入必须在同一事务：解析时对档案行加 FOR SHARE，
    // 挡住「读到旧名 → 别人改名并同步 → 我写回旧名」的时序（见 resolveSkuSupplier）
    await db.transaction(async (tx) => {
      const supplierValues = await resolveSkuSupplier(tx, input.supplierId, current.supplierId)
      // 只有「保持一个已停用的档案」这一种情况需要 CAS：行的 supplier_id 必须仍是它，
      // 否则说明中途被改挂了，这次写入就成了「换到停用档案」。
      const supplierGuard = supplierValues?.onlyIfCurrent && supplierValues.supplierId
        ? eq(inventorySkus.supplierId, supplierValues.supplierId)
        : undefined
      const updateResult = await tx
        .update(inventorySkus)
        .set({
          productName: normalizeText(input.productName) ?? undefined,
          specName: input.specName === undefined ? undefined : normalizeText(input.specName),
          supplier: supplierValues === null ? undefined : supplierValues.supplier,
          supplierId: supplierValues === null ? undefined : supplierValues.supplierId,
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
        .where(supplierGuard ? and(eq(inventorySkus.skuId, id), supplierGuard) : eq(inventorySkus.skuId, id))
      // postgres.js 下受影响行数是 `.count`（没有 rowCount），统一走 rowsAffected
      if (supplierGuard && rowsAffected(updateResult) === 0) {
        throw new ApiError('CONFLICT', '该库存商品的供货商已被他人修改，请刷新后重试')
      }
    })
    await logOperation(session, 'update', 'inventory_skus', id, input)
    revalidatePath('/inventory/skus')
    return { success: true }
  },
)

export const listInventorySkuCompositions = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: {
      keyword?: string
      status?: 'configured' | 'unconfigured' | 'invalid'
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: InventoryCompositionRow[]; total: number }> => {
    const [productRows, componentRows] = await Promise.all([
      db
        .select({
          productSkuId: productSkus.skuId,
          productSkuName: productSkus.specName,
          productSkuEnabled: productSkus.isEnabled,
        })
        .from(productSkus)
        .where(and(
          eq(productSkus.productType, '家居产品'),
          isNull(productSkus.deletedAt),
        ))
        .orderBy(asc(productSkus.specName), asc(productSkus.skuId)),
      db.select({
        mapping: inventorySkuProductSkuMappings,
        inventorySku: inventorySkus,
      })
      .from(inventorySkuProductSkuMappings)
      .innerJoin(inventorySkus, eq(inventorySkuProductSkuMappings.inventorySkuId, inventorySkus.skuId))
      .where(eq(inventorySkuProductSkuMappings.isActive, true))
      .orderBy(asc(inventorySkus.productName), asc(inventorySkus.productCode)),
    ])

    const componentsByProduct = new Map<string, InventoryCompositionRow['components']>()
    const updatedAtByProduct = new Map<string, string>()
    for (const row of componentRows) {
      const components = componentsByProduct.get(row.mapping.productSkuId) ?? []
      components.push({
        mappingId: row.mapping.id,
        inventorySkuId: row.mapping.inventorySkuId,
        inventorySkuCode: row.inventorySku.productCode,
        inventorySkuName: row.inventorySku.productName,
        inventorySkuSpecName: row.inventorySku.specName,
        inventorySkuActive: row.inventorySku.isActive,
        quantityPerSaleUnit: row.mapping.quantityPerSaleUnit,
      })
      componentsByProduct.set(row.mapping.productSkuId, components)
      const iso = row.mapping.updatedAt.toISOString()
      if (!updatedAtByProduct.has(row.mapping.productSkuId) || iso > updatedAtByProduct.get(row.mapping.productSkuId)!) {
        updatedAtByProduct.set(row.mapping.productSkuId, iso)
      }
    }

    const keyword = filters.keyword?.trim().toLocaleLowerCase() ?? ''
    const filtered = productRows
      .map((product): InventoryCompositionRow => {
        const components = componentsByProduct.get(product.productSkuId) ?? []
        const configurationStatus = components.length === 0
          ? 'unconfigured'
          : components.every((component) => component.inventorySkuActive)
            ? 'configured'
            : 'invalid'
        return {
          ...product,
          components,
          configurationStatus,
          updatedAt: updatedAtByProduct.get(product.productSkuId) ?? null,
        }
      })
      .filter((row) => !filters.status || row.configurationStatus === filters.status)
      .filter((row) => !keyword || [
        row.productSkuId,
        row.productSkuName,
        ...row.components.flatMap((component) => [
          component.inventorySkuId,
          component.inventorySkuCode,
          component.inventorySkuName,
          component.inventorySkuSpecName ?? '',
        ]),
      ].some((value) => value.toLocaleLowerCase().includes(keyword)))

    // ⚠️ 这里是**内存切片**，不是 SQL 分页 —— 上面两个 filter 依赖的
    // `configurationStatus` 是按 components 算出来的派生字段，keyword 还要搜到
    // components 内部，都没法下推成 WHERE。所以 total 必须取过滤**之后**的长度，
    // 而不是 productRows.length。
    // 家居 SKU 是低基数主数据（dev 现有 101 行），全量取回可接受；
    // 若将来量级上来，得先把 configurationStatus 物化到列上才谈得上真正的 SQL 分页。
    // 同 listInventorySuppliers：给了 pageSize 就必须过白名单，page 用 `|| 1` 兜 NaN。
    // 这一支尤其不能漏 —— `filtered.slice(NaN, NaN)` 返回**空数组**（ToInteger(NaN)=0），
    // 而客户端 `Number(get('page','1')) || 1` 会认为自己在第 1 页、不触发越界自纠，
    // 于是 `?page=abc` 会永久停在「空表 + 共 101 条」，用户只能手改 URL 才能出来。
    const pageSize = filters.pageSize === undefined
      ? undefined
      : (PAGE_SIZE_WHITELIST.includes(filters.pageSize) ? filters.pageSize : 20)
    const offset = (normalizePage(filters.page) - 1) * (pageSize ?? 0)
    return {
      data: pageSize ? filtered.slice(offset, offset + pageSize) : filtered,
      total: filtered.length,
    }
  },
)

export const listInventorySkuCompositionOptions = withPermission(
  'inventory:stock_list',
  async (_session): Promise<InventoryCompositionOptions> => {
    const [productRows, inventoryRows] = await Promise.all([
      db
        .select({ skuId: productSkus.skuId, specName: productSkus.specName })
        .from(productSkus)
        .where(and(
          eq(productSkus.productType, '家居产品'),
          eq(productSkus.isEnabled, true),
          isNull(productSkus.deletedAt),
        ))
        .orderBy(asc(productSkus.specName)),
      db
        .select({
          skuId: inventorySkus.skuId,
          productCode: inventorySkus.productCode,
          productName: inventorySkus.productName,
          specName: inventorySkus.specName,
        })
        .from(inventorySkus)
        .where(eq(inventorySkus.isActive, true))
        .orderBy(asc(inventorySkus.productName), asc(inventorySkus.productCode)),
    ])
    return { productSkus: productRows, inventorySkus: inventoryRows }
  },
)

async function saveInventorySkuComposition(
  session: AuthSession,
  input: InventoryCompositionInput,
): Promise<{ success: true; productSkuId: string }> {
    const productSkuId = normalizeRequired(input.productSkuId, '销售 SKU')
    if (!Array.isArray(input.components) || input.components.length === 0) {
      throw new ApiError('INVALID_PARAMS', '至少添加一个库存商品')
    }
    const components = input.components.map((component) => ({
      inventorySkuId: normalizeRequired(component.inventorySkuId, '库存 SKU'),
      quantityPerSaleUnit: Number(component.quantityPerSaleUnit),
    }))
    if (components.some((component) => !Number.isInteger(component.quantityPerSaleUnit) || component.quantityPerSaleUnit <= 0)) {
      throw new ApiError('INVALID_PARAMS', '组成数量必须为正整数')
    }
    if (new Set(components.map((component) => component.inventorySkuId)).size !== components.length) {
      throw new ApiError('INVALID_PARAMS', '同一库存商品不能重复添加')
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-composition:${productSkuId}`})::bigint)`)
      const [[productSku], currentRows, inventoryRows] = await Promise.all([
        tx
          .select({ skuId: productSkus.skuId, productType: productSkus.productType })
          .from(productSkus)
          .where(and(eq(productSkus.skuId, productSkuId), isNull(productSkus.deletedAt)))
          .limit(1),
        tx
          .select()
          .from(inventorySkuProductSkuMappings)
          .where(and(
            eq(inventorySkuProductSkuMappings.productSkuId, productSkuId),
            eq(inventorySkuProductSkuMappings.isActive, true),
          )),
        tx
          .select({ skuId: inventorySkus.skuId, isActive: inventorySkus.isActive })
          .from(inventorySkus)
          .where(inArray(inventorySkus.skuId, components.map((component) => component.inventorySkuId))),
      ])
      if (!productSku || productSku.productType !== '家居产品') {
        throw new ApiError('INVALID_PARAMS', '销售 SKU 不存在或不是家居产品')
      }
      if (inventoryRows.length !== components.length || inventoryRows.some((row) => !row.isActive)) {
        throw new ApiError('INVALID_PARAMS', '部分库存商品不存在或已停用')
      }

      const currentUpdatedAt = currentRows.length === 0
        ? null
        : new Date(Math.max(...currentRows.map((row) => row.updatedAt.getTime()))).toISOString()
      if (currentUpdatedAt !== input.expectedUpdatedAt) {
        throw new ApiError('CONFLICT', '销售商品组成已被其他人修改，请刷新后重试')
      }
      const before = currentRows.map((row) => ({
        inventorySkuId: row.inventorySkuId,
        quantityPerSaleUnit: row.quantityPerSaleUnit,
      }))
      const now = new Date()
      await tx
        .update(inventorySkuProductSkuMappings)
        .set({ isActive: false, updatedAt: now })
        .where(and(
          eq(inventorySkuProductSkuMappings.productSkuId, productSkuId),
          eq(inventorySkuProductSkuMappings.isActive, true),
        ))
      for (const component of components) {
        await tx
          .insert(inventorySkuProductSkuMappings)
          .values({
            productSkuId,
            inventorySkuId: component.inventorySkuId,
            quantityPerSaleUnit: component.quantityPerSaleUnit,
            isActive: true,
            createdBy: session.employeeId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              inventorySkuProductSkuMappings.productSkuId,
              inventorySkuProductSkuMappings.inventorySkuId,
            ],
            set: {
              quantityPerSaleUnit: component.quantityPerSaleUnit,
              isActive: true,
              updatedAt: now,
            },
          })
      }
      return { before, after: components }
    })
    await logOperation(
      session,
      result.before.length === 0 ? 'create' : 'update',
      'inventory_sku_composition',
      productSkuId,
      result,
    )
    revalidatePath('/inventory')
    revalidatePath('/inventory/sku-mappings')
    return { success: true, productSkuId }
}

export const createInventorySkuComposition = withPermission(
  'inventory:supply_chain_master_data_manage',
  saveInventorySkuComposition,
)

export const updateInventorySkuComposition = withPermission(
  'inventory:supply_chain_master_data_manage',
  saveInventorySkuComposition,
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
  ): Promise<{ data: InventoryLotRow[]; total: number; canViewPrice: boolean; priceVisibility: import('./types').InventoryPriceVisibility }> => {
    await syncInventoryLocations()
    const scoped = await scopedLocationIds(session)
    const page = normalizePage(filters.page)
    const pageSize = PAGE_SIZE_WHITELIST.includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
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
      .select({
        lot: inventoryStockLots,
        locationName: inventoryLocations.name,
        locationType: inventoryLocations.locationType,
        locationOrgNodeId: inventoryLocations.orgNodeId,
        reservedQuantity: activeReservedQuantitySql,
      })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(whereClause)
      .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo))
      .limit(pageSize)
      .offset(offset)
    const priceVisibility = inventoryPriceVisibility(session)
    const priceTiers = inventoryPriceScopeByTier(session)
    return {
      data: rows.map((row) => lotRow(row, priceTiers)),
      total: countRow?.count ?? 0,
      canViewPrice: priceVisibility !== 'none',
      priceVisibility,
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
        locationOrgNodeId: inventoryLocations.orgNodeId,
        reservedQuantity: activeReservedQuantitySql,
      })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(and(
        eq(inventoryStockLots.locationId, normalizedLocationId),
        eq(inventoryStockLots.skuId, normalizedSkuId),
        sql`${inventoryStockLots.quantityOnHand} > 0`,
      ))
      .orderBy(asc(inventoryStockLots.expiryDate), asc(inventoryStockLots.batchNo), asc(inventoryStockLots.id))
    const priceTiers = inventoryPriceScopeByTier(session)
    return rows.map((row) => lotRow(row, priceTiers))
  },
)

export const exportInventoryLots = withPermission(
  'inventory:export',
  async (
    session,
    params: Record<string, string | undefined> = {},
    options?: ExportBatchOptions<number>,
  ): Promise<ExportBatchResult<InventoryLotRow> & { canViewPrice: boolean; priceVisibility: import('./types').InventoryPriceVisibility }> => {
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
    const query = db
      .select({
        lot: inventoryStockLots,
        locationName: inventoryLocations.name,
        locationType: inventoryLocations.locationType,
        locationOrgNodeId: inventoryLocations.orgNodeId,
        reservedQuantity: activeReservedQuantitySql,
      })
      .from(inventoryStockLots)
      .leftJoin(inventoryLocations, eq(inventoryStockLots.locationId, inventoryLocations.locationId))
      .where(whereClause)
      .orderBy(
        asc(inventoryLocations.locationType),
        asc(inventoryLocations.name),
        asc(inventoryStockLots.skuName),
        asc(inventoryStockLots.batchNo),
        asc(inventoryStockLots.id),
      )
    const priceVisibility = inventoryPriceVisibility(session)
    const priceTiers = inventoryPriceScopeByTier(session)
    const page = resolveExportOffsetPage(options)
    if (page) {
      const rows = await query.limit(page.limit + 1).offset(page.offset)
      return {
        ...offsetPageResult(rows.map((row) => lotRow(row, priceTiers)), page),
        canViewPrice: priceVisibility !== 'none',
        priceVisibility,
      }
    }
    const rows = await query.limit(LIMIT + 1)
    const truncated = rows.length > LIMIT
    return {
      rows: rows.slice(0, LIMIT).map((row) => lotRow(row, priceTiers)),
      truncated,
      hasMore: false,
      canViewPrice: priceVisibility !== 'none',
      priceVisibility,
    }
  },
)

export const listInventoryCoreDocs = withPermission(
  'inventory:list',
  async (
    session,
    filters: {
      orgNodeId?: string
      locationType?: InventoryLocationType
      docType?: InventoryDocType
      status?: InventoryCoreDocStatus
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: InventoryDocRow[]; total: number; canViewPrice: boolean; priceVisibility: import('./types').InventoryPriceVisibility }> => {
    await syncInventoryLocations()
    const scoped = inventoryScopedOrgNodeIds(session)
    const page = normalizePage(filters.page)
    const pageSize = PAGE_SIZE_WHITELIST.includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions: (SQL | undefined)[] = []
    if (scoped !== null) {
      conditions.push(scoped.length > 0
        ? or(inArray(inventoryDocs.sourceOrgNodeId, scoped), inArray(inventoryDocs.targetOrgNodeId, scoped))
        : sql`FALSE`)
    }
    if (filters.orgNodeId) {
      const locations = await db
        .select({ orgNodeId: inventoryLocations.orgNodeId, parentOrgNodeId: inventoryLocations.parentLocationId })
        .from(inventoryLocations)
      const descendants = new Set<string>([filters.orgNodeId])
      let changed = true
      while (changed) {
        changed = false
        for (const location of locations) {
          if (
            location.orgNodeId
            && location.parentOrgNodeId
            && descendants.has(location.parentOrgNodeId)
            && !descendants.has(location.orgNodeId)
          ) {
            descendants.add(location.orgNodeId)
            changed = true
          }
        }
      }
      const selectedOrgNodeIds = [...descendants]
      conditions.push(or(
        inArray(inventoryDocs.sourceOrgNodeId, selectedOrgNodeIds),
        inArray(inventoryDocs.targetOrgNodeId, selectedOrgNodeIds),
      ))
    }
    if (filters.locationType) {
      const typedLocations = await db
        .select({ orgNodeId: inventoryLocations.orgNodeId })
        .from(inventoryLocations)
        .where(eq(inventoryLocations.locationType, filters.locationType))
      const typedOrgNodeIds = typedLocations.flatMap((location) => location.orgNodeId ? [location.orgNodeId] : [])
      conditions.push(typedOrgNodeIds.length > 0
        ? or(inArray(inventoryDocs.sourceOrgNodeId, typedOrgNodeIds), inArray(inventoryDocs.targetOrgNodeId, typedOrgNodeIds))
        : sql`FALSE`)
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
        sourceOrgNodeName: sourceLocation.name,
        sourceOrgNodeType: sourceLocation.locationType,
        targetOrgNodeName: targetLocation.name,
        targetOrgNodeType: targetLocation.locationType,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(whereClause)
      .orderBy(desc(inventoryDocs.docDate), desc(inventoryDocs.createdAt))
      .limit(pageSize)
      .offset(offset)
    const priceVisibility = inventoryPriceVisibility(session)
    // 行级档位（§9.3/§9.5）：金额可见性按单据参与主体（source/target 端点任一命中
    // 该档位绑定的 org 集合）判定，与单据可见性同构；防混合绑定会话跨绑定借权看价。
    const priceTiers = inventoryPriceScopeByTier(session)
    return {
      data: rows.map((row) => docRow({
        ...row,
        includePrice: inventoryPriceVisibilityForOrgNodes(
          priceTiers,
          [row.doc.sourceOrgNodeId, row.doc.targetOrgNodeId],
        ) !== 'none',
      })),
      total: countRow?.count ?? 0,
      canViewPrice: priceVisibility !== 'none',
      priceVisibility,
    }
  },
)

/**
 * 详情页的关联单据必须再次经过库存主体范围过滤：当前单据可见不代表所有上下游都可见。
 * 列名由内部固定调用点提供，scope 值始终由 Drizzle 参数化。
 */
function inventoryDocScopeSql(
  scoped: string[] | null,
  sourceColumn: SQL,
  targetColumn: SQL,
): SQL {
  if (scoped === null) return sql`TRUE`
  if (scoped.length === 0) return sql`FALSE`
  const values = sql.join(scoped.map((locationId) => sql`${locationId}`), sql`, `)
  return sql`(${sourceColumn} IN (${values}) OR ${targetColumn} IN (${values}))`
}

function visibleInventoryDocsSql(scoped: string[] | null): SQL {
  return sql`
    SELECT visible_doc.id
      FROM inventory_docs visible_doc
     WHERE ${inventoryDocScopeSql(
       scoped,
       sql`visible_doc.source_org_node_id`,
       sql`visible_doc.target_org_node_id`,
     )}
  `
}

function asDocDate(value: string | Date): string {
  return fmtDate(value)
}

async function loadInventoryDocLineage(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocLineageRow[]> {
  const linkedDocVisible = scoped === null
    ? sql`TRUE`
    : sql`(
      (doc_link.from_doc_id = ${docId} AND ${inventoryDocScopeSql(
        scoped,
        sql`to_doc.source_org_node_id`,
        sql`to_doc.target_org_node_id`,
      )})
      OR
      (doc_link.to_doc_id = ${docId} AND ${inventoryDocScopeSql(
        scoped,
        sql`from_doc.source_org_node_id`,
        sql`from_doc.target_org_node_id`,
      )})
    )`
  const rows = await db.execute(sql`
    SELECT
      CASE WHEN doc_link.from_doc_id = ${docId} THEN '下游' ELSE '上游' END AS direction,
      doc_link.relation_type,
      CASE WHEN doc_link.from_doc_id = ${docId} THEN to_doc.id ELSE from_doc.id END AS doc_id,
      CASE WHEN doc_link.from_doc_id = ${docId} THEN to_doc.doc_type ELSE from_doc.doc_type END AS doc_type,
      CASE WHEN doc_link.from_doc_id = ${docId} THEN to_doc.status ELSE from_doc.status END AS status,
      CASE WHEN doc_link.from_doc_id = ${docId} THEN to_doc.doc_date ELSE from_doc.doc_date END AS doc_date,
      CASE WHEN doc_link.from_doc_id = ${docId} THEN to_doc.total_quantity ELSE from_doc.total_quantity END AS total_quantity,
      COALESCE(SUM(doc_link.quantity), 0) AS linked_quantity,
      MAX(doc_link.created_at) AS linked_at
    FROM inventory_doc_links doc_link
    JOIN inventory_docs from_doc ON from_doc.id = doc_link.from_doc_id
    JOIN inventory_docs to_doc ON to_doc.id = doc_link.to_doc_id
    WHERE (doc_link.from_doc_id = ${docId} OR doc_link.to_doc_id = ${docId})
      AND ${linkedDocVisible}
    GROUP BY
      doc_link.from_doc_id,
      doc_link.to_doc_id,
      doc_link.relation_type,
      from_doc.id,
      from_doc.doc_type,
      from_doc.status,
      from_doc.doc_date,
      from_doc.total_quantity,
      to_doc.id,
      to_doc.doc_type,
      to_doc.status,
      to_doc.doc_date,
      to_doc.total_quantity
    ORDER BY linked_at DESC, doc_link.relation_type ASC
  `)
  return (rows as unknown as Array<{
    direction: '上游' | '下游'
    relation_type: string
    doc_id: string
    doc_type: string
    status: string
    doc_date: string | Date
    total_quantity: string | number | null
    linked_quantity: string | number | null
  }>).map((row) => ({
    direction: row.direction,
    relationType: row.relation_type,
    docId: row.doc_id,
    docType: row.doc_type as InventoryDocType,
    status: row.status as InventoryCoreDocStatus,
    docDate: asDocDate(row.doc_date),
    totalQuantity: numberOrNull(row.total_quantity) ?? 0,
    linkedQuantity: numberOrNull(row.linked_quantity) ?? 0,
  }))
}

type ReportFulfillmentQueryRow = {
  item_id: number | string
  normal_demand_quantity: string | number | null
  ordered_quantity?: string | number | null
  normal_fulfilled_quantity: string | number | null
  gift_fulfilled_quantity: string | number | null
  normal_received_quantity: string | number | null
  gift_received_quantity: string | number | null
}

function reportFulfillmentItem(row: ReportFulfillmentQueryRow, includeOrder: boolean) {
  return {
    itemId: Number(row.item_id),
    normalDemandQuantity: numberOrNull(row.normal_demand_quantity) ?? 0,
    ...(includeOrder ? { orderedQuantity: numberOrNull(row.ordered_quantity) ?? 0 } : {}),
    normalFulfilledQuantity: numberOrNull(row.normal_fulfilled_quantity) ?? 0,
    giftFulfilledQuantity: numberOrNull(row.gift_fulfilled_quantity) ?? 0,
    normalReceivedQuantity: numberOrNull(row.normal_received_quantity) ?? 0,
    giftReceivedQuantity: numberOrNull(row.gift_received_quantity) ?? 0,
  }
}

async function loadMarketReportFulfillmentProgress(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress> {
  const rows = await db.execute(sql`
    WITH visible_docs AS (${visibleInventoryDocsSql(scoped)}),
    root_items AS (
      SELECT item.id AS item_id, item.quantity
        FROM inventory_doc_items item
        JOIN visible_docs root_doc ON root_doc.id = item.doc_id
       WHERE item.doc_id = ${docId}
    ),
    purchase_links AS (
      -- ⚠️ 这里**刻意不按 visible_docs 过滤采购单**（#194）。
      -- 收敛后采购单可以汇总多个市场的行，单头因此没有 source/market 归属，
      -- 市场 scope 看不见它；若在这里过滤，市场打开自己的报货单会看到「已采购 0」——
      -- 收敛前采购单 source=该市场、天然可见，是本次改动引入的可见性回归。
      -- 本 CTE 只把数量聚合回**已经过可见性校验的** root_items，不外泄采购单本身的任何内容
      -- （单号、其它市场的明细都不出现在返回值里），所以放开这层过滤是安全的。
      SELECT
        doc_link.from_item_id AS root_item_id,
        doc_link.to_item_id AS purchase_item_id,
        COALESCE(doc_link.quantity, 0) AS quantity
        FROM inventory_doc_links doc_link
        JOIN root_items root_item ON root_item.item_id = doc_link.from_item_id
        JOIN inventory_docs purchase_doc ON purchase_doc.id = doc_link.to_doc_id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '市场报货采购订单'
         AND purchase_doc.status IN ('已完成', '待收货')
    ),
    purchase_totals AS (
      SELECT root_item_id, SUM(quantity) AS ordered_quantity
        FROM purchase_links
       GROUP BY root_item_id
    ),
    shipment_links AS (
      SELECT
        purchase_link.root_item_id,
        doc_link.to_item_id AS shipment_item_id,
        doc_link.relation_type,
        COALESCE(doc_link.quantity, 0) AS quantity
        FROM purchase_links purchase_link
        JOIN inventory_doc_links doc_link
          ON doc_link.from_item_id = purchase_link.purchase_item_id
        JOIN inventory_docs shipment_doc ON shipment_doc.id = doc_link.to_doc_id
       JOIN visible_docs visible_shipment ON visible_shipment.id = shipment_doc.id
       WHERE doc_link.relation_type IN ('采购订单发货', '采购订单赠送发货')
         AND shipment_doc.status IN ('待收货', '已完成')
    ),
    shipment_totals AS (
      SELECT
        root_item_id,
        SUM(CASE WHEN relation_type = '采购订单发货' THEN quantity ELSE 0 END) AS normal_fulfilled_quantity,
        SUM(CASE WHEN relation_type = '采购订单赠送发货' THEN quantity ELSE 0 END) AS gift_fulfilled_quantity
        FROM shipment_links
       GROUP BY root_item_id
    ),
    receipt_links AS (
      SELECT
        shipment_link.root_item_id,
        shipment_link.relation_type AS shipment_relation_type,
        COALESCE(doc_link.quantity, 0) AS quantity
        FROM shipment_links shipment_link
        JOIN inventory_doc_links doc_link
          ON doc_link.from_item_id = shipment_link.shipment_item_id
        JOIN inventory_docs receipt_doc ON receipt_doc.id = doc_link.to_doc_id
       JOIN visible_docs visible_receipt ON visible_receipt.id = receipt_doc.id
       WHERE doc_link.relation_type = '发货收货'
         AND receipt_doc.status = '已完成'
    ),
    receipt_totals AS (
      SELECT
        root_item_id,
        SUM(CASE WHEN shipment_relation_type = '采购订单发货' THEN quantity ELSE 0 END) AS normal_received_quantity,
        SUM(CASE WHEN shipment_relation_type = '采购订单赠送发货' THEN quantity ELSE 0 END) AS gift_received_quantity
        FROM receipt_links
       GROUP BY root_item_id
    )
    SELECT
      root_item.item_id,
      root_item.quantity AS normal_demand_quantity,
      COALESCE(purchase_total.ordered_quantity, 0) AS ordered_quantity,
      COALESCE(shipment_total.normal_fulfilled_quantity, 0) AS normal_fulfilled_quantity,
      COALESCE(shipment_total.gift_fulfilled_quantity, 0) AS gift_fulfilled_quantity,
      COALESCE(receipt_total.normal_received_quantity, 0) AS normal_received_quantity,
      COALESCE(receipt_total.gift_received_quantity, 0) AS gift_received_quantity
      FROM root_items root_item
      LEFT JOIN purchase_totals purchase_total ON purchase_total.root_item_id = root_item.item_id
      LEFT JOIN shipment_totals shipment_total ON shipment_total.root_item_id = root_item.item_id
      LEFT JOIN receipt_totals receipt_total ON receipt_total.root_item_id = root_item.item_id
     ORDER BY root_item.item_id
  `)
  return {
    kind: '报货履约',
    items: (rows as unknown as ReportFulfillmentQueryRow[])
      .map((row) => reportFulfillmentItem(row, true)),
  }
}

async function loadStoreReportFulfillmentProgress(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress> {
  const rows = await db.execute(sql`
    WITH visible_docs AS (${visibleInventoryDocsSql(scoped)}),
    root_items AS (
      SELECT item.id AS item_id, item.quantity
        FROM inventory_doc_items item
        JOIN visible_docs root_doc ON root_doc.id = item.doc_id
       WHERE item.doc_id = ${docId}
    ),
    allocation_links AS (
      SELECT
        doc_link.from_item_id AS root_item_id,
        doc_link.to_item_id AS allocation_item_id,
        doc_link.relation_type,
        COALESCE(doc_link.quantity, 0) AS quantity
        FROM inventory_doc_links doc_link
        JOIN root_items root_item ON root_item.item_id = doc_link.from_item_id
        JOIN inventory_docs allocation_doc ON allocation_doc.id = doc_link.to_doc_id
        JOIN visible_docs visible_allocation ON visible_allocation.id = allocation_doc.id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type IN ('门店报货配货', '门店报货赠送配货')
         AND allocation_doc.status IN ('待收货', '已完成')
    ),
    allocation_totals AS (
      SELECT
        root_item_id,
        SUM(CASE WHEN relation_type = '门店报货配货' THEN quantity ELSE 0 END) AS normal_fulfilled_quantity,
        SUM(CASE WHEN relation_type = '门店报货赠送配货' THEN quantity ELSE 0 END) AS gift_fulfilled_quantity
        FROM allocation_links
       GROUP BY root_item_id
    ),
    receipt_links AS (
      SELECT
        allocation_link.root_item_id,
        allocation_link.relation_type AS allocation_relation_type,
        COALESCE(doc_link.quantity, 0) AS quantity
        FROM allocation_links allocation_link
        JOIN inventory_doc_links doc_link
          ON doc_link.from_item_id = allocation_link.allocation_item_id
        JOIN inventory_docs receipt_doc ON receipt_doc.id = doc_link.to_doc_id
       JOIN visible_docs visible_receipt ON visible_receipt.id = receipt_doc.id
       WHERE doc_link.relation_type = '发货收货'
         AND receipt_doc.status = '已完成'
    ),
    receipt_totals AS (
      SELECT
        root_item_id,
        SUM(CASE WHEN allocation_relation_type = '门店报货配货' THEN quantity ELSE 0 END) AS normal_received_quantity,
        SUM(CASE WHEN allocation_relation_type = '门店报货赠送配货' THEN quantity ELSE 0 END) AS gift_received_quantity
        FROM receipt_links
       GROUP BY root_item_id
    )
    SELECT
      root_item.item_id,
      root_item.quantity AS normal_demand_quantity,
      COALESCE(allocation_total.normal_fulfilled_quantity, 0) AS normal_fulfilled_quantity,
      COALESCE(allocation_total.gift_fulfilled_quantity, 0) AS gift_fulfilled_quantity,
      COALESCE(receipt_total.normal_received_quantity, 0) AS normal_received_quantity,
      COALESCE(receipt_total.gift_received_quantity, 0) AS gift_received_quantity
      FROM root_items root_item
      LEFT JOIN allocation_totals allocation_total ON allocation_total.root_item_id = root_item.item_id
      LEFT JOIN receipt_totals receipt_total ON receipt_total.root_item_id = root_item.item_id
     ORDER BY root_item.item_id
  `)
  return {
    kind: '报货履约',
    items: (rows as unknown as ReportFulfillmentQueryRow[])
      .map((row) => reportFulfillmentItem(row, false)),
  }
}

async function loadItemCompanyRequestFulfillmentProgress(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress> {
  const rows = await db.execute(sql`
    WITH visible_docs AS (${visibleInventoryDocsSql(scoped)}),
    request_items AS (
      SELECT item.id AS item_id, item.quantity
        FROM inventory_doc_items item
        JOIN visible_docs request_doc ON request_doc.id = item.doc_id
       WHERE item.doc_id = ${docId}
    ),
    purchase_links AS (
      SELECT
        doc_link.from_item_id AS request_item_id,
        doc_link.to_item_id AS purchase_item_id,
        COALESCE(doc_link.quantity, 0) AS quantity,
        purchase_doc.status AS purchase_status,
        COALESCE(purchase_item.fulfilled_quantity, 0) AS received_quantity
        FROM inventory_doc_links doc_link
        JOIN request_items request_item ON request_item.item_id = doc_link.from_item_id
        JOIN inventory_docs purchase_doc ON purchase_doc.id = doc_link.to_doc_id
        JOIN inventory_doc_items purchase_item ON purchase_item.id = doc_link.to_item_id
        JOIN visible_docs visible_purchase ON visible_purchase.id = purchase_doc.id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '品项公司报货采购订单'
         AND purchase_doc.status IN ('待收货', '已完成', '已取消')
    ),
    purchase_totals AS (
      SELECT
        request_item_id,
        SUM(CASE
          WHEN purchase_status = '已取消' THEN LEAST(quantity, received_quantity)
          ELSE quantity
        END) AS ordered_quantity
        FROM purchase_links
       GROUP BY request_item_id
    ),
    receipt_totals AS (
      SELECT
        purchase_link.request_item_id,
        SUM(COALESCE(doc_link.quantity, 0)) AS received_quantity
        FROM purchase_links purchase_link
        JOIN inventory_doc_links doc_link
          ON doc_link.from_item_id = purchase_link.purchase_item_id
        JOIN inventory_docs receipt_doc ON receipt_doc.id = doc_link.to_doc_id
        JOIN visible_docs visible_receipt ON visible_receipt.id = receipt_doc.id
       WHERE doc_link.relation_type = '采购订单供应链采购入库'
         AND receipt_doc.status = '已完成'
       GROUP BY purchase_link.request_item_id
    )
    SELECT
      request_item.item_id,
      request_item.quantity AS demand_quantity,
      COALESCE(purchase_total.ordered_quantity, 0) AS ordered_quantity,
      COALESCE(receipt_total.received_quantity, 0) AS received_quantity
      FROM request_items request_item
      LEFT JOIN purchase_totals purchase_total ON purchase_total.request_item_id = request_item.item_id
      LEFT JOIN receipt_totals receipt_total ON receipt_total.request_item_id = request_item.item_id
     ORDER BY request_item.item_id
  `)
  return {
    kind: '品项公司报货履约',
    items: (rows as unknown as Array<{
      item_id: number | string
      demand_quantity: string | number | null
      ordered_quantity: string | number | null
      received_quantity: string | number | null
    }>).map((row) => ({
      itemId: Number(row.item_id),
      demandQuantity: numberOrNull(row.demand_quantity) ?? 0,
      orderedQuantity: numberOrNull(row.ordered_quantity) ?? 0,
      receivedQuantity: numberOrNull(row.received_quantity) ?? 0,
    })),
  }
}

async function loadSupplyChainPurchaseReceiptProgress(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress | null> {
  const rows = await db.execute(sql`
    WITH visible_docs AS (${visibleInventoryDocsSql(scoped)}),
    purchase_items AS (
      SELECT item.id AS item_id, item.quantity, purchase_doc.status AS purchase_status
        FROM inventory_doc_items item
        JOIN inventory_docs purchase_doc ON purchase_doc.id = item.doc_id
        JOIN visible_docs visible_purchase ON visible_purchase.id = purchase_doc.id
       WHERE item.doc_id = ${docId}
         AND item.market_id IS NULL
    ),
    receipt_totals AS (
      SELECT
        doc_link.from_item_id AS purchase_item_id,
        SUM(COALESCE(doc_link.quantity, 0)) AS received_quantity
        FROM inventory_doc_links doc_link
        JOIN purchase_items purchase_item ON purchase_item.item_id = doc_link.from_item_id
        JOIN inventory_docs receipt_doc ON receipt_doc.id = doc_link.to_doc_id
        JOIN visible_docs visible_receipt ON visible_receipt.id = receipt_doc.id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '采购订单供应链采购入库'
         AND receipt_doc.status = '已完成'
       GROUP BY doc_link.from_item_id
    )
    SELECT
      purchase_item.item_id,
      purchase_item.quantity AS purchased_quantity,
      COALESCE(receipt_total.received_quantity, 0) AS received_quantity,
      purchase_item.purchase_status
      FROM purchase_items purchase_item
      LEFT JOIN receipt_totals receipt_total ON receipt_total.purchase_item_id = purchase_item.item_id
     ORDER BY purchase_item.item_id
  `)
  // 纯市场行的采购单在上面被 `market_id IS NULL` 过滤成空集，这里返回 null 而不是空进度，
  // 避免详情页渲染出一张「已收货 0」的空表把市场行误导成待收货。
  if (rows.length === 0) return null
  return {
    kind: '供应链采购收货',
    items: (rows as unknown as Array<{
      item_id: number | string
      purchased_quantity: string | number | null
      received_quantity: string | number | null
      purchase_status: InventoryCoreDocStatus
    }>).map((row) => {
      const purchasedQuantity = numberOrNull(row.purchased_quantity) ?? 0
      const receivedQuantity = numberOrNull(row.received_quantity) ?? 0
      return {
        itemId: Number(row.item_id),
        purchasedQuantity,
        receivedQuantity,
        outstandingQuantity: row.purchase_status === '待收货'
          ? Math.max(0, purchasedQuantity - receivedQuantity)
          : 0,
      }
    }),
  }
}

async function loadShipmentReceiptProgress(
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress> {
  const rows = await db.execute(sql`
    WITH visible_docs AS (${visibleInventoryDocsSql(scoped)}),
    shipment_items AS (
      -- visible_docs 只暴露 id；status 必须回表 inventory_docs 取
      -- （曾直接 JOIN visible_docs 取 status 导致发货/配货单详情 42703 全量报错）。
      SELECT item.id AS item_id, item.quantity, shipment_doc.status AS shipment_status
        FROM inventory_doc_items item
        JOIN inventory_docs shipment_doc ON shipment_doc.id = item.doc_id
        JOIN visible_docs visible_shipment ON visible_shipment.id = shipment_doc.id
       WHERE item.doc_id = ${docId}
    ),
    receipt_totals AS (
      SELECT
        doc_link.from_item_id AS shipment_item_id,
        SUM(COALESCE(doc_link.quantity, 0)) AS received_quantity
        FROM inventory_doc_links doc_link
        JOIN shipment_items shipment_item ON shipment_item.item_id = doc_link.from_item_id
        JOIN inventory_docs receipt_doc ON receipt_doc.id = doc_link.to_doc_id
        JOIN visible_docs visible_receipt ON visible_receipt.id = receipt_doc.id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '发货收货'
         AND receipt_doc.status = '已完成'
       GROUP BY doc_link.from_item_id
    )
    SELECT
      shipment_item.item_id,
      shipment_item.quantity AS shipped_quantity,
      COALESCE(receipt_total.received_quantity, 0) AS received_quantity,
      shipment_item.shipment_status
      FROM shipment_items shipment_item
      LEFT JOIN receipt_totals receipt_total ON receipt_total.shipment_item_id = shipment_item.item_id
     ORDER BY shipment_item.item_id
  `)
  return {
    kind: '发货收货',
    items: (rows as unknown as Array<{
      item_id: number | string
      shipped_quantity: string | number | null
      received_quantity: string | number | null
      shipment_status: InventoryCoreDocStatus
    }>).map((row) => {
      const shippedQuantity = numberOrNull(row.shipped_quantity) ?? 0
      const receivedQuantity = numberOrNull(row.received_quantity) ?? 0
      return {
        itemId: Number(row.item_id),
        shippedQuantity,
        receivedQuantity,
        outstandingQuantity: row.shipment_status === '待收货'
          ? Math.max(0, shippedQuantity - receivedQuantity)
          : 0,
      }
    }),
  }
}

async function loadInventoryDocFulfillmentProgress(
  docType: InventoryDocType,
  docId: string,
  scoped: string[] | null,
): Promise<InventoryDocFulfillmentProgress | null> {
  if (docType === '市场报货') return loadMarketReportFulfillmentProgress(docId, scoped)
  if (docType === '门店报货') return loadStoreReportFulfillmentProgress(docId, scoped)
  if (docType === '品项公司报货需求') {
    return loadItemCompanyRequestFulfillmentProgress(docId, scoped)
  }
  // 收敛后只剩 `采购订单` 一种类型，但收货进度只对**供应链行**（market_id IS NULL）有意义：
  // 市场行走的是品项公司发货，不经供应链采购入库。纯市场单在下面的函数里会得到空 items 并返回 null，
  // 与收敛前「市场链路采购单无履约进度」的行为一致。
  if (docType === '采购订单') {
    return loadSupplyChainPurchaseReceiptProgress(docId, scoped)
  }
  if (docType === '品项公司发货' || docType === '分院配货') {
    return loadShipmentReceiptProgress(docId, scoped)
  }
  return null
}

export const getInventoryCoreDocById = withPermission(
  'inventory:list',
  async (session, id: string): Promise<InventoryDocDetail | null> => {
    const priceTiers = inventoryPriceScopeByTier(session)
    const scoped = inventoryScopedOrgNodeIds(session)
    const conditions: (SQL | undefined)[] = [eq(inventoryDocs.id, id)]
    if (scoped !== null) {
      conditions.push(scoped.length > 0
        ? or(inArray(inventoryDocs.sourceOrgNodeId, scoped), inArray(inventoryDocs.targetOrgNodeId, scoped))
        : sql`FALSE`)
    }
    const [headRow] = await db
      .select({
        doc: inventoryDocs,
        sourceOrgNodeName: sourceLocation.name,
        sourceOrgNodeType: sourceLocation.locationType,
        targetOrgNodeName: targetLocation.name,
        targetOrgNodeType: targetLocation.locationType,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(and(...conditions))
      .limit(1)
    if (!headRow) return null
    // 行级档位（§9.3/§9.5）：金额可见性按单据 source/target 端点命中该档位绑定的
    // org 集合判定（与单据可见性同构），防混合绑定会话跨绑定借权看价。
    const priceVisibility = inventoryPriceVisibilityForOrgNodes(
      priceTiers,
      [headRow.doc.sourceOrgNodeId, headRow.doc.targetOrgNodeId],
    )
    const head = docRow({ ...headRow, includePrice: priceVisibility !== 'none' })
    // 无金额单据类型（§5.3/§10.4）所有价格/折扣/成本/金额字段一律遮蔽（含 admin）：
    // 明细可能残留历史价格快照（DB 保留供入库/退货/审计追溯），业务响应统一不返回。
    const itemPriceVisibility: import('./types').InventoryPriceVisibility =
      AMOUNTLESS_DOC_TYPES.has(head.docType) ? 'none' : priceVisibility
    const includeItemAmount = itemPriceVisibility !== 'none'
    const [items, lineage, fulfillmentProgress] = await Promise.all([
      db
        .select()
        .from(inventoryDocItems)
        .where(eq(inventoryDocItems.docId, id))
        .orderBy(asc(inventoryDocItems.id)),
      loadInventoryDocLineage(id, scoped),
      loadInventoryDocFulfillmentProgress(head.docType, id, scoped),
    ])
    // 采购订单与市场报货汇总把市场归属挂在明细行上（#193/#194），单头没有这个字段，
    // 详情页要显示市场名就得按行解析一次。只在真有行级市场时才查。
    const itemMarketIds = [...new Set(items.map((item) => item.marketId).filter((id): id is string => Boolean(id)))]
    const itemMarketNameByOrgNodeId = new Map(
      itemMarketIds.length > 0
        ? (await db
          .select({ orgNodeId: inventoryLocations.orgNodeId, name: inventoryLocations.name })
          .from(inventoryLocations)
          .where(inArray(inventoryLocations.orgNodeId, itemMarketIds))
        ).map((row) => [row.orgNodeId, row.name])
        : [],
    )
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
        supplierId: item.supplierId,
        marketId: item.marketId,
        marketName: item.marketId
          ? (itemMarketNameByOrgNodeId.get(item.marketId) ?? item.marketId)
          : null,
        productSeries: item.productSeries,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        isGift: item.isGift,
        quantity: Number(item.quantity),
        stockSnapshot: numberOrNull(item.stockSnapshot),
        requestQuantity: numberOrNull(item.requestQuantity),
        fulfilledQuantity: numberOrNull(item.fulfilledQuantity),
        standardUnitPrice: itemPriceVisibility !== 'none' ? numberOrNull(item.standardUnitPrice) : undefined,
        unitDiscount: itemPriceVisibility !== 'none' ? numberOrNull(item.unitDiscount) : undefined,
        actualUnitPrice: itemPriceVisibility !== 'none' ? numberOrNull(item.actualUnitPrice) : undefined,
        amount: includeItemAmount ? numberOrNull(item.amount) : undefined,
        supplyChainUnitCost: itemPriceVisibility === 'all' || itemPriceVisibility === 'supply_chain' ? numberOrNull(item.supplyChainUnitCost) : undefined,
        marketActualUnitPrice: itemPriceVisibility !== 'none' ? numberOrNull(item.marketActualUnitPrice) : undefined,
        storeActualUnitPrice: itemPriceVisibility === 'all' || itemPriceVisibility === 'market' ? numberOrNull(item.storeActualUnitPrice) : undefined,
        promotionPlanId: item.promotionPlanId,
        promotionPlanNoSnapshot: item.promotionPlanNoSnapshot,
        promotionPlanNameSnapshot: item.promotionPlanNameSnapshot,
        promotionRuleTypeSnapshot: item.promotionRuleTypeSnapshot as '单品阶梯' | '组合' | null,
        promotionSelectionMode: item.promotionSelectionMode as '系统推荐' | '人工选择' | null,
        reason: item.reason,
        remark: item.remark,
        createdAt: item.createdAt.toISOString(),
      })),
      lineage,
      fulfillmentProgress,
    }
  },
)

export const createInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_operate', 'inventory:market_operate', 'inventory:store_operate'],
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
    /**
     * 盘点单：一个 SKU 只能一行。账面数按「主体 + SKU 汇总」记（#131 Q1），同 SKU 两行会
     * 各自拿到**同一个**完整账面数，差异列直接变成重复计算的废数。
     * 放在开事务前拦——失败不占那把全局的 cutover 行锁。
     * 只对盘点单生效；其余单据的重复行语义（同 SKU 不同批次）保持不变。
     */
    const stocktakeSkuIds: string[] = []
    if (STOCKTAKE_DOC_TYPES.has(input.docType)) {
      const seen = new Set<string>()
      for (const item of input.items) {
        const skuId = normalizeRequired(item.skuId, '库存 SKU')
        if (seen.has(skuId)) {
          throw new ApiError('INVALID_PARAMS', '同一 SKU 请合并为一条盘点明细')
        }
        seen.add(skuId)
        stocktakeSkuIds.push(skuId)
      }
    }
    let sourceOrgNodeId = normalizeText(input.sourceOrgNodeId)
    let targetOrgNodeId = normalizeText(input.targetOrgNodeId)
    if (INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)) {
      const orgNodeId = sourceOrgNodeId ?? targetOrgNodeId
      sourceOrgNodeId = orgNodeId
      targetOrgNodeId = orgNodeId
    }
    if (RECEIVE_REQUIRED_DOC_TYPES.has(input.docType) && !targetOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '待收货单据缺少接收主体')
    }
    const actingOrgNodeId = sourceOrgNodeId ?? targetOrgNodeId
    if (!actingOrgNodeId) throw new ApiError('INVALID_PARAMS', '缺少当前操作组织节点')
    const sourceLocationRow = sourceOrgNodeId ? await ensureOrgNodeLocation(sourceOrgNodeId) : null
    const targetLocationRow = targetOrgNodeId ? await ensureOrgNodeLocation(targetOrgNodeId) : null
    const actingLocationId = sourceOrgNodeId === actingOrgNodeId
      ? sourceLocationRow?.locationId
      : targetLocationRow?.locationId
    if (!actingLocationId) throw new ApiError('NOT_FOUND', '组织节点没有对应库存主体')
    await assertOrgNodeVisible(session, actingOrgNodeId)

    const plan = movementPlan(input.docType, status)
    if (plan?.locationRole === 'source' && !sourceOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '出库类单据缺少出库主体')
    }
    if (plan?.locationRole === 'target' && !targetOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '入库类单据缺少入库主体')
    }
    await assertGenericDocLocationRules(input, sourceOrgNodeId, targetOrgNodeId, actingOrgNodeId)

    const totalQuantity = input.items.reduce((sum, item) => sum + assertPositiveQuantity(item.quantity), 0)

    const id = await db.transaction(async (tx) => {
      await assertInventoryBusinessWritable(tx)
      const docId = await generateDocNo(tx, input.docType)
      await tx.insert(inventoryDocs).values({
        id: docId,
        docType: input.docType,
        status,
        sourceOrgNodeId,
        targetOrgNodeId,
        // 市场归属由数据库根据源/目标库存主体统一派生，禁止信任调用方传值。
        marketId: null,
        supplierId: normalizeText(input.supplierId),
        docDate: normalizeText(input.docDate) ?? shanghaiToday(),
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
        totalAmount: null,
        remark: normalizeText(input.remark),
        createdBy: session.employeeId,
        confirmedBy: status === '已完成' || status === '待收货' ? session.employeeId : null,
        confirmedAt: status === '已完成' || status === '待收货' ? new Date() : null,
      })

      let calculatedTotalAmount = 0
      let hasCalculatedAmount = false
      // 盘点账面数：一次取齐（见 skuOnHandByLocation 的注释：串行点 + 单一时点语义）
      const bookQuantityBySkuId = await skuOnHandByLocation(tx, actingLocationId, stocktakeSkuIds)
      for (const item of input.items) {
        const quantity = assertPositiveQuantity(item.quantity)
        // 通用入口只接收库存事实；所有价格与金额从 SKU/锁定批次快照派生。
        const serverItem = stripPriceInput(item)
        let lot: LockedLot | null = null
        /** 盘点单的账面数（主体 + SKU 在手量汇总）；非盘点单保持 null，行为与改前一致 */
        let bookQuantity: number | null = null
        let snapshot: Pick<LockedLot, 'skuId' | 'skuName' | 'specName' | 'supplier' | 'productSeries'> & Partial<LockedLot>
        const shouldCaptureSourceLot =
          plan?.locationRole === 'source' ||
          (status === '待审批' && OUTBOUND_DOC_TYPES.has(input.docType))

        if (shouldCaptureSourceLot) {
          if (!serverItem.lotId) throw new ApiError('INVALID_PARAMS', '出库类明细必须选择库存批次')
          const sourceLocationId = sourceLocationRow?.locationId
          if (!sourceLocationId) throw new ApiError('INVALID_STATE', '出库组织节点没有对应库存主体')
          lot = await lockLotById(tx, serverItem.lotId, sourceLocationId)
          await assertSkuIdAvailableAtLocation(tx, lot.skuId, sourceLocationId)
          if (input.docType === '市场间调货出库' && targetOrgNodeId) {
            await assertSkuIdAvailableAtLocation(tx, lot.skuId, targetLocationRow!.locationId)
          }
          snapshot = lot
        } else if (plan?.locationRole === 'target') {
          if (!targetLocationRow) throw new ApiError('INVALID_STATE', '入库组织节点没有对应库存主体')
          lot = await ensureLotFromSku(tx, targetLocationRow.locationId, serverItem, {
            sourceDocId: docId,
            supplierId: normalizeText(input.supplierId),
            supplier: normalizeText(input.supplierName),
          })
          snapshot = lot
        } else {
          const skuId = normalizeRequired(serverItem.skuId, '库存 SKU')
          await assertSkuIdAvailableAtLocation(tx, skuId, actingLocationId)
          snapshot = await skuSnapshot(tx, skuId)
          if (STOCKTAKE_DOC_TYPES.has(input.docType)) {
            // 盘点单没有批次选择器，`lot` 恒为 null —— 账面数只能来自上面一次取齐的汇总。
            // 不写的话 `stock_snapshot` 恒 NULL，盘点单就退化成一张只有「实盘数」的白条。
            // 取不到 = 该 SKU 在该主体一个批次都没有 → 账上就是 0（不是「没记」）。
            bookQuantity = bookQuantityBySkuId.get(skuId) ?? 0
          }
        }

        const standardUnitPrice =
          lot?.storeStandardUnitPrice ??
          lot?.marketStandardUnitPrice ??
          lot?.supplyChainUnitCost ??
          null
        const unitDiscount =
          lot?.storeUnitDiscount ??
          lot?.marketUnitDiscount ??
          null
        const actualUnitPrice =
          lot?.storeActualUnitPrice ??
          lot?.marketActualUnitPrice ??
          lot?.supplyChainUnitCost ??
          (standardUnitPrice == null ? null : standardUnitPrice - Number(unitDiscount ?? 0))
        const amount = calculateAmount(actualUnitPrice, quantity)
        if (amount !== null) {
          calculatedTotalAmount += amount
          hasCalculatedAmount = true
        }
        const [createdItem] = await tx
          .insert(inventoryDocItems)
          .values({
            docId,
            lotId: lot?.id ?? null,
            skuId: snapshot.skuId,
            saleItemId: normalizeText(serverItem.saleItemId),
            skuName: snapshot.skuName,
            specName: snapshot.specName,
            supplier: snapshot.supplier,
            productSeries: snapshot.productSeries,
            batchNo: lot?.batchNo ?? normalizeText(serverItem.batchNo) ?? '',
            expiryDate: lot?.expiryDate ?? normalizeText(serverItem.expiryDate),
            isGift: lot?.isGift ?? Boolean(serverItem.isGift),
            quantity: String(quantity),
            stockSnapshot: lot ? String(lot.quantityOnHand) : numString(bookQuantity),
            requestQuantity: numString(serverItem.requestQuantity),
            fulfilledQuantity: numString(serverItem.fulfilledQuantity),
            standardUnitPrice: numString(standardUnitPrice),
            unitDiscount: numString(unitDiscount),
            actualUnitPrice: numString(actualUnitPrice),
            amount: numString(amount),
            supplyChainUnitCost: numString(lot?.supplyChainUnitCost ?? null),
            marketStandardUnitPrice: numString(lot?.marketStandardUnitPrice ?? null),
            marketUnitDiscount: numString(lot?.marketUnitDiscount ?? null),
            marketActualUnitPrice: numString(lot?.marketActualUnitPrice ?? null),
            storeStandardUnitPrice: numString(lot?.storeStandardUnitPrice ?? null),
            storeUnitDiscount: numString(lot?.storeUnitDiscount ?? null),
            storeActualUnitPrice: numString(lot?.storeActualUnitPrice ?? null),
            reason: normalizeText(serverItem.reason),
            remark: normalizeText(serverItem.remark),
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

      await tx
        .update(inventoryDocs)
        .set({
          totalAmount: hasCalculatedAmount ? numString(calculatedTotalAmount) : null,
          updatedAt: new Date(),
        })
        .where(eq(inventoryDocs.id, docId))

      return docId
    })

    await logOperation(session, 'create', 'inventory_docs', id, {
      docType: input.docType,
      sourceOrgNodeId,
      targetOrgNodeId,
      totalQuantity,
    })
    revalidatePath('/inventory')
    revalidatePath('/inventory/docs')
    revalidatePath('/inventory/stocks')
    return { success: true, id }
  },
)

export const approveInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (session, id: string, auditRemark?: string | null): Promise<{ success: true }> => {
    const docId = normalizeRequired(id, '单据号')
    await db.transaction(async (tx) => {
      await assertInventoryBusinessWritable(tx)
      const headRows = await tx.execute(sql`
        SELECT id, doc_type, status, source_org_node_id
          FROM inventory_docs
         WHERE id = ${docId}
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_org_node_id: string | null
      }>)[0]
      if (!head) throw new ApiError('NOT_FOUND', '库存单据不存在')
      assertGenericDocTransition(head.doc_type)
      if (head.status !== '待审批') throw new ApiError('INVALID_STATE', '只有待审批单据可以审批')
      if (!OUTBOUND_DOC_TYPES.has(head.doc_type)) {
        throw new ApiError('INVALID_STATE', '该单据类型不需要审批扣减库存')
      }
      if (!head.source_org_node_id) throw new ApiError('INVALID_STATE', '审批单据缺少出库主体')
      await assertOrgNodeVisible(session, head.source_org_node_id)
      const sourceLocationId = await orgNodeLocationIdForUpdate(tx, head.source_org_node_id)

      const items = await tx.execute(sql`
        SELECT id, lot_id, quantity
          FROM inventory_doc_items
         WHERE doc_id = ${docId}
         ORDER BY id
      `)
      for (const item of items as unknown as Array<{ id: number; lot_id: number | null; quantity: string | number }>) {
        if (!item.lot_id) throw new ApiError('INVALID_STATE', '单据明细缺少库存批次')
        const lot = await lockLotById(tx, Number(item.lot_id), sourceLocationId)
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

export const rejectInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (session, id: string, auditRemark?: string | null): Promise<{ success: true }> => {
    const docId = normalizeRequired(id, '单据号')
    await db.transaction(async (tx) => {
      await assertInventoryBusinessWritable(tx)
      const rows = await tx.execute(sql`
        SELECT doc_type, status, source_org_node_id, target_org_node_id
          FROM inventory_docs
         WHERE id = ${docId}
         FOR UPDATE
      `)
      const doc = (rows as unknown as Array<{
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_org_node_id: string | null
        target_org_node_id: string | null
      }>)[0]
      if (!doc) throw new ApiError('NOT_FOUND', '库存单据不存在')
      assertGenericDocTransition(doc.doc_type)
      if (doc.status !== '待审批') throw new ApiError('INVALID_STATE', '只有待审批单据可以驳回')
      await assertOrgNodeVisible(session, doc.source_org_node_id ?? doc.target_org_node_id ?? '')

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

export const confirmInventoryCoreReceive = withAnyPermission(
  ['inventory:market_operate', 'inventory:store_operate'],
  async (session, outboundDocId: string, remark?: string | null): Promise<{ success: true; inboundDocId: string }> => {
    const id = normalizeRequired(outboundDocId, '出库单号')
    let inboundDocId = ''
    await db.transaction(async (tx) => {
      await assertInventoryBusinessWritable(tx)
      const headRows = await tx.execute(sql`
        SELECT id, doc_type, status, source_org_node_id, target_org_node_id,
               total_quantity, remark
          FROM inventory_docs
         WHERE id = ${id}
         FOR UPDATE
      `)
      const head = (headRows as unknown as Array<{
        id: string
        doc_type: InventoryDocType
        status: InventoryCoreDocStatus
        source_org_node_id: string | null
        target_org_node_id: string | null
        total_quantity: string | number
        remark: string | null
      }>)[0]
      if (!head) throw new ApiError('NOT_FOUND', '出库单不存在')
      assertGenericDocTransition(head.doc_type)
      if (head.status !== '待收货') throw new ApiError('INVALID_STATE', '该单据不是待收货状态')
      const inboundType = RECEIVE_INBOUND_TYPE[head.doc_type]
      if (!inboundType) throw new ApiError('INVALID_STATE', '该单据类型不支持收货确认')
      if (!head.target_org_node_id) throw new ApiError('INVALID_STATE', '出库单缺少收货主体')
      if (head.doc_type === '分院调货出库') {
        await assertSameMarketForStoreTransfer(head.source_org_node_id, head.target_org_node_id)
      } else if (head.doc_type === '市场间调货出库') {
        await assertMarketTransferLocations(head.source_org_node_id, head.target_org_node_id)
      }
      await assertOrgNodeVisible(session, head.target_org_node_id)
      const targetLocationId = await orgNodeLocationIdForUpdate(tx, head.target_org_node_id)

      inboundDocId = await generateDocNo(tx, inboundType)
      await tx.insert(inventoryDocs).values({
        id: inboundDocId,
        docType: inboundType,
        status: '已完成',
        sourceOrgNodeId: head.source_org_node_id,
        targetOrgNodeId: head.target_org_node_id,
        docDate: shanghaiToday(),
        totalQuantity: String(head.total_quantity),
        remark: normalizeText(remark) ?? head.remark,
        createdBy: session.employeeId,
        confirmedBy: session.employeeId,
        confirmedAt: new Date(),
      })

      const itemRows = await tx.execute(sql`
        SELECT item.id AS source_item_id, item.sku_id, item.batch_no, item.expiry_date, item.is_gift, item.quantity,
               item.standard_unit_price, item.unit_discount, item.actual_unit_price, item.amount,
               item.supply_chain_unit_cost, item.market_standard_unit_price, item.market_unit_discount,
               item.market_actual_unit_price, item.store_standard_unit_price, item.store_unit_discount,
               item.store_actual_unit_price, item.reason, item.remark,
               source_lot.supplier_id AS source_supplier_id,
               source_lot.source_doc_id AS source_doc_id,
               source_lot.supplier AS source_supplier
          FROM inventory_doc_items item
          LEFT JOIN inventory_stock_lots source_lot ON source_lot.id = item.lot_id
         WHERE item.doc_id = ${id}
         ORDER BY item.id
      `)
      for (const item of itemRows as unknown as Array<{
        source_item_id: number
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
        source_supplier_id: string | null
        source_doc_id: string | null
        source_supplier: string | null
      }>) {
        const lot = await ensureLotFromSku(tx, targetLocationId, {
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
        }, {
          sourceDocId: item.source_doc_id ?? id,
          supplierId: item.source_supplier_id,
          supplier: item.source_supplier,
        })
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
        await tx.insert(inventoryDocLinks).values({
          fromDocId: id,
          toDocId: inboundDocId,
          relationType: '发货收货',
          fromItemId: Number(item.source_item_id),
          toItemId: createdItem.id,
          quantity: String(item.quantity),
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

/**
 * 把 `uq_inventory_suppliers_name` 的唯一约束冲突翻成可读业务错误（#132）。
 *
 * 不翻的话用户看到的是 fallback「创建供应商失败」：PG 原文是英文，而
 * `action-error.ts` 既把 `violates unique constraint` 列进 UNREADABLE_FRAGMENTS，
 * 又有「一整串没有中日韩字符就判为不可读」的兜底 —— 两道都拦。
 *
 * 文案必须点出「可能已被停用」：停用的档案既不在 SKU 表单的下拉里
 * （`listInventorySupplierOptions` 只查启用中的），默认也不在供应商列表里，
 * 用户撞上它时**没有任何入口能自己查明原因**，只会反复重试同一个名字。
 */
function supplierNameConflict(error: unknown, name: string): unknown {
  if (pgErrorCode(error) === '23505') {
    return new ApiError('CONFLICT', `供应商名称「${name}」已存在（可能是已停用的档案），请到供应商档案页查找`)
  }
  return error
}

function supplierRow(
  row: typeof inventorySuppliers.$inferSelect & { linkedSkuCount: number },
): InventorySupplierRow {
  return {
    supplierId: row.supplierId,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    address: row.address,
    isActive: row.isActive,
    remark: row.remark,
    linkedSkuCount: row.linkedSkuCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 供应商列表（#135 起返回 `{ data, total }`）。
 *
 * **`pageSize` 不给就不分页**，整份返回 —— 办理台的供应商下拉走的是同一个函数
 * （operations/[level]/page.tsx），默认塞一个页长进去会把下拉静默截断，
 * 用户在「自采产品入库」里就选不到排在后面的供应商了。
 */
export const listInventorySuppliers = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: { keyword?: string; onlyActive?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<{ data: InventorySupplierRow[]; total: number }> => {
    const conditions: (SQL | undefined)[] = []
    // 三态：undefined = 全部 / true = 仅启用 / false = 仅停用。
    // 原写法用 `?? true` 兜底，把三态压成了二值 ——
    // 「全部状态」(undefined) 变成只返回启用、「停用」(false) 变成返回全部，
    // 页面上三个选项里有两个行为与标签不符，「停用」那档永远筛不出停用的供应商。
    // 这是存量缺陷，但本次新增的「共 N 条」会把这个错误结果的数量白纸黑字印出来，顺手修。
    if (filters.onlyActive === true) conditions.push(eq(inventorySuppliers.isActive, true))
    else if (filters.onlyActive === false) conditions.push(eq(inventorySuppliers.isActive, false))
    if (filters.keyword) {
      const pattern = `%${filters.keyword.replace(/[%_]/g, '\\$&')}%`
      conditions.push(or(
        ilike(inventorySuppliers.name, pattern),
        ilike(inventorySuppliers.contactName, pattern),
        ilike(inventorySuppliers.phone, pattern),
      ))
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    // 总数**不能**在 leftJoin 之后 count：join 会把一个供应商放大成 N 行（N = 关联 SKU 数），
    // 「共 N 条」会比实际行数大一截。筛选条件只涉及 inventory_suppliers 自身的列，
    // 所以直接对主表单独 count 既准确又比 count(distinct) 便宜。
    const [totalRow] = await db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(inventorySuppliers)
      .where(whereClause)

    const query = db
      .select({
        supplier: inventorySuppliers,
        // 停用前要提示「仍有 N 个 SKU 在用」（#132）。含已停用的 SKU：
        // 停用供应商不该因为 SKU 也停了就把关联当不存在。
        linkedSkuCount: sql<number>`cast(count(${inventorySkus.skuId}) as int)`,
      })
      .from(inventorySuppliers)
      .leftJoin(inventorySkus, eq(inventorySkus.supplierId, inventorySuppliers.supplierId))
      .where(whereClause)
      .groupBy(inventorySuppliers.supplierId)
      .orderBy(asc(inventorySuppliers.name))

    // pageSize 缺省仍是「不分页」（办理台下拉共用本函数），但**一旦给了值就必须过白名单**：
    // `?size=7` 会让服务端每页 7 条而 UI 按 20 条算页数，尾部数据永远够不到；
    // `?size=-5` 更糟 —— drizzle 会静默丢弃负 limit 却照发负 offset，PG 直接
    // `OFFSET must not be negative`，生产脱敏后只剩一个通用 500 页。
    // `page` 用 `|| 1` 而不是 `?? 1`：`?page=abc` 的 NaN 是 falsy，`??` 兜不住。
    const pageSize = filters.pageSize === undefined
      ? undefined
      : (PAGE_SIZE_WHITELIST.includes(filters.pageSize) ? filters.pageSize : 20)
    const rows = pageSize
      ? await query.limit(pageSize).offset((normalizePage(filters.page) - 1) * pageSize)
      : await query
    return {
      data: rows.map((row) => supplierRow({ ...row.supplier, linkedSkuCount: row.linkedSkuCount })),
      total: totalRow?.total ?? 0,
    }
  },
)

/**
 * SKU 表单的供应商下拉选项（#132）：只返回**启用中**的档案，且只带 id + 名称。
 *
 * 「当前 SKU 已关联但档案已停用」那一条不在这里补 —— 它由 `InventorySkuRow` 自带的
 * `supplierId` / `supplierName` 在表单侧补进选项，这样与当前行绑定、不依赖列表分页。
 */
export const listInventorySupplierOptions = withPermission(
  'inventory:stock_list',
  async (): Promise<InventorySupplierOption[]> => {
    return db
      .select({ supplierId: inventorySuppliers.supplierId, name: inventorySuppliers.name })
      .from(inventorySuppliers)
      .where(eq(inventorySuppliers.isActive, true))
      .orderBy(asc(inventorySuppliers.name))
  },
)

/**
 * 停用前实时核对关联 SKU 数（#132）。
 *
 * 列表行自带的 `linkedSkuCount` 是**页面加载那一刻**的值：别人在这期间把某个 SKU 关联过来，
 * 用旧计数就会显示「0 个」而不给提示，验收标准要的「明确提示」就落空了。
 */
export const countInventorySkusBySupplier = withPermission(
  'inventory:stock_list',
  async (_session, supplierIdInput: string): Promise<number> => {
    const supplierId = normalizeRequired(supplierIdInput, '供应商')
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventorySkus)
      .where(eq(inventorySkus.supplierId, supplierId))
    return row?.count ?? 0
  },
)

export const createInventorySupplier = withPermission(
  'inventory:supply_chain_master_data_manage',
  async (session, input: InventorySupplierInput): Promise<{ supplierId: string }> => {
    const supplierId = `INV-SUP-${crypto.randomUUID()}`
    const name = normalizeRequired(input.name, '供应商名称')
    try {
      await db.insert(inventorySuppliers).values({
        supplierId,
        name,
        contactName: normalizeText(input.contactName),
        phone: normalizeText(input.phone),
        address: normalizeText(input.address),
        isActive: input.isActive ?? true,
        remark: normalizeText(input.remark),
      })
    } catch (error) {
      throw supplierNameConflict(error, name)
    }
    await logOperation(session, 'inventory.supplier.create', 'inventory_suppliers', supplierId, { name })
    revalidatePath('/inventory/suppliers')
    return { supplierId }
  },
)

export const updateInventorySupplier = withPermission(
  'inventory:supply_chain_master_data_manage',
  async (
    session,
    supplierIdInput: string,
    input: Partial<InventorySupplierInput>,
  ): Promise<{ success: true }> => {
    const supplierId = normalizeRequired(supplierIdInput, '供应商')
    const [current] = await db
      .select({ supplierId: inventorySuppliers.supplierId, name: inventorySuppliers.name })
      .from(inventorySuppliers)
      .where(eq(inventorySuppliers.supplierId, supplierId))
      .limit(1)
    if (!current) throw new ApiError('NOT_FOUND', '供应商不存在')
    const nextName = input.name === undefined ? undefined : normalizeRequired(input.name, '供应商名称')
    try {
      await db.transaction(async (tx) => {
        // 在事务内**锁行重读**名字，不能拿上面那次事务外的 current.name 来判断改没改名。
        // 时序：甲乙同时打开编辑页（都读到名字 A）→ 甲改名 B 并同步了所有关联 SKU →
        // 乙只改电话，但表单是全量提交、name 仍是 A → 乙把档案名写回 A，
        // 而 `A === current.name(A)` 用旧快照判成「没改名」→ 跳过 SKU 回写 →
        // 档案叫 A、SKU 文本留在 B，持久分叉（admin 列表走 JOIN 显示 A，staff 读文本显示 B）。
        // FOR UPDATE 让乙等甲提交后再读，于是读到 B、判定「名字变了」、正确回写成 A。
        const [locked] = await tx
          .select({ name: inventorySuppliers.name })
          .from(inventorySuppliers)
          .where(eq(inventorySuppliers.supplierId, supplierId))
          .limit(1)
          .for('update')
        if (!locked) throw new ApiError('NOT_FOUND', '供应商不存在')
        await tx
          .update(inventorySuppliers)
          .set({
            name: nextName,
            contactName: input.contactName === undefined ? undefined : normalizeText(input.contactName),
            phone: input.phone === undefined ? undefined : normalizeText(input.phone),
            address: input.address === undefined ? undefined : normalizeText(input.address),
            isActive: input.isActive,
            remark: input.remark === undefined ? undefined : normalizeText(input.remark),
            updatedAt: new Date(),
          })
          .where(eq(inventorySuppliers.supplierId, supplierId))
        // 改名要同步 SKU 上的名称快照（#132）。`inventory_skus.supplier` 是**主数据字段**，
        // 不是历史快照 —— 真正的历史快照是 inventory_doc_items / inventory_stock_lots 上那两列，
        // 它们在建单 / 建批次时冻结，本处不动。
        // 不同步的话：admin 列表读 JOIN 出来的实时名，而 staffApi 的 SKU 列表
        //（routes/inventory.js 的 `SELECT sku.supplier`）与 ensureLotFromSku 之后建的新批次
        // 读的都是这个文本列 —— 同一个供应商在两端会显示成两个名字。
        // 比的是**新旧名是否真的不同**，不是「有没有传 name」：供应商表单是全量提交，
        // 停用 / 只改联系方式时 name 照样在 payload 里，只判 undefined 等于每次都回写，
        // 会无因刷掉整批关联 SKU 的 updated_at。旧名取事务内锁到的值（见上）。
        if (nextName !== undefined && nextName !== locked.name) {
          // 这会把 N 条关联 SKU 的 updated_at 一起刷新。**是刻意的**：这些行的数据确实变了，
          // 不刷的话基于 updated_at 的增量同步/变更检测会漏掉这次改名。
          // 代价是若将来把 SKU 列表改成 admin 的默认惯例 `desc(updatedAt)`「编辑即浮顶」，
          // 一次改名会让整批 SKU 无因浮顶 —— 当前列表按 product_code 排序，不受影响。
          await tx
            .update(inventorySkus)
            .set({ supplier: nextName, updatedAt: new Date() })
            .where(eq(inventorySkus.supplierId, supplierId))
        }
      })
    } catch (error) {
      throw supplierNameConflict(error, nextName ?? current.name)
    }
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

function normalizePromotionRuleType(value: unknown): InventoryPromotionRuleType {
  if (value === undefined || value === null || value === '') return '单品阶梯'
  if (value === '单品阶梯' || value === '组合') return value
  throw new ApiError('INVALID_PARAMS', '福利方案规则类型无效')
}

function normalizePromotionItems(
  items: InventoryPromotionPlanItemInput[],
  ruleType: InventoryPromotionRuleType,
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

  if (ruleType === '组合') {
    if (normalized.length < 2) {
      throw new ApiError('INVALID_PARAMS', '组合福利至少需要两条不同产品明细')
    }
    const duplicateSkuIds = new Set<string>()
    for (const item of normalized) {
      if (duplicateSkuIds.has(item.skuId)) {
        throw new ApiError('INVALID_PARAMS', '组合福利中同一产品只能出现一次')
      }
      duplicateSkuIds.add(item.skuId)
      if (item.reportMinQuantity === null) {
        throw new ApiError('INVALID_PARAMS', '组合福利必须填写每个产品的数量下限')
      }
    }
    return normalized
  }

  // 单品阶梯的同一产品数量区间必须互斥，避免市场报货时出现两条同优先级的取价规则。
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
      ruleType: inventoryPromotionPlans.ruleType,
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
    ruleType: normalizePromotionRuleType(plan.ruleType),
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

/**
 * 福利方案列表 —— **刻意保持全量返回**，分页在组件侧做（#135）。
 *
 * 这一页的关键词 / 市场 / 状态三个筛选都在客户端 useMemo 里算
 * （inventory-promotions-page.tsx 的 filteredRows）。要是在这里先按页切 20 条、
 * 再让客户端去筛，用户筛到的就只是当前页那 20 条里的匹配项，翻页还会看到不同结果 ——
 * 分页必须发生在筛选**之后**。方案是低基数配置数据，全量返回代价可忽略。
 */
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

export const createInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
  async (session, input: InventoryPromotionPlanInput): Promise<{ id: string }> => {
    assertPromotionPriceWritable(session)
    const name = normalizeRequired(input.name, '方案名称')
    const startsAt = normalizeYmd(input.startsAt, '开始日期')
    const endsAt = normalizeYmd(input.endsAt, '结束日期')
    const ruleType = normalizePromotionRuleType(input.ruleType)
    if (endsAt < startsAt) throw new ApiError('INVALID_PARAMS', '结束日期不能早于开始日期')
    if (input.status && input.status !== '启用' && input.status !== '停用') {
      throw new ApiError('INVALID_PARAMS', '福利方案状态无效')
    }
    const scopeMarketId = await assertPromotionMarketScope(session, input.scopeMarketId)
    const items = normalizePromotionItems(input.items, ruleType)
    await assertPromotionSkus(items)
    const id = `INV-PROMO-${crypto.randomUUID()}`
    let planNo = ''
    await db.transaction(async (tx) => {
      planNo = await generateInventoryPromotionNo(tx)
      await tx.insert(inventoryPromotionPlans).values({
        id,
        planNo,
        name,
        startsAt,
        endsAt,
        scopeMarketId,
        ruleType,
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
    await logOperation(session, 'inventory.promotion.create', 'inventory_promotion_plans', id, { planNo, scopeMarketId, ruleType })
    revalidatePath('/inventory/promotions')
    return { id }
  },
)

export const updateInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
  async (
    session,
    idInput: string,
    input: InventoryPromotionPlanInput,
  ): Promise<{ success: true }> => {
    assertPromotionPriceWritable(session)
    const id = normalizeRequired(idInput, '福利方案')
    const name = normalizeRequired(input.name, '方案名称')
    const startsAt = normalizeYmd(input.startsAt, '开始日期')
    const endsAt = normalizeYmd(input.endsAt, '结束日期')
    const ruleType = normalizePromotionRuleType(input.ruleType)
    if (endsAt < startsAt) throw new ApiError('INVALID_PARAMS', '结束日期不能早于开始日期')
    if (input.status && input.status !== '启用' && input.status !== '停用') {
      throw new ApiError('INVALID_PARAMS', '福利方案状态无效')
    }
    const current = (await promotionPlanRows(session, id))[0]
    if (!current) throw new ApiError('NOT_FOUND', '福利方案不存在或无权查看')
    const scopeMarketId = await assertPromotionMarketScope(session, input.scopeMarketId)
    const items = normalizePromotionItems(input.items, ruleType)
    await db.transaction(async (tx) => {
      const currentScopeMarketId = await lockPromotionPlanScopeForMutation(tx, id)
      await assertPromotionPlanMutableScope(session, currentScopeMarketId)
      await assertPromotionSkus(items)
      await tx
        .update(inventoryPromotionPlans)
        .set({
          name,
          startsAt,
          endsAt,
          scopeMarketId,
          ruleType,
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
    await logOperation(session, 'inventory.promotion.update', 'inventory_promotion_plans', id, { planNo: current.planNo, scopeMarketId, ruleType })
    revalidatePath('/inventory/promotions')
    return { success: true }
  },
)

export const disableInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
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
