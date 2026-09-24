import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode } from '@/lib/pg-error'
import { rowsAffected } from '@/lib/pg-rows'
import { cancelledMarketReportRetainedSql } from './retained-sql'
import { fmtDate, shanghaiToday, shanghaiYmd } from '@/lib/datetime'
import { logOperation } from '@/lib/operation-log'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { resolvePaging } from '@/lib/paging'
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
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { AuthSession } from '@/lib/types'
import { assertInventoryBusinessWritable } from './cutover'
import {
  INVENTORY_CORE_RECEIVE_ACTIONS,
  genericDocBusinessLevel,
  inventoryDelegatableOperateActions,
  inventoryLevelOperateDeniedMessage,
} from './business-level'
import { scopeSessionToActions } from '@/lib/action-scope'
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
  type InventoryMarketTransferTarget,
  type InventoryLocationFilterOptions,
  type InventoryLocationType,
  type InventoryLotRow,
  type InventoryPromotionPlanInput,
  type InventoryPromotionPlanItemInput,
  type InventoryPromotionPlanRow,
  type InventoryPromotionRuleType,
  type InventorySkuInput,
  type InventorySkuListFilters,
  type InventorySkuOptionFilters,
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
  INVENTORY_DOC_CANDIDATE_BULK_LIMIT,
  resolveInventoryDocCandidate,
  type InventoryDocCandidateDefinition,
  type InventoryDocCandidateFilters,
  type InventoryDocCandidateProgressKind,
  type InventoryDocCandidateRow,
} from './doc-candidates'
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

// 分页归一已收编到 admin 单源 `@/lib/paging` 的 `resolvePaging`（#281）。
// 原先本文件自带一份 `normalizePage`（判据 `Number.isFinite` + `MAX_PAGE` 上夹），
// 而其余 37 处调用点各写各的 `Math.max(1, filters.page || 1)`（无上夹）——
// **真正会打出 `2e+22` 那个 500 的是后者，不是本文件**；本文件的上夹早就挡住了。
//
// ⚠️ 收编带来**两处**行为变更（方向都是好的，但不是无差别等价，故显式记下）：
//  ① 判据从 `Number.isFinite` 收紧成 `Number.isSafeInteger`：`?page=1e21` 在本文件
//     5 支查询上由「夹到第 1e6 页 → 空列表」变成「回落第 1 页 → 返回首页数据」。
//  ② 新实现走 `Number(raw)`，会**接受数字字符串**：旧 `Number.isFinite('3')` 为 false
//     → 第 1 页；新 `Number('3')` → 第 3 页。URL 路径下无差别（`filters.page` 在
//     `list-filters.ts` 已经 `Number()` 过），差别只在 **action 被直调且传字符串**时。
//
// 另：offset 不再在本文件手算，全部由 `resolvePaging` 给出。见 `src/lib/paging.ts` 顶部注释。

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
 * 通用建单只负责盘点、领用、报损等没有上游业务血缘的库存动作（库存转换走专用的 createInventoryConversion）。
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
  // #350：顾客出库只能由提货服务（createPickupRecord / staffApi order.createPickup）产生
  '院顾客产品出库',
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
  /**
   * 这里的 case 集合必须与 `INVENTORY_GENERIC_DOC_TYPES`（types.ts，#350 起 9 个）一一对应 ——
   * 本函数只有一个调用点（`createInventoryCoreDoc`），而那里在更靠前的位置就把
   * `SPECIALIZED_DOC_TYPES` 整体拒了（「该库存单据必须从对应的专用业务流程创建」），
   * 所以任何专用类型的 case 写在这里都是**不可达**的。
   *
   * #237：原先多出一个 `供应链采购入库` 的 case（它属 SPECIALIZED），已删。它真正的
   * 位置校验在 `business.ts` 的专用服务里（`assertType(supplyChain, '总部', '供应链采购入库主体')`），
   * 那份是活代码。留着这个影子的代价是实打实的：#200 的评审里有谱系两次把它当活代码推理、
   * 据此报了一条误报 P2。
   *
   * 删掉该 case 后 switch 已**穷尽全部 10 个通用类型**（由 business.test.ts 的守护钉死）。
   * 仍未加 `default:` 穷尽性守卫：它的价值是在将来往白名单加类型却漏配 case 时于编译期/
   * 运行期报错，但那属行为变更（要先决定漏配时是静默放行还是 throw），见 #237 正文。
   */
  switch (input.docType) {
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
  partiallyReceived?: boolean | null
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
    partiallyReceived: row.partiallyReceived === true,
  }
}

/**
 * 采购订单「部分入库」派生标签（#335）：只是「待收货」下的进度标签，不是单据状态，
 * 不进 CHECK / lifecycle / staffApi。条件 = 采购订单 ∧ 待收货 ∧ 任一行已入库量 > 0
 * （采购行 fulfilled_quantity 只记入库量）。EXISTS 走 idx_inventory_doc_items_doc(doc_id)。
 */
const partiallyReceivedSql = sql<boolean>`(
  ${inventoryDocs.docType} = '采购订单'
  AND ${inventoryDocs.status} = '待收货'
  AND EXISTS (
    SELECT 1 FROM ${inventoryDocItems} received_item
     WHERE received_item.doc_id = ${inventoryDocs.id}
       AND COALESCE(received_item.fulfilled_quantity, 0) > 0
  )
)`

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

/**
 * 「市场间调货出库」的接收主体候选（#340）：全部启用的市场，**不按操作人 scope 过滤**。
 *
 * 调货的接收方是对方市场，只管一个市场的账号（如「市场库存财务」）按 scope 本就看不见它 ——
 * 继续用 `listInventoryLocations` 当候选源，下拉里永远只有自己，流程第一步就走不下去。
 * 服务端建单对 RECEIVE_REQUIRED 类型的 target 同样刻意不做 scope 鉴权（见
 * `createInventoryCoreDoc` 端点校验段的注释），两边口径一致。
 *
 * 因为越过了 scope，返回字段收到最少：只有名称与 orgNodeId —— 不带 locationId / storeId /
 * parentLocationId，也不带门店与总部。「排除调出市场自己」依赖用户在表单里选的发起主体，
 * 由表单按当前 source 过滤，这里不做。
 *
 * 权限与「谁能建这张单」同源：`inventoryDelegatableOperateActions(市场间调货出库 所在层级)`。
 * 市场层只有 `market_operate` —— 总部 scope 不向下展开，供应链**不能**代建市场层单据，
 * `createInventoryCoreDoc` 的层级闸同样只认它。别放宽成 stock_list 或加上 supply_chain_operate，
 * 否则建不了单的账号也能直调拿到本不在自己 scope 内的全部市场名单。
 */
