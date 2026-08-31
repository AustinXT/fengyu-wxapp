export const INVENTORY_LOCATION_TYPES = ['总部', '市场', '门店'] as const
export type InventoryLocationType = (typeof INVENTORY_LOCATION_TYPES)[number]

export const INVENTORY_SKU_SOURCE_TYPES = ['供应链', '市场自采', '转让店'] as const
export type InventorySkuSourceType = (typeof INVENTORY_SKU_SOURCE_TYPES)[number]

export const INVENTORY_MARKET_PRICE_MODES = ['公式', '手工覆盖'] as const
export type InventoryMarketPriceMode = (typeof INVENTORY_MARKET_PRICE_MODES)[number]

export type InventoryPriceVisibility = 'all' | 'supply_chain' | 'market' | 'none'

export const INVENTORY_PROMOTION_RULE_TYPES = ['单品阶梯', '组合'] as const
export type InventoryPromotionRuleType = (typeof INVENTORY_PROMOTION_RULE_TYPES)[number]

export const INVENTORY_DOC_TYPES = [
  '门店报货',
  '市场报货',
  '品项公司报货需求',
  '采购订单',
  '供应链采购订单',
  '供应链采购入库',
  '品项公司发货',
  '市场采购入库',
  '自采产品入库',
  '分院配货',
  '院入库',
  '分院调货出库',
  '分院调货入库',
  '市场间调货出库',
  '市场间调货入库',
  '员工购出库',
  '供应链员工购出库',
  '内部领用',
  '非凤御市场出库',
  '市场退货',
  '市场退货入库',
  '供应链退货入库',
  '院退货',
  '院顾客产品出库',
  '院顾客退货',
  '市场产品报损',
  '院产品报损',
  '市场产品盘溢',
  '市场库存盘点',
  '分院库存盘点',
  '库存转换出库',
  '库存转换入库',
  '期初库存',
] as const
export type InventoryDocType = (typeof INVENTORY_DOC_TYPES)[number]

/**
 * 无需上游业务血缘的库存动作。
 * 报货、采购、发货、收货、配货、退货、员工购、自采和转换必须进入专用服务，
 * 不能从通用建单窗口绕过数量、价格和批次校验。
 */
export const INVENTORY_GENERIC_DOC_TYPES = [
  '分院调货出库',
  '市场间调货出库',
  '内部领用',
  '院顾客产品出库',
  '院顾客退货',
  '市场产品报损',
  '院产品报损',
  '市场产品盘溢',
  '市场库存盘点',
  '分院库存盘点',
] as const satisfies readonly InventoryDocType[]

export const INVENTORY_DOC_STATUSES = [
  '草稿',
  '待审批',
  '待收货',
  '已完成',
  '已驳回',
  '已取消',
] as const
export type InventoryCoreDocStatus = (typeof INVENTORY_DOC_STATUSES)[number]

export interface InventorySkuInput {
  productName: string
  specName?: string | null
  supplier?: string | null
  manufacturer?: string | null
  brand?: string | null
  productSeries?: string | null
  purchaseCategory?: string | null
  sourceType?: InventorySkuSourceType
  ownerMarketId?: string | null
  retailPrice?: number | null
  accountingPrice?: number | null
  supplyChainPurchasePrice?: number | null
  marketPurchasePrice?: number | null
  marketPurchasePriceMode?: InventoryMarketPriceMode | null
  marketPurchasePriceOverrideReason?: string | null
  storePurchasePrice?: number | null
  marketStaffPurchasePrice?: number | null
  marketPurchaseDiscount?: number | null
  storePurchaseDiscount?: number | null
  staffPurchaseDiscount?: number | null
  itemCompanyPurchasePrice?: number | null
  isReportable?: boolean
  isActive?: boolean
  remark?: string | null
}

export interface InventorySkuRow extends Required<Pick<InventorySkuInput, 'productName'>> {
  skuId: string
  productCode: string
  specName: string | null
  supplier: string | null
  manufacturer: string | null
  brand: string | null
  productSeries: string | null
  purchaseCategory: string | null
  sourceType: InventorySkuSourceType
  ownerMarketId: string | null
  ownerMarketName: string | null
  retailPrice: number | null
  accountingPrice: number | null
  supplyChainPurchasePrice: number | null
  marketPurchasePrice: number | null
  marketPurchasePriceMode: InventoryMarketPriceMode | null
  marketPurchasePriceOverrideReason: string | null
  storePurchasePrice: number | null
  marketStaffPurchasePrice: number | null
  marketPurchaseDiscount: number | null
  storePurchaseDiscount: number | null
  staffPurchaseDiscount: number | null
  itemCompanyPurchasePrice: number | null
  isReportable: boolean
  isActive: boolean
  remark: string | null
  createdAt: string
  updatedAt: string
}

export interface InventoryCompositionComponentInput {
  inventorySkuId: string
  quantityPerSaleUnit: number
}

