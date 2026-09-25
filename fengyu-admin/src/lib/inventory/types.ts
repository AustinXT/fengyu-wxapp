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
  // 供应链跨市场汇总各市场报货需求（#193），是采购订单的来源之一。
  '市场报货汇总',
  '品项公司报货需求',
  // `供应链采购订单` 已于 #194 并入 `采购订单`（migration 0043 收敛存量、0044 收紧约束）。
  // 明细行 `market_id` 只是来源追溯标记：#335 起所有行都走供应链采购入库，#336 起发货直接引用市场报货单。
  '采购订单',
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
 *
 * #350：`院顾客产品出库` 已移出 —— 顾客出库必须绑定销售单，只能由提货服务产生
 * （admin `createPickupRecord` / staffApi `order.createPickup`）。通用入口建出的 GCK
 * 不回写 `sale_items.picked_up_quantity`、不写 `pickup_records`，顾客权益仍显示「待提」，
 * 联动开启后还会与提货服务重复扣库存。staffApi `STAFF_CREATE_DOC_TYPES` 同步移除，
 * 两端取舍由 `cross-end-inventory-snapshot.test.js` 钉住。
 */
export const INVENTORY_GENERIC_DOC_TYPES = [
  '分院调货出库',
  '市场间调货出库',
  '内部领用',
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
  /**
   * 供应商档案关联（#132）。**不接受自由文本** —— `inventory_skus.supplier` 这个冗余名
   * 由本字段派生写入，避免同一供应商被打成多种写法。
   *
   * 三态语义（update 时）：
   * - `undefined` → 关联与冗余名都不动（用于「旧数据文本没匹配上档案」时不误清空）
   * - `null`      → 显式解除关联，两列一起清空
   * - 具体 id     → 校验档案存在后写入，同时把档案当前名写进 `supplier`
   *
   * ⚠️ `supplier` 是**同步维护的冗余名**，不是历史快照：档案改名时
   * `updateInventorySupplier` 会把所有关联 SKU 的该列一起改过来。
   * 真正的历史快照是 `inventory_doc_items.supplier` / `inventory_stock_lots.supplier`。
   */
  supplierId?: string | null
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

/**
 * SKU 候选检索的业务过滤（#339）。三个口径分别对齐建单时的服务端校验，
 * 候选与提交判据同源，才不会出现「下拉里选得到、提交被拒」或反过来「合法却选不到」：
 *   - `reportable`          ↔ business.ts `loadSku(tx, id, true)`（门店报货 / 品项公司需求 / 市场报货）
 *   - `availableToMarketId` ↔ business.ts `assertSkuAvailableToMarket`（供应链放行，其余须归属该市场）
 *   - `ownedByMarketId`     ↔ 自采入库只收本市场的非供应链商品
 * 与 session 的 scope 过滤叠加生效，不能拿它越权看别的市场。
 */
export interface InventorySkuOptionFilters {
  keyword?: string
  sourceType?: InventorySkuSourceType
  reportable?: boolean
  availableToMarketId?: string
  ownedByMarketId?: string
}

export interface InventorySkuListFilters extends InventorySkuOptionFilters {
  onlyActive?: boolean
  /** 按 sku_id 精确取（回显已选商品、按明细取价），最多 100 个；传空数组直接返回空。 */
  skuIds?: string[]
  page?: number
  pageSize?: number
}

export interface InventorySkuRow extends Required<Pick<InventorySkuInput, 'productName'>> {
  skuId: string
  productCode: string
  specName: string | null
  /**
   * 供应商名称，由关联档案派生的**冗余列**（档案改名时会被一起改）。
   * 展示优先用 `supplierName`（JOIN 出来的实时名）；本列的用途是批次快照的取值来源，
   * 以及存量里匹配不上档案的旧文本（此时 `supplierId` 为 null）。
   */
  supplier: string | null
  supplierId: string | null
  /** 关联档案的实时名称；`supplierId` 为空（含存量未匹配文本）时为 null。 */
  supplierName: string | null
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

/**
 * 「市场间调货出库」接收主体候选（#340）。越过了操作人 scope，所以字段刻意只有这两个 ——
 * 别往里加 locationId / storeId / 上级关系，见 engine 的 `listInventoryMarketTransferTargets`。
 */
export interface InventoryMarketTransferTarget {
  orgNodeId: string
  name: string
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
  /** 关联到本供应商的库存 SKU 数（含已停用 SKU），停用前提示用（#132）。 */
  linkedSkuCount: number
  createdAt: string
  updatedAt: string
}

/** SKU 表单的供应商下拉选项；只带 id + 名称，不把联系人/地址带到客户端。 */
export interface InventorySupplierOption {
  supplierId: string
  name: string
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

/** 货款结算汇总行：市场结算＝(市场→供应链)，分院结算＝(市场→门店)。 */
export interface InventorySettlementRow {
  /** 出库/发起主体（市场结算=市场；分院结算=配货市场）。 */
  sourceOrgNodeId: string | null
  sourceOrgNodeName: string | null
  /** 接收主体（市场结算=供应链总部；分院结算=门店）。 */
  targetOrgNodeId: string | null
  targetOrgNodeName: string | null
  docCount: number
  totalQuantity: number
  /** 应付货款合计；仅在对应结算段价格档可见时返回。 */
  payableAmount: number
}

export interface InventorySettlementReport {
  startDate: string
  endDate: string
  priceVisibility: InventoryPriceVisibility
  /** 市场应付供应链（供应链档 / 市场档 / 全档可见）。 */
  canViewMarketSettlement: boolean
  /** 门店应付市场（仅市场档 / 全档可见）。 */
  canViewStoreSettlement: boolean
  marketRows: InventorySettlementRow[]
  storeRows: InventorySettlementRow[]
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
  /** 可用量 = 在手数量 − 未完成预留（已预留 − 已履约 − 已释放），下限 0。 */
  availableQuantity: number
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
  sourceOrgNodeId?: string | null
  targetOrgNodeId?: string | null
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
  sourceOrgNodeId: string | null
  sourceOrgNodeName: string | null
  sourceOrgNodeType: InventoryLocationType | null
  targetOrgNodeId: string | null
  targetOrgNodeName: string | null
  targetOrgNodeType: InventoryLocationType | null
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
  /** 采购订单「部分入库」派生标签（#335）：待收货且已有入库。不是单据状态。 */
  partiallyReceived?: boolean
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
  /** 行级供应商档案关联（#194）。 */
  supplierId: string | null
  /** 行级市场归属（#194）。NULL = 品项公司自用行；#335 起采购订单所有行都走供应链采购入库，本列只作来源追溯。 */
  marketId: string | null
  /** 行级市场名称，由 `marketId` 解析；解析不到时回落为 id 本身。 */
  marketName: string | null
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

/** 采购订单按明细展示分批入库的实收与待收入库数量（#335 起统计所有行）。 */
export interface InventorySupplyChainPurchaseReceiptProgressItem {
  itemId: number
  purchasedQuantity: number
  receivedQuantity: number
  outstandingQuantity: number
  /** 已入库金额 = Σ各入库明细金额（按入库实际进价，#346）；价格不可见时不返回 */
  receivedAmount?: number
  /** 入库后实际金额 = 已入库金额 +（仍待收货时）未入库数量 × 下单价；价格不可见时不返回 */
  actualAmount?: number
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