export const listInventoryMarketTransferTargets = withAnyPermission(
  [...inventoryDelegatableOperateActions('market')],
  async (): Promise<InventoryMarketTransferTarget[]> => {
    await syncInventoryLocations()
    const rows = await db
      .select({ orgNodeId: inventoryLocations.orgNodeId, name: inventoryLocations.name })
      .from(inventoryLocations)
      .where(and(
        eq(inventoryLocations.isActive, true),
        eq(inventoryLocations.locationType, '市场'),
        isNotNull(inventoryLocations.orgNodeId),
      ))
      .orderBy(asc(inventoryLocations.name))
    return rows.flatMap((row) => (row.orgNodeId ? [{ orgNodeId: row.orgNodeId, name: row.name }] : []))
  },
)

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

const SKU_ID_FILTER_MAX = 100

function normalizeSkuIdFilter(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new ApiError('INVALID_PARAMS', 'skuIds 必须是字符串数组')
  }
  const ids = Array.from(new Set(value.map((id) => id.trim()).filter(Boolean)))
  if (ids.length > SKU_ID_FILTER_MAX) {
    throw new ApiError('INVALID_PARAMS', `skuIds 一次最多 ${SKU_ID_FILTER_MAX} 个`)
  }
  return ids
}

function optionalFilterId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) throw new ApiError('INVALID_PARAMS', `${label}无效`)
  return value.trim()
}

/**
 * SKU 候选的业务过滤条件（#339），口径见 `InventorySkuOptionFilters` 的注释。
 * 独立成纯函数是为了能在单测里把 SQL 渲染出来逐条断言 —— 组件测试都 mock 掉了 action，
 * 这里的 OR / AND 写反（比如自采入库漏了「非供应链」）只有在这一层才测得出来。
 */
export function inventorySkuOptionConditions(filters: InventorySkuOptionFilters): SQL[] {
  const conditions: SQL[] = []
  if (filters.sourceType) {
    if (!INVENTORY_SKU_SOURCE_TYPES.includes(filters.sourceType)) {
      throw new ApiError('INVALID_PARAMS', '无效库存商品来源')
    }
    conditions.push(eq(inventorySkus.sourceType, filters.sourceType))
  }
  if (filters.reportable) conditions.push(eq(inventorySkus.isReportable, true))
  const availableToMarketId = optionalFilterId(filters.availableToMarketId, '可用市场')
  if (availableToMarketId) {
    conditions.push(or(
      eq(inventorySkus.sourceType, '供应链'),
      eq(inventorySkus.ownerMarketId, availableToMarketId),
    )!)
  }
  const ownedByMarketId = optionalFilterId(filters.ownedByMarketId, '归属市场')
  if (ownedByMarketId) {
    conditions.push(and(
      ne(inventorySkus.sourceType, '供应链'),
      eq(inventorySkus.ownerMarketId, ownedByMarketId),
    )!)
  }
  const keyword = typeof filters.keyword === 'string' ? filters.keyword.trim() : ''
  if (keyword) {
    const pattern = `%${keyword.replace(/[%_\\]/g, '\\$&')}%`
    conditions.push(or(
      ilike(inventorySkus.skuId, pattern),
      ilike(inventorySkus.productCode, pattern),
      ilike(inventorySkus.productName, pattern),
      ilike(inventorySkus.specName, pattern),
      ilike(inventorySkus.productSeries, pattern),
    )!)
  }
  return conditions
}

