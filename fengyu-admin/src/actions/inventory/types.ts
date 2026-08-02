/**
 * 库存模块跨 action 共享类型与 DTO
 */

export type InventoryDocStatus = '草稿' | '已完成' | '已取消'

export type InventoryProcurementSubtype = '院报货' | '院入库' | '退货出库'
export type InventorySaleSubtype = '销售出库' | '顾客退货'
export type InventoryTransferSubtype = '调拨出库' | '调拨入库'

/** 4 张明细表共有字段 + 类型特有字段（联合） */
export interface InventoryItemDto {
  id?: number
  productCode: string
  productName: string
  specName?: string | null
  manufacturer?: string | null
  productSeries?: string | null
  batchNo?: string | null
  expiryDate?: string | null
  isGift?: boolean
  quantity: number
  stockOnHand?: number | null
  unitPrice?: number | null
  amount?: number | null
  remark?: string | null
  // procurement 特有
  requestQuantity?: number | null
  // sale 特有
  saleFlowNo?: string | null
  customerRemaining?: number | null
  verificationName?: string | null
  verificationCode?: string | null
  // scrap 特有
  scrapReason?: string | null
  itemUsage?: string | null
}

/** 列表筛选公共结构 */
export interface InventoryListFilters {
  marketId?: string
  storeId?: string
  docSubtype?: string
  status?: InventoryDocStatus
  startDate?: string
  endDate?: string
  /** 搜索：单据号 / 产品编号 / 产品名 / 顾客名（仅 sale） */
  search?: string
  page?: number
  pageSize?: number
}

/** 单条列表行公共结构 + 各类型扩展 */
export interface InventoryOrderRow {
  id: string
  docSubtype?: string
  status: InventoryDocStatus
  storeId: string
  storeName?: string | null
  docDate: string
  totalQuantity: number | null
  createdBy: string
  createdByName?: string | null
  confirmedBy?: string | null
  confirmedByName?: string | null
  confirmedAt?: string | null
  remark?: string | null
  createdAt: string
  updatedAt: string
  // 各类型扩展
  customerName?: string | null
  counterpartStoreId?: string | null
  counterpartStoreName?: string | null
  isDispatcher?: boolean
  receiveQuantity?: number | null
}

export interface PaginatedInventoryOrders {
  data: InventoryOrderRow[]
  total: number
}