export interface InventoryCompositionInput {
  productSkuId: string
  components: InventoryCompositionComponentInput[]
  expectedUpdatedAt: string | null
}

export interface InventoryCompositionComponent {
  mappingId: number
  inventorySkuId: string
  inventorySkuCode: string
  inventorySkuName: string
  inventorySkuSpecName: string | null
  inventorySkuActive: boolean
  quantityPerSaleUnit: number
}

export interface InventoryCompositionRow {
  productSkuId: string
  productSkuName: string
  productSkuEnabled: boolean
  components: InventoryCompositionComponent[]
  configurationStatus: 'configured' | 'unconfigured' | 'invalid'
  updatedAt: string | null
}

export interface InventoryCompositionOptions {
  productSkus: Array<{ skuId: string; specName: string }>
  inventorySkus: Array<{ skuId: string; productCode: string; productName: string; specName: string | null }>
}

export interface InventoryLocationRow {
  locationId: string
  locationType: InventoryLocationType
  name: string
  orgNodeId: string | null
  storeId: string | null
  parentLocationId: string | null
  isActive: boolean
}

export interface InventoryLocationFilterHeadquarters {
  locationId: string
  name: string
}

export interface InventoryLocationFilterStore {
  locationId: string
  name: string
}

export interface InventoryLocationFilterMarket {
  locationId: string
  name: string
  canSelectInventory: boolean
  stores: InventoryLocationFilterStore[]
}

/**
 * 库存主体筛选与普通“市场-门店”经营筛选不同：总部、市场、门店各自持有独立库存，
 * 上级选项只负责组织导航，不代表包含或汇总下级库存。
 */
export interface InventoryLocationFilterOptions {
  headquarters: InventoryLocationFilterHeadquarters[]
  markets: InventoryLocationFilterMarket[]
  defaultLocationId: string | null
}

export interface InventorySupplierInput {
  name: string
  contactName?: string | null
  phone?: string | null
  address?: string | null
  isActive?: boolean
  remark?: string | null
}

export interface InventorySupplierRow {
  supplierId: string
  name: string
  contactName: string | null
  phone: string | null
  address: string | null
  isActive: boolean
  remark: string | null
  createdAt: string
  updatedAt: string
}

export interface InventoryPromotionPlanItemInput {
  skuId: string
  /** 每单位减免金额；市场报货时按此值计算真实单价。 */
  marketUnitDiscount: number
  /** 数量阶梯下限，空值表示不设下限。 */
  reportMinQuantity?: number | null
  /** 数量阶梯上限，空值表示不设上限。 */
  reportMaxQuantity?: number | null
  remark?: string | null
}

export interface InventoryPromotionPlanInput {
  name: string
  startsAt: string
  endsAt: string
  scopeMarketId?: string | null
  /** 未传入时兼容已有单品阶梯方案。 */
  ruleType?: InventoryPromotionRuleType
  status?: '启用' | '停用'
  remark?: string | null
  items: InventoryPromotionPlanItemInput[]
}

export interface InventoryPromotionPlanRow {
  id: string
  planNo: string
  name: string
  startsAt: string
  endsAt: string
  scopeMarketId: string | null
  scopeMarketName: string | null
  ruleType: InventoryPromotionRuleType
  status: '启用' | '停用'
  remark: string | null
  itemCount: number
  items: Array<InventoryPromotionPlanItemInput & { id: number; skuName: string }>
  createdAt: string
  updatedAt: string
}

export interface InventoryLotRow {
  id: number
  locationId: string
  locationName: string | null
  locationType: InventoryLocationType | null
  skuId: string
  skuName: string
  specName: string | null
  supplier: string | null
  productSeries: string | null
  batchNo: string
  expiryDate: string | null
  isGift: boolean
  quantityOnHand: number
  supplyChainUnitCost?: number | null
  marketActualUnitPrice?: number | null
  storeActualUnitPrice?: number | null
  remark: string | null
  updatedAt: string
}

export interface InventoryDocItemInput {
  lotId?: number | null
  skuId?: string | null
  saleItemId?: string | null
  batchNo?: string | null
  expiryDate?: string | null
  isGift?: boolean
  quantity: number
  requestQuantity?: number | null
  fulfilledQuantity?: number | null
  standardUnitPrice?: number | null
  unitDiscount?: number | null
  actualUnitPrice?: number | null
  amount?: number | null
  supplyChainUnitCost?: number | null
  marketStandardUnitPrice?: number | null
  marketUnitDiscount?: number | null
  marketActualUnitPrice?: number | null
  storeStandardUnitPrice?: number | null
  storeUnitDiscount?: number | null
  storeActualUnitPrice?: number | null
  reason?: string | null
  remark?: string | null
}