export const listInventorySkus = withPermission(
  'inventory:stock_list',
  async (
    session,
    rawFilters: InventorySkuListFilters | null = {},
  ): Promise<{ data: InventorySkuRow[]; total: number }> => {
    // Server Action 可被直调：显式传 null 时默认参数不生效
    const filters = rawFilters ?? {}
    const skuIds = normalizeSkuIdFilter(filters.skuIds)
    if (skuIds !== undefined && skuIds.length === 0) return { data: [], total: 0 }
    await syncInventoryLocations()
    const { page, pageSize, offset } = resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
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
    if (skuIds !== undefined) conditions.push(inArray(inventorySkus.skuId, skuIds))
    conditions.push(...inventorySkuOptionConditions(filters))
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
      // `product_code` 有**全表**唯一索引（db/schema/inventory.ts:108
      // `uniqueIndex(uq_inventory_skus_product_code)`，迁移 0007_moaning_salo.sql:498
      // 无 WHERE 条件），本身即全序 —— #282 不给它补 tie-break 是刻意的：
      // 补了纯属多余，还会让这条**唯一有精确匹配索引**的查询从 Index Scan
      // 退化成 Index Scan + Incremental Sort。
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
    // 同 listInventorySuppliers：`pageSize === undefined` 是**「不分页、返回全量」**的刻意语义
    // （下拉选项等场景用），所以不能整段交给 resolvePaging —— 它保证 pageSize ≥ 1、表达不了
    // 「不分页」。分页那一侧仍走单源，别在这里手算 offset。
    // 这一支尤其不能漏 —— `filtered.slice(NaN, NaN)` 返回**空数组**（ToInteger(NaN)=0），
    // 而客户端若不归一会认为自己在第 1 页、不触发越界自纠，
    // 于是 `?page=abc` 会永久停在「空表 + 共 101 条」，用户只能手改 URL 才能出来。
    const paged = filters.pageSize === undefined ? null : resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
    return {
      data: paged ? filtered.slice(paged.offset, paged.offset + paged.pageSize) : filtered,
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
    const { page, pageSize, offset } = resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
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
      .orderBy(asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo), asc(inventoryStockLots.id))
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
      /**
       * 多类型过滤（#190）。与单值 `docType` 是 AND 关系（两个都传时各自收窄），
       * 办理台单据 Tab 只传本字段 —— 一个业务可能一次产出出库 + 入库两张单。
       * 传了空数组表示「没有任何可展示的类型」，fail-closed 返回空，不退化成不过滤。
       */
      docTypes?: readonly InventoryDocType[]
      status?: InventoryCoreDocStatus
      statuses?: readonly InventoryCoreDocStatus[]
      /**
       * 方向维（#192）：把可见范围从「source **或** target 在 scope」收窄成
       * 「**指定那一端**在 scope」。
       *
       * 单据可见性本来就该是双端 OR —— 发货方和收货方都得看得见自己经手的单。
       * 但**待办区**要回答的是另一个问题：这张单轮不轮得到我动手。服务端的写入动作
       * 一律拿**单边**做校验（收货类 `assertLocationWritable(target)` /
       * `assertOrgNodeVisible(target)`，撤回审批 `assertLocationWritable(source)`），
       * 所以只按 docType + status 取待办，对端会在「待我处理」里看到一张带行内按钮的单，
       * 点一次抛一次 PERMISSION_DENIED，刷新后那行还在 —— 点不掉、消不掉，
       * 同时把待办计数一起污染。
       *
       * 与上面的 scope 分支同构：`scoped === null`（admin，本就不受 scope 限制）跳过，
       * scope 为空集时 fail-closed。类型是两个字面量而不是开放字符串，
       * 省得写进来一个拼错的值就静默退化成不收窄。
       */
      scopeRole?: 'source' | 'target'
      /**
       * 只保留发起过撤回申请的单据（`cancellation_request_reason` 非空）。
       *
       * 类型刻意写死 `true` 而不是 `boolean`：本条件只有「收窄」一个方向，
       * 传 `false` 会走 falsy 分支退化成不过滤 —— 那是**放宽**结果集，
       * 与调用方写 `false` 时期待的「只看没申请过撤回的」正好相反。
       * 真需要反向过滤时应显式加一个 `cancellationNotRequested` 条件。
       */
      cancellationRequested?: true
      /**
       * 只保留**还有未入库明细**的采购订单（#192）：存在 `fulfilled_quantity < quantity` 的明细。
       *
       * #335 起采购订单的所有行都经供应链采购入库，完结只由入库推动，正常数据下
       * 「待收货」必有未入库行，这条条件不再改变结果集；保留它作防御：
       * #335 之前的存量混合单里，市场行的 fulfilled_quantity 记的是发货量。
       *
       * 与 `cancellationRequested` 同样「只收窄不放宽」：类型是字面量而不是
       * boolean / 开放字符串，省得传进来一个 falsy 值就静默退化成不过滤。
       */
      pendingItemScope?: 'supply-chain'
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ): Promise<{ data: InventoryDocRow[]; total: number; pageSize: number; canViewPrice: boolean; priceVisibility: import('./types').InventoryPriceVisibility }> => {
    await syncInventoryLocations()
    const scoped = inventoryScopedOrgNodeIds(session)
    const { page, pageSize, offset } = resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
    const conditions: (SQL | undefined)[] = []
    if (scoped !== null) {
      conditions.push(scoped.length > 0
        ? or(inArray(inventoryDocs.sourceOrgNodeId, scoped), inArray(inventoryDocs.targetOrgNodeId, scoped))
        : sql`FALSE`)
    }
    if (filters.scopeRole && scoped !== null) {
      /*
       * 方向维（#192）：在上面的双端 OR 之外**追加**一条单端收窄，而不是改写那一条。
       * 两条 AND 起来后单端条件完全覆盖 OR（`target IN s` 蕴含 `source IN s OR target IN s`），
       * 所以 OR 这时是冗余的 —— 冗余是**有意留的**：scope 那条是全表所有查询共用的基础
       * 可见性闸，让它保持「与 scopeRole 无关、永远压栈」，读代码的人就不必去论证
       * 「设了方向维之后 scope 还在不在」。多出来的这一项 planner 自己会吸收掉。
       *
       * 与 scope 分支同构：`scoped === null`（admin）跳过；scope 空集 fail-closed。
       * 条件挂在 count 与 rows 共用的 whereClause 上，total 跟着收窄 —— 这正是要的：
       * 待办计数必须只数「我能动手的单」，否则角标数字对不上列表行数。
       *
       * 端点列可空（如「采购订单」的 source_org_node_id 恒为 NULL），
       * SQL 的 `NULL IN (...)` 求值为 NULL 即不命中，方向是 fail-closed，正确。
       */
      const endpointColumn = filters.scopeRole === 'source'
        ? inventoryDocs.sourceOrgNodeId
        : inventoryDocs.targetOrgNodeId
      conditions.push(scoped.length > 0 ? inArray(endpointColumn, scoped) : sql`FALSE`)
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
    if (filters.docTypes) {
      conditions.push(filters.docTypes.length > 0
        ? inArray(inventoryDocs.docType, [...filters.docTypes])
        : sql`FALSE`)
    }
    if (filters.status) conditions.push(eq(inventoryDocs.status, filters.status))
    if (filters.statuses) {
      conditions.push(filters.statuses.length > 0
        ? inArray(inventoryDocs.status, [...filters.statuses])
        : sql`FALSE`)
    }
    if (filters.cancellationRequested) {
      conditions.push(isNotNull(inventoryDocs.cancellationRequestReason))
    }
    if (filters.pendingItemScope) {
      /*
       * 别名 pending_item 在本文件未被占用（现有别名是 visible_doc / visible_docs /
       * root_doc / item / doc_link 等），新增别名前先 grep 全文件 —— 本仓有按文件聚合的
       * CTE 别名守护，同名不同语句也会判撞。
       * 条件挂在 count 与 rows 共用的 whereClause 上，total 跟着收窄（这是对的：
       * 待办区的分页器必须按能操作的单数算页数）。
       * EXISTS 走 idx_inventory_doc_items_doc(doc_id)。
       */
      // 采购订单的所有行都经供应链采购入库（#335），fulfilled_quantity 即已入库量，
      // 不再按 market_id 分流。
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${inventoryDocItems} pending_item
         WHERE pending_item.doc_id = ${inventoryDocs.id}
           AND COALESCE(pending_item.fulfilled_quantity, 0) < pending_item.quantity
      )`)
    }
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
        partiallyReceived: partiallyReceivedSql,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(whereClause)
      /*
       * 末位 `id` 是**分页正确性**所必需，不是锦上添花的排序偏好：
       * `created_at` 取 `NOW()`（事务开始时刻），而 `createInventoryConversion` 在同一个
       * 事务里写「库存转换出库 + 库存转换入库」两张单 —— 两行的 doc_date 与 created_at
       * 逐微秒相同。排序键完全并列时，两次独立的 LIMIT/OFFSET 查询之间顺序不保证稳定，
       * 骑在页边界上的那一对会出现「一张重复、另一张永远不出现」。id 唯一且不可变。
       */
      .orderBy(desc(inventoryDocs.docDate), desc(inventoryDocs.createdAt), desc(inventoryDocs.id))
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
      // 回传**夹过白名单后**的实际页长：调用方若传了非白名单值（如 30），这里按 20 取数，
      // 前端却会按 30 算总页数，页码条少算页数、最后几页永远翻不到。
      pageSize,
      canViewPrice: priceVisibility !== 'none',
      priceVisibility,
    }
  },
)

/*
 * ────────── 办理台来源单 / 待处理单候选（#338） ──────────
 *
 * 用途白名单与口径在 `./doc-candidates`；这里只负责把口径翻成 SQL。
 * 子查询别名统一 `cand_*` 前缀（本文件已有 pending_item / received_item / visible_doc 等，新增前先 grep）。
 */

/** 单行「已完成量」：与各建单守卫逐字同口径，见 InventoryDocCandidateProgressKind 注释 */
function candidateItemDoneSql(kind: InventoryDocCandidateProgressKind): SQL {
  if (kind === 'shipped' || kind === 'allocated') {
    const relationType = kind === 'shipped' ? '采购订单发货' : '门店报货配货'
    // 同 business.ts linkedQuantity：目标单已取消的血缘不算
    return sql`(
      SELECT COALESCE(SUM(cand_link.quantity), 0)
        FROM inventory_doc_links cand_link
        JOIN inventory_docs cand_link_doc ON cand_link_doc.id = cand_link.to_doc_id
       WHERE cand_link.from_item_id = cand_item.id
         AND cand_link.relation_type = ${relationType}
         AND cand_link_doc.status <> '已取消'
    )`
  }
  return sql`COALESCE(cand_item.fulfilled_quantity, 0)`
}

/** 参与进度的明细行：发货只看有市场归属的行（自用行不走发货，守卫直接拒） */
function candidateItemFilterSql(kind: InventoryDocCandidateProgressKind): SQL {
  return kind === 'shipped' ? sql`AND cand_item.market_id IS NOT NULL` : sql``
}

function candidateRemainingSql(kind: InventoryDocCandidateProgressKind): SQL {
  return sql`EXISTS (
    SELECT 1 FROM inventory_doc_items cand_item
     WHERE cand_item.doc_id = ${inventoryDocs.id}
       ${candidateItemFilterSql(kind)}
       AND ${candidateItemDoneSql(kind)} < cand_item.quantity
  )`
}

function candidateProgressSql(kind: InventoryDocCandidateProgressKind) {
  const total = sql<string | number>`(
    SELECT COALESCE(SUM(cand_item.quantity), 0)
      FROM inventory_doc_items cand_item
     WHERE cand_item.doc_id = ${inventoryDocs.id}
       ${candidateItemFilterSql(kind)}
  )`
  // LEAST：超量（历史数据 / 赠送并行）不让进度超过 100%
  const done = kind === 'none'
    ? sql<string | number | null>`NULL`
    : sql<string | number | null>`(
      SELECT COALESCE(SUM(LEAST(${candidateItemDoneSql(kind)}, cand_item.quantity)), 0)
        FROM inventory_doc_items cand_item
       WHERE cand_item.doc_id = ${inventoryDocs.id}
         ${candidateItemFilterSql(kind)}
    )`
  return { total, done }
}

const CANDIDATE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Server Action 入参原样到达：非字符串一律按参数错误处理，别让 `.trim` 抛 TypeError 变成 500 */
function candidateText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  return value.trim() || undefined
}

function candidateDate(value: unknown, label: string): string | undefined {
  const text = candidateText(value, label)
  if (!text) return undefined
  // 往返比对而不是只看 Date.parse：JS 会把 2026-02-30 顺延成 03-02 且不报错，
  // 放过去的话 PG 转 date 时抛 22008，用户看到的是 500 而不是参数错误。
  const [year, month, day] = CANDIDATE_DATE_PATTERN.test(text) ? text.split('-').map(Number) : [NaN, NaN, NaN]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  }
  return text
}

interface ParsedCandidateFilters {
  keyword?: string
  startDate?: string
  endDate?: string
  targetOrgNodeId?: string
  includeExhausted: boolean
}

/**
 * 候选检索条件的运行时校验与归一。必须在 scope 判定、syncInventoryLocations **之前**跑完 ——
 * 否则空 scope 会话传非法入参拿到的是空结果而不是 INVALID_PARAMS，同一入参的对错取决于谁在调。
 */
function parseCandidateFilters(filters: Record<string, unknown>): ParsedCandidateFilters {
  const includeExhausted = filters.includeExhausted
  if (includeExhausted !== undefined && includeExhausted !== null && typeof includeExhausted !== 'boolean') {
    // 'true' 之类的字符串若静默当 false，调用方以为放宽了、其实没有
    throw new ApiError('INVALID_PARAMS', '显示全部参数格式不正确')
  }
  const startDate = candidateDate(filters.startDate, '开始日期')
  const endDate = candidateDate(filters.endDate, '结束日期')
  if (startDate && endDate && startDate > endDate) {
    throw new ApiError('INVALID_PARAMS', '开始日期不能晚于结束日期')
  }
  return {
    keyword: candidateText(filters.keyword, '检索关键字')?.slice(0, 64),
    startDate,
    endDate,
    targetOrgNodeId: candidateText(filters.targetOrgNodeId, '接收主体'),
    includeExhausted: includeExhausted === true,
  }
}

/**
 * 候选查询的 WHERE：scope 双端 OR（与 listInventoryCoreDocs 同一基础可见性闸）
 * + 动作端单端收窄 + 用途的类型/状态规则 + 剩余量 + 检索条件。
 */
function candidateConditions(
  session: AuthSession,
  definition: InventoryDocCandidateDefinition,
  filters: ParsedCandidateFilters,
  { onlyRemaining }: { onlyRemaining: boolean },
): SQL {
  const scoped = inventoryScopedOrgNodeIds(session)
  const conditions: (SQL | undefined)[] = []
  if (scoped !== null) {
    if (scoped.length === 0) return sql`FALSE`
    conditions.push(or(inArray(inventoryDocs.sourceOrgNodeId, scoped), inArray(inventoryDocs.targetOrgNodeId, scoped)))
    const endpointColumn = definition.scopeRole === 'source'
      ? inventoryDocs.sourceOrgNodeId
      : inventoryDocs.targetOrgNodeId
    conditions.push(inArray(endpointColumn, scoped))
  }
  conditions.push(or(...definition.rules.map((rule) => and(
    eq(inventoryDocs.docType, rule.docType),
    rule.statuses
      ? inArray(inventoryDocs.status, [...rule.statuses])
      : ne(inventoryDocs.status, '已取消'),
  ))))
  if (definition.cancellationRequested) conditions.push(isNotNull(inventoryDocs.cancellationRequestReason))
  if (definition.requireNoReceipt) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM inventory_doc_items cand_received
       WHERE cand_received.doc_id = ${inventoryDocs.id}
         AND COALESCE(cand_received.fulfilled_quantity, 0) > 0
    )`)
  }
  if (onlyRemaining || definition.requireRemaining) {
    conditions.push(candidateRemainingSql(definition.progress))
  } else if (definition.progress === 'shipped') {
    // 「显示全部」也不列纯自用采购单：它没有任何市场行，选中后发货表单无行可发
    conditions.push(sql`EXISTS (
      SELECT 1 FROM inventory_doc_items cand_item
       WHERE cand_item.doc_id = ${inventoryDocs.id}
         AND cand_item.market_id IS NOT NULL
    )`)
  }
  const { targetOrgNodeId, startDate, endDate, keyword } = filters
  if (targetOrgNodeId) conditions.push(eq(inventoryDocs.targetOrgNodeId, targetOrgNodeId))
  if (startDate) conditions.push(gte(inventoryDocs.docDate, startDate))
  if (endDate) conditions.push(lte(inventoryDocs.docDate, endDate))
  if (keyword) {
    // 反斜杠也要转义：ILIKE 默认转义符就是 `\`，漏了它 `a\` 这类输入会让模式非法或错配
    const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(or(
      ilike(inventoryDocs.id, pattern),
      ilike(sourceLocation.name, pattern),
      ilike(targetLocation.name, pattern),
    ))
  }
  return and(...conditions) ?? sql`TRUE`
}

