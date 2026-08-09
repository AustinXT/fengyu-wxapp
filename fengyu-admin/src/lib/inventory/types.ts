export const INVENTORY_LOCATION_TYPES = ['总部', '市场', '门店'] as const
export type InventoryLocationType = (typeof INVENTORY_LOCATION_TYPES)[number]

export const INVENTORY_SKU_SOURCE_TYPES = ['供应链', '市场自采', '转让店'] as const
export type InventorySkuSourceType = (typeof INVENTORY_SKU_SOURCE_TYPES)[number]

export const INVENTORY_DOC_TYPES = [
  '门店报货',
  '市场报货',
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
  '供应链采购入库',
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
  skuId?: string | null
  productCode: string
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

export interface InventorySkuRow extends Required<Pick<InventorySkuInput, 'productCode' | 'productName'>> {
  skuId: string
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

export interface InventoryLocationRow {
  locationId: string
  locationType: InventoryLocationType
  name: string
  orgNodeId: string | null
  storeId: string | null
  parentLocationId: string | null
  isActive: boolean
}

export interface InventorySupplierInput {
  supplierId?: string | null
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
  planNo: string
  name: string
  startsAt: string
  endsAt: string
  scopeMarketId?: string | null
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
  relatedDocId?: string | null
  requestDocId?: string | null
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
  relatedDocId: string | null
  requestDocId: string | null
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
  reason: string | null
  remark: string | null
  createdAt: string
}

export interface InventoryDocDetail extends InventoryDocRow {
  items: InventoryDocItemRow[]
}
