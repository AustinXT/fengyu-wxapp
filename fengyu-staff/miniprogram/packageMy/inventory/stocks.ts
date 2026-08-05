// packageMy/inventory/stocks.ts — 门店实时库存（中心库存表）
import { callStaffApi } from '../../utils/cloud'

interface StockRow {
  id: number
  storeId: string
  storeName: string | null
  skuId: string
  skuName: string
  productType: string
  batchNo: string
  expiryDate: string | null
  quantityOnHand: number
  remark: string | null
  updatedAt: string
}

Page({
  data: {
    keyword: '',
    items: [] as StockRow[],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    hasMore: true,
  },

  onLoad() {
    this.refresh()
  },

  async refresh() {
    this.setData({ items: [], page: 1, hasMore: true })
    await this.loadPage()
  },

  async loadPage() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ loading: true })
    try {
      const res = await callStaffApi<{
        items: StockRow[]
        total: number
        page: number
        pageSize: number
      }>('inventory.stockList', {
        page: this.data.page,
        pageSize: this.data.pageSize,
        keyword: this.data.keyword || undefined,
        onlyPositive: false,
      })
      const merged = [...this.data.items, ...(res.items || [])]
      this.setData({
        items: merged,
        total: res.total,
        page: this.data.page + 1,
        hasMore: merged.length < res.total,
        loading: false,
      })
    } catch (err: any) {
      this.setData({ loading: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
    }
  },

  onSearchInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value || '' })
  },

  onSearchConfirm() {
    this.refresh()
  },

  onReachBottom() {
    this.loadPage()
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },
})