export const listInventoryDocCandidates = withPermission(
  'inventory:list',
  async (
    session,
    filters: InventoryDocCandidateFilters,
  ): Promise<{ data: InventoryDocCandidateRow[]; total: number; pageSize: number }> => {
    const definition = resolveInventoryDocCandidate(filters?.purpose)
    if (!definition) throw new ApiError('INVALID_PARAMS', '未知的候选单据用途')
    const parsed = parseCandidateFilters(filters as unknown as Record<string, unknown>)
    await syncInventoryLocations()
    const { pageSize, offset } = resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
    // includeExhausted 只对建单类来源生效；状态类候选没有「显示全部」这回事
    const onlyRemaining = definition.remainingToggle && !parsed.includeExhausted
    const whereClause = candidateConditions(session, definition, parsed, { onlyRemaining })
    // 检索条件里用到了两端主体名，COUNT 也必须带同样的 join，否则 total 与列表对不上
    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(whereClause)
    const progress = candidateProgressSql(definition.progress)
    const rows = await db
      .select({
        doc: inventoryDocs,
        sourceOrgNodeName: sourceLocation.name,
        sourceOrgNodeType: sourceLocation.locationType,
        targetOrgNodeName: targetLocation.name,
        targetOrgNodeType: targetLocation.locationType,
        partiallyReceived: partiallyReceivedSql,
        progressTotal: progress.total,
        progressDone: progress.done,
      })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(whereClause)
      // 末位 id 保证翻页不重不漏（同 listInventoryCoreDocs 的排序注释）
      .orderBy(desc(inventoryDocs.docDate), desc(inventoryDocs.createdAt), desc(inventoryDocs.id))
      .limit(pageSize)
      .offset(offset)
    return {
      data: rows.map((row) => ({
        // 候选只用于选单，不回金额
        ...docRow({ ...row, includePrice: false }),
        progress: {
          done: row.progressDone === null ? null : Number(row.progressDone),
          total: Number(row.progressTotal),
        },
      })),
      total: countRow?.count ?? 0,
      pageSize,
    }
  },
)

