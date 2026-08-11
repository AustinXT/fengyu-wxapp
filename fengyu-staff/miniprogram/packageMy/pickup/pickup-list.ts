// packageMy/pickup/pickup-list.ts — 提货记录列表
import { callStaffApi } from '../../utils/cloud'
import { formatDateTime } from '../../utils/formatters'
import { isManager, requireManager } from '../../utils/role'

interface PickupRow {
  id: number
  saleItemId: string
  pickupQuantity: number
  storeName: string | null
  clientName: string | null
  clientPhone: string | null
  confirmedByName: string | null
  productName: string | null
  specName: string | null
  itemQuantity: number | null
  itemPickedUpQuantity: number | null
  remark: string | null
  createdAt: string
}

function normalizeSpecName(productName?: string | null, specName?: string | null): string | null {
  const name = (productName || '').trim()
  const spec = (specName || '').trim()
  return spec && spec !== name ? spec : null
}

Page({
  data: {
    items: [] as PickupRow[],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    hasMore: true,
    startDate: '',
    endDate: '',
    isManager: false,
  },

  onLoad() {
    if (!this.ensureManagerAccess()) return
    this.refresh()
  },

  onShow() {
    this.ensureManagerAccess()
  },

  ensureManagerAccess(): boolean {
    const manager = isManager()
    this.setData({ isManager: manager })
    if (manager) return true
    requireManager()
    wx.navigateBack()
    return false
  },

  async refresh() {
    if (!this.ensureManagerAccess()) return
    this.setData({ items: [], page: 1, hasMore: true })
    await this.loadPage()
  },

  async loadPage() {
    if (!this.ensureManagerAccess()) return
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ loading: true })
    try {
      const res = await callStaffApi<{
        items: PickupRow[]
        total: number
      }>('order.pickupRecordsList', {
        page: this.data.page,
        pageSize: this.data.pageSize,
        startDate: this.data.startDate || undefined,
        endDate: this.data.endDate || undefined,
      })
      const fresh = (res.items || []).map(r => ({
        ...r,
        specName: normalizeSpecName(r.productName, r.specName),
        createdAt: formatDateTime(r.createdAt),
      }))
      const merged = [...this.data.items, ...fresh]
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

  onDateFromChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ startDate: e.detail.value as string })
    this.refresh()
  },

  onDateToChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ endDate: e.detail.value as string })
    this.refresh()
  },

  clearDates() {
    this.setData({ startDate: '', endDate: '' })
    this.refresh()
  },

  onReachBottom() {
    this.loadPage()
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },
})
