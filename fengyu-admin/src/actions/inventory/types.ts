

export type InventoryDocStatus = '草稿' | '已完成' | '已取消'

export type InventoryProcurementSubtype = '院报货' | '院入库' | '退货出库'
export type InventorySaleSubtype = '销售出库' | '顾客退货'
export type InventoryTransferSubtype = '调拨出库' | '调拨入库'


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
  
  requestQuantity?: number | null
  
  saleFlowNo?: string | null
  customerRemaining?: number | null
  verificationName?: string | null
  verificationCode?: string | null
  
  scrapReason?: string | null
  itemUsage?: string | null
}


export interface InventoryListFilters {
  storeId?: string
  docSubtype?: string
  status?: InventoryDocStatus
  startDate?: string
  endDate?: string
  
  search?: string
  page?: number
  pageSize?: number
}


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