/**
 * 一键带出（#338 / §2.5）：按检索条件取**全部仍有剩余量**的候选单号，不分页。
 * 超过上限直接报错让人缩小日期区间，不静默截断 —— 截断等于少采购。
 */
export const listInventoryDocCandidateIds = withPermission(
  'inventory:list',
  async (
    session,
    filters: Omit<InventoryDocCandidateFilters, 'includeExhausted' | 'page' | 'pageSize'>,
  ): Promise<{ ids: string[] }> => {
    const definition = resolveInventoryDocCandidate(filters?.purpose)
    // 「有剩余量」只对建单类来源有意义；审批 / 收货类没有一键带出
    if (!definition || !definition.remainingToggle) throw new ApiError('INVALID_PARAMS', '未知的候选单据用途')
    const parsed = parseCandidateFilters(filters as unknown as Record<string, unknown>)
    await syncInventoryLocations()
    const whereClause = candidateConditions(session, definition, parsed, { onlyRemaining: true })
    const rows = await db
      .select({ id: inventoryDocs.id })
      .from(inventoryDocs)
      .leftJoin(sourceLocation, eq(sourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
      .leftJoin(targetLocation, eq(targetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
      .where(whereClause)
      .orderBy(asc(inventoryDocs.docDate), asc(inventoryDocs.createdAt), asc(inventoryDocs.id))
      .limit(INVENTORY_DOC_CANDIDATE_BULK_LIMIT + 1)
    if (rows.length > INVENTORY_DOC_CANDIDATE_BULK_LIMIT) {
      throw new ApiError(
        'INVALID_PARAMS',
        `符合条件的单据超过 ${INVENTORY_DOC_CANDIDATE_BULK_LIMIT} 张，请缩小日期区间后再带出`,
      )
    }
    return { ids: rows.map((row) => row.id) }
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
      --
      -- 已取消的采购单也要带上（#335）：市场行可以部分入库后再关单，已入库的那部分
      -- 仍占着需求额度、也可能已经发了货，整张排除会让「已采购 / 已发 / 已收」一起归零。
      -- 已下单量在下面 purchase_totals 里只计已入库的保留部分（cancelled_retained）。
      SELECT
        doc_link.from_item_id AS root_item_id,
        doc_link.to_item_id AS purchase_item_id,
        COALESCE(doc_link.quantity, 0) AS quantity,
        purchase_doc.status AS purchase_status
        FROM inventory_doc_links doc_link
        JOIN root_items root_item ON root_item.item_id = doc_link.from_item_id
        JOIN inventory_docs purchase_doc ON purchase_doc.id = doc_link.to_doc_id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '市场报货采购订单'
         AND purchase_doc.status IN ('已完成', '待收货', '已取消')
    ),
    -- 一条采购明细可以由**多个**来源行合并而来（#194），所以下游的发货/收货量必须
    -- 按各来源在该采购行里的占比分摊，不能每个来源都记全量 ——
    -- 来源 A 5 件、B 5 件合成采购行 10 件、实发 6 件时，不分摊会让 A 与 B 各显示 6，
    -- 合计 12 件，凭空多出一倍。
    --
    -- ⚠️ 分母必须取该采购行的**全部**来源血缘，不能用 PARTITION BY 的窗口和：
    -- purchase_links 已经被 from_doc_id 限定成「当前这张单」的血缘，
    -- 窗口函数看不到同一采购行来自**其它来源单**的那部分，share 又会退回 1，
    -- 跨单合并的场景照样重复计数。
    purchase_share AS (
      SELECT
        purchase_link.root_item_id,
        purchase_link.purchase_item_id,
        purchase_link.quantity,
        purchase_link.purchase_status,
        purchase_link.quantity / NULLIF(source_total.total_quantity, 0) AS share
        FROM purchase_links purchase_link
        JOIN LATERAL (
          SELECT COALESCE(SUM(COALESCE(all_link.quantity, 0)), 0) AS total_quantity
            FROM inventory_doc_links all_link
           WHERE all_link.to_item_id = purchase_link.purchase_item_id
             AND all_link.relation_type = '市场报货采购订单'
        ) source_total ON true
    ),
    -- 已取消的采购单只剩已入库那部分仍算已采购：按分做最大余数分配，与建单容量
    -- （business.ts allocateSummaryToMarketReportItems）共用同一片段，保证同源。
    cancelled_retained AS (${cancelledMarketReportRetainedSql(sql`SELECT item_id FROM root_items`)}),
    -- 有效采购单按血缘量、已取消采购单按保留量，两部分各自聚合后相加：
    -- 同一对 (原始行, 采购行) 可能有多条血缘，逐行连接 cancelled_retained 会重复累计。
    -- 各自一次 GROUP BY 再左连接，避免按 root_items 逐行跑相关子查询。
    active_purchase_totals AS (
      SELECT active_link.root_item_id, SUM(active_link.quantity) AS quantity
        FROM purchase_share active_link
       WHERE active_link.purchase_status <> '已取消'
       GROUP BY active_link.root_item_id
    ),
    cancelled_purchase_totals AS (
      SELECT retained_row.report_item_id, SUM(retained_row.retained_quantity) AS quantity
        FROM cancelled_retained retained_row
       GROUP BY retained_row.report_item_id
    ),
    purchase_totals AS (
      SELECT
        root_item.item_id AS root_item_id,
        COALESCE(active_total.quantity, 0) + COALESCE(cancelled_total.quantity, 0) AS ordered_quantity
        FROM root_items root_item
        LEFT JOIN active_purchase_totals active_total ON active_total.root_item_id = root_item.item_id
        LEFT JOIN cancelled_purchase_totals cancelled_total ON cancelled_total.report_item_id = root_item.item_id
    ),
    shipment_links AS (
      SELECT
        purchase_link.root_item_id,
        doc_link.to_item_id AS shipment_item_id,
        doc_link.relation_type,
        COALESCE(doc_link.quantity, 0) * COALESCE(purchase_link.share, 0) AS quantity,
        -- 发货明细由采购行一对一产生，所以收货沿用采购层的占比即可。
        -- 早先在这里按当前单据子集再归一化一次，等于把 share 重新拉回 1，白分摊了。
        COALESCE(purchase_link.share, 0) AS share
        FROM purchase_share purchase_link
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
        COALESCE(doc_link.quantity, 0) * COALESCE(shipment_link.share, 0) AS quantity
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
    -- 与市场报货那套同理：一条采购明细可由多张需求单的多行合并而来（#194），
    -- 下游的入库量、以及已取消采购单残留的已下单量，都要按各来源在该采购行里的
    -- 占比分摊，否则每个来源都会记到全量。
    -- 分母要取该采购行的**全部**来源血缘 —— purchase_links 已被 from_doc_id
    -- 限成当前这张需求单，窗口函数看不到别的来源单。
    purchase_share AS (
      SELECT
        purchase_link.request_item_id,
        purchase_link.purchase_item_id,
        purchase_link.quantity,
        purchase_link.purchase_status,
        purchase_link.received_quantity,
        purchase_link.quantity / NULLIF(source_total.total_quantity, 0) AS share
        FROM purchase_links purchase_link
        JOIN LATERAL (
          SELECT COALESCE(SUM(COALESCE(all_link.quantity, 0)), 0) AS total_quantity
            FROM inventory_doc_links all_link
           WHERE all_link.to_item_id = purchase_link.purchase_item_id
             AND all_link.relation_type = '品项公司报货采购订单'
        ) source_total ON true
    ),
    purchase_totals AS (
      SELECT
        request_item_id,
        SUM(CASE
          -- 已取消的采购单只剩"实收那部分"仍占着需求额度，而这部分同样要按占比分给各来源：
          -- A、B 各 5 件合成采购行 10 件、实收 6 件后关闭时，关闭逻辑给两边各留 3，
          -- 这里若按 LEAST(5, 6) 逐条算就会各显示 5，与真实占用对不上。
          WHEN purchase_status = '已取消' THEN LEAST(quantity, received_quantity * COALESCE(share, 0))
          ELSE quantity
        END) AS ordered_quantity
        FROM purchase_share
       GROUP BY request_item_id
    ),
    receipt_totals AS (
      SELECT
        purchase_link.request_item_id,
        SUM(COALESCE(doc_link.quantity, 0) * COALESCE(purchase_link.share, 0)) AS received_quantity
        FROM purchase_share purchase_link
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
    ),
    -- 市场行的正常发货量（#335 过渡期：发货仍以采购行数量封顶，由 #336 改为引用市场报货单）。
    -- 与 business.ts linkedQuantity 同口径：排除已取消的发货单，赠送发货不占采购数量。
    -- 只聚合已过可见性校验的采购行，不外泄发货单本身的内容，所以发货单不再套 visible_docs。
    purchase_shipment_totals AS (
      SELECT
        doc_link.from_item_id AS purchase_item_id,
        SUM(COALESCE(doc_link.quantity, 0)) AS shipped_quantity
        FROM inventory_doc_links doc_link
        JOIN purchase_items purchase_item ON purchase_item.item_id = doc_link.from_item_id
        JOIN inventory_docs shipment_doc ON shipment_doc.id = doc_link.to_doc_id
       WHERE doc_link.from_doc_id = ${docId}
         AND doc_link.relation_type = '采购订单发货'
         AND shipment_doc.status <> '已取消'
       GROUP BY doc_link.from_item_id
    )
    SELECT
      purchase_item.item_id,
      purchase_item.quantity AS purchased_quantity,
      COALESCE(receipt_total.received_quantity, 0) AS received_quantity,
      COALESCE(purchase_shipment_total.shipped_quantity, 0) AS shipped_quantity,
      purchase_item.purchase_status
      FROM purchase_items purchase_item
      LEFT JOIN receipt_totals receipt_total ON receipt_total.purchase_item_id = purchase_item.item_id
      LEFT JOIN purchase_shipment_totals purchase_shipment_total
        ON purchase_shipment_total.purchase_item_id = purchase_item.item_id
     ORDER BY purchase_item.item_id
  `)
  // 采购单不可见（scope 外）时 purchase_items 为空集，返回 null 而不是空进度。
  if (rows.length === 0) return null
  return {
    kind: '供应链采购收货',
    items: (rows as unknown as Array<{
      item_id: number | string
      purchased_quantity: string | number | null
      received_quantity: string | number | null
      shipped_quantity: string | number | null
      purchase_status: InventoryCoreDocStatus
    }>).map((row) => {
      const purchasedQuantity = numberOrNull(row.purchased_quantity) ?? 0
      const receivedQuantity = numberOrNull(row.received_quantity) ?? 0
      return {
        itemId: Number(row.item_id),
        purchasedQuantity,
        receivedQuantity,
        shippedQuantity: numberOrNull(row.shipped_quantity) ?? 0,
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
  // 采购订单的所有行（不论有无市场归属）都经供应链采购入库（#335），收货进度统计全部明细；
  // 市场行另带正常发货量，供品项公司发货表单算剩余可发量。
  if (docType === '采购订单') {
    return loadSupplyChainPurchaseReceiptProgress(docId, scoped)
  }
  if (docType === '品项公司发货' || docType === '分院配货') {
    return loadShipmentReceiptProgress(docId, scoped)
  }
  return null
}

/**
 * 批量取单据详情（#338 一键带出后采购表单装载明细用）。
 *
 * Server Action 在客户端是全局串行队列，逐张调 getInventoryCoreDocById 带出 100 张就是 100 次串行往返，
 * 期间检索 / 提交全被堵住。这里一次请求、服务端逐张复用 getInventoryCoreDocById（scope 与价格裁剪同一口径）。
 * 查不到 / 越出 scope 的单直接略过，与单张接口返回 null 同义。
 */
export const getInventoryCoreDocsByIds = withPermission(
  'inventory:list',
  async (_session, ids: string[]): Promise<InventoryDocDetail[]> => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new ApiError('INVALID_PARAMS', '单据编号格式不正确')
    }
    const unique = Array.from(new Set(ids))
    if (unique.length > INVENTORY_DOC_CANDIDATE_BULK_LIMIT) {
      throw new ApiError('INVALID_PARAMS', `一次最多加载 ${INVENTORY_DOC_CANDIDATE_BULK_LIMIT} 张单据`)
    }
    const details: InventoryDocDetail[] = []
    for (const id of unique) {
      const detail = await getInventoryCoreDocById(id)
      if (detail) details.push(detail)
    }
    return details
  },
)

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
        partiallyReceived: partiallyReceivedSql,
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
    /*
     * 层级 action 闸（#191；甲方 2026-09-21 拍板改成「显式放开向下代建」）：
     *
     * 1) 入口的 withAnyPermission 是「三个 operate 任一」、**不按 docType 分层**，
     *    所以只有 `inventory:store_operate` 的账号曾经也建得出「市场产品报损」这类上级单据。
     *    这道闸把**向上**越级堵死。
     * 2) **向下**是显式允许的：「市场人员替门店建单」是生产既有工作流，它不靠「权限并集
     *    碰巧漏出来」，而由 inventoryDelegatableOperateActions 的层级序 ∩「scope 会向下
     *    展开的层级」显式表达 —— 收回/放开代建都只需改 business-level.ts 那两张表。
     *    ⚠️ 总部代建**不在候选集里**：access.ts 的 inventoryScopedOrgNodeIds 对
     *    scopeType==='总部' 的绑定只计入自身 scopeId、不展开后代，总部账号看不见市场/门店
     *    节点，放开了也只会在这里放行、到下面的 assertOrgNodeVisible 才被拒（错误更晚更含糊），
     *    UI 下拉里还会多出 9 个必然 403 的死路选项。要真放开先改 inventoryScopedOrgNodeIds，
     *    再把 LEVEL_SCOPE_EXPANDS_DOWNWARD 的 'supply-chain' 翻成 true。
     * 3) 真正限制代建**范围**的是下面的 assertOrgNodeVisible（scope）与
     *    assertGenericDocLocationRules（按 docType 强制主体 location_type，见 engine.ts 上方）；
     *    这道闸只负责层级**方向**。
     */
    const docLevel = genericDocBusinessLevel(input.docType)
    if (!docLevel) throw new ApiError('INVALID_STATE', '该库存单据没有归属业务层级')
    const allowedActions = inventoryDelegatableOperateActions(docLevel)
    if (!allowedActions.some((action) => hasPermission(session, action))) {
      /*
       * 文案由候选层级集生成（business-level.ts），别写回「X 或其上级层级」：
       * 供应链是最顶层、市场的上级又不展开 scope，那句话会把用户指向一个不存在
       * 或帮不上忙的权限。
       */
      throw new ApiError('PERMISSION_DENIED', inventoryLevelOperateDeniedMessage(docLevel))
    }
    /*
     * ⚠️ 光校验 action 不够，**scope 必须跟着同一条角色绑定收窄**。
     *
     * 入口的 withAnyPermission 收的是「持有三个 operate 任一」的角色并集，于是多绑定账号
     * （市场 A 绑 market_operate + 门店 B 绑 store_operate）会出现：单据层级要的 action 由
     * 门店 B 的绑定提供、而目标节点的可见性由市场 A 的绑定提供，两者一拼接就放行 ——
     * 而那条提供 action 的绑定对目标节点根本没有授权。action 并集配 scope 并集就是这么漏的。
     *
     * 【显式不变量，带前提】候选集 allowedActions 只依赖 docType、**与具体角色无关**。
     * **当会话带角色级 scope 元数据时**（roles[] 上 actions / scopeStoreIds / scopeOrgNodeIds
     * 三个数组齐全，正常登录会话都有），scopeSessionToActions 会先按候选 action 过滤角色，
     * 于是「union(入选角色的 scope) 包含目标节点」与「∃ 某条角色绑定同时持有候选 action
     * 且其 scope 覆盖目标节点」等价（inventoryScopedOrgNodeIds 是逐角色求并集，
     * membership 即存在性）—— 所以候选从单值换成数组后，不会出现「action 来自这条绑定、
     * scope 来自那条绑定」的拼接。
     * ⚠️ 前提不成立时（导出快照 / 旧测试会话等缺元数据的形态）scopeSessionToActions
     * 整条收窄被跳过、原样返回 session（见 lib/action-scope.ts 的 hasRoleScopeMetadata
     * 提前返回），actingSession 退化成外层的 action 并集 + scope 并集，跨绑定拼接又成立。
     * 这类会话本就只用于只读路径；真要在建单链路上遇到，修法是补元数据而不是放宽这里。
     * ⚠️ 另外，谁要是改成「按角色分别算候选集」，即便元数据齐全等价性也破，拼接漏洞会悄悄回来。
     *
     * 往下所有可见性判定一律用这个收窄后的会话，不要再碰外层 session。
     */
    const actingSession = scopeSessionToActions(session, allowedActions)
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
      /**
       * #200：两边都给且不一致时拒绝。原先无条件 `source ?? target` 会**静默吃掉**调用方
       * 选的 target —— 共享建单表单同时渲染出库/入库两个下拉，用户选了两个不同主体却只有
       * 一个生效，另一个连报错都没有。
       */
      if (sourceOrgNodeId && targetOrgNodeId && sourceOrgNodeId !== targetOrgNodeId) {
        throw new ApiError('INVALID_PARAMS', '该单据的出库主体与入库主体必须是同一个')
      }
      const orgNodeId = sourceOrgNodeId ?? targetOrgNodeId
      sourceOrgNodeId = orgNodeId
      targetOrgNodeId = orgNodeId
    }
    if (RECEIVE_REQUIRED_DOC_TYPES.has(input.docType) && !targetOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '待收货单据缺少接收主体')
    }

    const plan = movementPlan(input.docType, status)
    if (plan?.locationRole === 'source' && !sourceOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '出库类单据缺少出库主体')
    }
    if (plan?.locationRole === 'target' && !targetOrgNodeId) {
      throw new ApiError('INVALID_PARAMS', '入库类单据缺少入库主体')
    }

    /**
     * #200 鉴权主体 = **本单真正被改动库存的那个主体**，不是「发起方」。
     *
     * 改前取 `sourceOrgNodeId ?? targetOrgNodeId`，只对它做 assertOrgNodeVisible：
     * 入库类单据（movementPlan.locationRole='target'）的流水写在 target 上，却拿 source 去鉴权
     * —— 同时传一个自己有权限的 source + 一个无权限的 target，就能往无权操作的主体里加库存。
     * 共享建单表单本来就把两个下拉都渲染出来，普通表单操作即可构造，无需伪造请求。
     *
     * 无流水单据（报货类 NO_MOVEMENT、建单即待审批的报损/退货申请）plan 为 null，
     * 保持原有的 `source ?? target` 口径：它们此刻不动任何库存，真正扣减发生在审批/收货那步，
     * 那两处各自已对正确的主体做了校验（见 approve / confirmReceive 分支）。
     */
    // `locationRole === 'source'` 时上面已强制 source 非空，`source ?? target` 必等于 source，
    // 故只需把 target 类单独摘出来，其余走同一支
    const actingOrgNodeId = plan?.locationRole === 'target'
      ? targetOrgNodeId
      : (sourceOrgNodeId ?? targetOrgNodeId)
    if (!actingOrgNodeId) throw new ApiError('INVALID_PARAMS', '缺少当前操作组织节点')
    /**
     * #200：鉴权必须**先于** `ensureOrgNodeLocation`。
     *
     * 那个函数会对不存在 / 已停用的节点分别抛 `NOT_FOUND` / `INVALID_STATE`，
     * 放在鉴权前就成了一个探测器：拿无权限的 orgNodeId 试建单，靠返回的是
     * 「没有对应库存主体」「主体已停用」还是「无权操作」就能反推该节点的存在与状态。
     * 它还会顺带跑一次 `syncInventoryLocations()` —— 让无权者触发写操作也不合适。
     */
    await assertOrgNodeVisible(actingSession, actingOrgNodeId)

    /**
     * #200：单边单据拒绝另一边，必须在**任何 location 查询之前**。
     *
     * 它是纯输入校验（只看 docType 与两个 id 是否为空），零查询依赖。放在 ensureOrgNodeLocation
     * 之后的话，无权的那一边照样会先进 ensure、照样按「不存在 / 已停用 / 正常」抛出三种不同的错
     * —— 上面刚堵住的探测信道换个位置继续成立（两个谱系独立命中此点）。
     *
     * 写成按 `movementPlan.locationRole` 推导的通用规则、而不是逐 docType 手写 case：
     * 新增单据类型时自动覆盖，不会因为漏改某个 case 又出现「传一个自己有权的无关主体去过鉴权」。
     * 两类豁免：INTERNAL_SAME_NODE（两端已在上面统一）、RECEIVE_REQUIRED（调货/发货本就两边都要）。
     *
     * ⚠️ 调货类的 target 是对方主体，发起方本就无权可见，**不能**对它鉴权 —— 那会打挂正常调货。
     * 它的存在性探测是业务必需（要选得到对方门店），不在本次要堵的范围内。
     */
    if (
      plan
      && !INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)
      && !RECEIVE_REQUIRED_DOC_TYPES.has(input.docType)
    ) {
      if (plan.locationRole === 'target' && sourceOrgNodeId) {
        throw new ApiError('INVALID_PARAMS', `${input.docType}不接受出库主体`)
      }
      if (plan.locationRole === 'source' && targetOrgNodeId) {
        throw new ApiError('INVALID_PARAMS', `${input.docType}不接受入库主体`)
      }
    }

    const sourceLocationRow = sourceOrgNodeId ? await ensureOrgNodeLocation(sourceOrgNodeId) : null
    // 同主体单据两端已被统一成同一个 id，没必要再查一遍（ensureOrgNodeLocation 内部还会跑一次
    // syncInventoryLocations）
    const targetLocationRow = targetOrgNodeId
      ? (targetOrgNodeId === sourceOrgNodeId ? sourceLocationRow : await ensureOrgNodeLocation(targetOrgNodeId))
      : null
    const actingLocationId = sourceOrgNodeId === actingOrgNodeId
      ? sourceLocationRow?.locationId
      : targetLocationRow?.locationId
    if (!actingLocationId) throw new ApiError('NOT_FOUND', '组织节点没有对应库存主体')

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
      /**
       * #200：与 approve 分支（对 `head.source_org_node_id` 显式鉴权）对称。
       * 驳回只回滚预留、不搬库存，但鉴权对象必须和审批一致 —— 原先写成
       * `source ?? target ?? ''`，是本 issue 要清理的那个「取一个代表值去做安全决策」
       * 反模式。今天走不到 `?? target` 分支（能进「待审批」的都是 APPROVAL_DOC_TYPES，
       * 它们的 source 恒非空），但那是巧合：新增一个 source 可空的待审批类型，
       * 这里就会无声退化成按 target 鉴权。
       */
      if (!doc.source_org_node_id) {
        throw new ApiError('INVALID_STATE', '待审批单据缺少出库主体，无法驳回')
      }
      await assertOrgNodeVisible(session, doc.source_org_node_id)

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
  [...INVENTORY_CORE_RECEIVE_ACTIONS],
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
    // 归一走 `@/lib/paging` 单源；`undefined`（不分页）这一态它表达不了，故留在外层判。
    const paged = filters.pageSize === undefined ? null : resolvePaging({
      page: filters.page,
      pageSize: filters.pageSize,
      defaultPageSize: 20,
      allowedPageSizes: PAGE_SIZE_WHITELIST,
    })
    const rows = paged
      ? await query.limit(paged.pageSize).offset(paged.offset)
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
