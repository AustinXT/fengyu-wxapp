// packageMy/inventory/detail.ts — 库存单据详情（只读）
import { callStaffApi } from '../../utils/cloud'
import { formatDateTime, formatDate } from '../../utils/formatters'

type DocCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'

const STATUS_KEY_MAP: Record<string, string> = {
  '已完成': 'done',
  '草稿': 'draft',
  '已取消': 'cancelled',
}

interface ItemRow {
  id: number
  productCode: string
  productName: string
  specName: string | null
  batchNo: string | null
  quantity: number
  unitPrice: number | null
  amount: number | null
  scrapReason?: string | null
  saleFlowNo?: string | null
  customerRemaining?: number | null
}

interface InventoryDetail {
  id: string
  docSubtype: string | null
  status: string
  statusKey?: string
  storeId: string
  storeName: string | null
  docDate: string
  totalQuantity: number | null
  remark: string | null
  createdByName: string | null
  confirmedByName: string | null
  confirmedAt: string | null
  customerName: string | null
  counterpartStoreName: string | null
  isDispatcher: boolean | null
  receiveQuantity: number | null
  relatedDocNo: string | null
  isCompleted: boolean | null
  sourceDate: string | null
  sourceQuantity: number | null
  items: ItemRow[]
}

Page({
  data: {
    docCategory: 'procurement' as DocCategory,
    id: '',
    detail: null as InventoryDetail | null,
    loading: true,
  },

  onLoad(query: { docCategory?: DocCategory; id?: string }) {
    const docCategory = (query.docCategory || 'procurement') as DocCategory
    const id = query.id || ''
    this.setData({ docCategory, id })
    this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      const detail = await callStaffApi<InventoryDetail>('inventory.detail', {
        docCategory: this.data.docCategory,
        id: this.data.id,
      })
      const formatted = detail
        ? {
            ...detail,
            docDate: detail.docDate ? formatDate(detail.docDate) : detail.docDate,
            sourceDate: detail.sourceDate ? formatDate(detail.sourceDate) : detail.sourceDate,
            confirmedAt: detail.confirmedAt ? formatDateTime(detail.confirmedAt) : detail.confirmedAt,
            statusKey: STATUS_KEY_MAP[detail.status] || 'unknown',
          }
        : detail
      this.setData({ detail: formatted, loading: false })
    } catch (err: any) {
      this.setData({ loading: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
    }
  },
})
