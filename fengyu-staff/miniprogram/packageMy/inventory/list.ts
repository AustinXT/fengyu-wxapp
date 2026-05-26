// packageMy/inventory/list.ts — 库存单据列表（只读）
import { callStaffApi } from '../../utils/cloud'

type DocCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'

const TITLE_BY_CATEGORY: Record<DocCategory, string> = {
  procurement: '采购入库',
  sale: '销售出库',
  transfer: '门店调拨',
  scrap: '报损出库',
}

const SUBTYPES_BY_CATEGORY: Record<DocCategory, string[]> = {
  procurement: ['院报货', '院入库', '退货出库'],
  sale: ['销售出库', '顾客退货'],
  transfer: ['调拨出库', '调拨入库'],
  scrap: [],
}

interface InventoryRow {
  id: string
  docSubtype: string | null
  status: string
  statusKey?: string
  storeId: string
  storeName: string | null
  docDate: string
  totalQuantity: number | null
  customerName?: string | null
  counterpartStoreName?: string | null
  createdByName: string | null
}

const STATUS_KEY_MAP: Record<string, string> = {
  '已完成': 'done',
  '草稿': 'draft',
  '已取消': 'cancelled',
}

function withStatusKey(row: InventoryRow): InventoryRow {
  return { ...row, statusKey: STATUS_KEY_MAP[row.status] || 'unknown' }
}

Page({
  data: {
    docCategory: 'procurement' as DocCategory,
    title: '',
    subtypes: [] as string[],
    subtypeFilter: '',
    statusFilter: '',
    keyword: '',
    items: [] as InventoryRow[],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    hasMore: true,
  },

  onLoad(query: { docCategory?: DocCategory }) {
    const docCategory = (query.docCategory || 'procurement') as DocCategory
    const title = TITLE_BY_CATEGORY[docCategory] || '库存单据'
    const subtypes = SUBTYPES_BY_CATEGORY[docCategory] || []
    this.setData({ docCategory, title, subtypes })
    wx.setNavigationBarTitle({ title })
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
        items: InventoryRow[]
        total: number
        page: number
        pageSize: number
      }>('inventory.list', {
        docCategory: this.data.docCategory,
        page: this.data.page,
        pageSize: this.data.pageSize,
        docSubtype: this.data.subtypeFilter || undefined,
        status: this.data.statusFilter || undefined,
        keyword: this.data.keyword || undefined,
      })
      const merged = [...this.data.items, ...((res.items || []).map(withStatusKey))]
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

  onSubtypeTap(e: WechatMiniprogram.CustomEvent) {
    const value = (e.currentTarget.dataset.value as string) || ''
    this.setData({ subtypeFilter: value })
    this.refresh()
  },

  onStatusTap(e: WechatMiniprogram.CustomEvent) {
    const value = (e.currentTarget.dataset.value as string) || ''
    this.setData({ statusFilter: value })
    this.refresh()
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

  onItemTap(e: WechatMiniprogram.CustomEvent) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: `/packageMy/inventory/detail?docCategory=${this.data.docCategory}&id=${encodeURIComponent(id)}`,
    })
  },
})
