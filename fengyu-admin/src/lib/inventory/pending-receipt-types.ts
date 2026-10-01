/** #361 明细级收货跟进，两视图共用筛选及无金额列契约。 */
export type PendingReceiptKind = 'store' | 'market'

export interface PendingReceiptFilters {
  kind?: string
  market?: string
  store?: string
  start?: string
  end?: string
}

export interface PendingReceiptRow {
  id: string
  recipientId: string
  recipientName: string
  marketId: string | null
  marketName: string | null
  docDate: string
  docId: string
  skuId: string
  skuName: string
  batchNo: string
  sentQuantity: number
  receivedQuantity: number
  pendingQuantity: number
  transitDays: number
}

export interface PendingReceiptPage {
  rows: PendingReceiptRow[]
  total: number
  page: number
  pageSize: number
}

export interface PendingReceiptOptions {
  markets: Array<{ id: string; name: string }>
  stores: Array<{ id: string; name: string; marketId: string | null }>
}