export interface CreateInventoryDocInput {
  docType: InventoryDocType
  sourceLocationId?: string | null
  targetLocationId?: string | null
  marketId?: string | null
  supplierId?: string | null
  docDate?: string | null
  status?: InventoryCoreDocStatus
  relatedSaleOrderId?: string | null
  clientUserId?: string | null
  customerName?: string | null
  employeeId?: string | null
  employeeName?: string | null
  supplierName?: string | null
  externalPartyName?: string | null
  logisticsCompany?: string | null
  trackingNo?: string | null
  receiptAttachmentUrl?: string | null
  totalAmount?: number | null
  remark?: string | null
  items: InventoryDocItemInput[]
}

export interface InventoryDocRow {
  id: string
  docType: InventoryDocType
  status: InventoryCoreDocStatus
  sourceLocationId: string | null
  sourceLocationName: string | null
  sourceLocationType: InventoryLocationType | null
  targetLocationId: string | null
  targetLocationName: string | null
  targetLocationType: InventoryLocationType | null
  marketId: string | null
  supplierId: string | null
  docDate: string
  relatedSaleOrderId: string | null
  customerName: string | null
  employeeName: string | null
  supplierName: string | null
  externalPartyName: string | null
  logisticsCompany: string | null
  trackingNo: string | null
  receiptAttachmentUrl: string | null
  totalQuantity: number
  totalAmount?: number | null
  remark: string | null
  auditRemark: string | null
  createdBy: string
  confirmedAt: string | null
  approvedAt: string | null
  rejectedAt: string | null
  cancellationRequestReason: string | null
  cancellationRequestedBy: string | null
  cancellationRequestedAt: string | null
  cancellationReason: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InventoryDocItemRow {
  id: number
  docId: string
  lotId: number | null
  skuId: string
  saleItemId: string | null
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
  standardUnitPrice?: number | null
  unitDiscount?: number | null
  actualUnitPrice?: number | null
  amount?: number | null
  supplyChainUnitCost?: number | null
  marketActualUnitPrice?: number | null
  storeActualUnitPrice?: number | null
  promotionPlanId: string | null
  promotionPlanNoSnapshot: string | null
  promotionPlanNameSnapshot: string | null
  promotionRuleTypeSnapshot: InventoryPromotionRuleType | null
  promotionSelectionMode: '系统推荐' | '人工选择' | null
  reason: string | null
  remark: string | null
  createdAt: string
}

/**
 * 单据血缘中的一条聚合关系。相同关系下的多条明细会合并，避免详情页重复显示同一张单据。
 * linkedQuantity 仅统计当前用户可见的关联单据。
 */
export interface InventoryDocLineageRow {
  direction: '上游' | '下游'
  relationType: string
  docId: string
  docType: InventoryDocType
  status: InventoryCoreDocStatus
  docDate: string
  totalQuantity: number
  linkedQuantity: number
}

/** 报货单按明细展示从需求到下游发货、收货的数量快照。 */
export interface InventoryReportFulfillmentItem {
  itemId: number
  normalDemandQuantity: number
  /** 市场报货的采购订单数量；门店报货没有采购订单阶段。 */
  orderedQuantity?: number
  normalFulfilledQuantity: number
  giftFulfilledQuantity: number
  normalReceivedQuantity: number
  giftReceivedQuantity: number
}

export interface InventoryReportFulfillmentProgress {
  kind: '报货履约'
  items: InventoryReportFulfillmentItem[]
}

/** 发货/配货单按明细展示已收与待收数量。 */
export interface InventoryShipmentReceiptProgressItem {
  itemId: number
  shippedQuantity: number
  receivedQuantity: number
  outstandingQuantity: number
}

export interface InventoryShipmentReceiptProgress {
  kind: '发货收货'
  items: InventoryShipmentReceiptProgressItem[]
}

/** 品项公司报货需求到供应链采购订单、实际入库的明细进度。 */
export interface InventoryItemCompanyRequestFulfillmentItem {
  itemId: number
  demandQuantity: number
  orderedQuantity: number
  receivedQuantity: number
}

export interface InventoryItemCompanyRequestFulfillmentProgress {
  kind: '品项公司报货履约'
  items: InventoryItemCompanyRequestFulfillmentItem[]
}

/** 供应链采购订单按明细展示分批入库的实收与待收入库数量。 */
export interface InventorySupplyChainPurchaseReceiptProgressItem {
  itemId: number
  purchasedQuantity: number
  receivedQuantity: number
  outstandingQuantity: number
}

export interface InventorySupplyChainPurchaseReceiptProgress {
  kind: '供应链采购收货'
  items: InventorySupplyChainPurchaseReceiptProgressItem[]
}

export type InventoryDocFulfillmentProgress =
  | InventoryReportFulfillmentProgress
  | InventoryShipmentReceiptProgress
  | InventoryItemCompanyRequestFulfillmentProgress
  | InventorySupplyChainPurchaseReceiptProgress

export interface InventoryDocDetail extends InventoryDocRow {
  items: InventoryDocItemRow[]
  lineage: InventoryDocLineageRow[]
  fulfillmentProgress: InventoryDocFulfillmentProgress | null
}
