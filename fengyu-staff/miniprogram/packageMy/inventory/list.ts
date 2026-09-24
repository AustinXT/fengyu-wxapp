// packageMy/inventory/list.ts — 库存单据列表（只读）
import { callStaffApi } from '../../utils/cloud'

type DocCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'
type CreateDocType = '门店报货' | '分院调货出库' | '院退货' | '院产品报损'

const TITLE_BY_CATEGORY: Record<DocCategory, string> = {
  procurement: '采购入库',
  sale: '销售出库',
  transfer: '门店调拨',
  scrap: '报损出库',
}

const DOC_TYPES_BY_CATEGORY: Record<DocCategory, string[]> = {
  procurement: ['门店报货', '分院配货', '院入库'],
  sale: ['院顾客产品出库', '院顾客退货', '院退货'],
  transfer: ['分院调货出库', '分院调货入库'],
  scrap: ['院产品报损'],
}

const CREATE_ACTION_BY_CATEGORY: Record<DocCategory, { docType: CreateDocType; label: string }> = {
  procurement: { docType: '门店报货', label: '发起门店报货' },
  sale: { docType: '院退货', label: '提交院退货' },
  transfer: { docType: '分院调货出库', label: '发起同市场调货' },
  scrap: { docType: '院产品报损', label: '提交产品报损' },
}

interface InventoryRow {
  id: string
  docType: string
  status: string
  statusKey?: string
  sourceOrgNodeId: string | null
  sourceOrgNodeName: string | null
  targetOrgNodeId: string | null
  targetOrgNodeName: string | null
  docDate: string
  totalQuantity: number
  customerName?: string | null
  employeeName?: string | null
}

interface OrgNodeOption {
  orgNodeId: string
  parentOrgNodeId: string | null
  orgNodeType: '总部' | '市场' | '门店'
  name: string
  isActive: boolean
  label: string
}

const STATUS_KEY_MAP: Record<string, string> = {
  '已完成': 'done',
  '草稿': 'draft',
  '已取消': 'cancelled',
  '待审批': 'pending',
  '待收货': 'pending',
  '已驳回': 'rejected',
}

function withStatusKey(row: InventoryRow): InventoryRow {
  return { ...row, statusKey: STATUS_KEY_MAP[row.status] || 'unknown' }
}

Page({
  data: {
    docCategory: 'procurement' as DocCategory,
    title: '',
    createDocType: '' as CreateDocType | '',
    createLabel: '',
    subtypes: [] as string[],
    subtypeFilter: '',
    statusFilter: '',
    keyword: '',
    orgNodeOptions: [] as OrgNodeOption[],
    selectedOrgNodeIndex: -1,
    selectedOrgNodeId: '',
    items: [] as InventoryRow[],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    hasMore: true,
    hasShownOnce: false,
  },

  onLoad(query: { docCategory?: DocCategory; status?: string }) {
    const docCategory = (query.docCategory || 'procurement') as DocCategory
    const title = TITLE_BY_CATEGORY[docCategory] || '库存单据'
    const subtypes = DOC_TYPES_BY_CATEGORY[docCategory] || []
    const createAction = CREATE_ACTION_BY_CATEGORY[docCategory]
    this.setData({
      docCategory,
      title,
      subtypes,
      createDocType: createAction?.docType || '',
      createLabel: createAction?.label || '',
      statusFilter: query.status ? decodeURIComponent(query.status) : '',
    })
    wx.setNavigationBarTitle({ title })
    this.initialize()
  },

  onShow() {
    if (!this.data.hasShownOnce) {
      this.setData({ hasShownOnce: true })
      return
    }
    this.refresh()
  },

  async refresh() {
    this.setData({ items: [], page: 1, hasMore: true })
    await this.loadPage()
  },

  async initialize() {
    try {
      const res = await callStaffApi<{ items: Omit<OrgNodeOption, 'label'>[] }>('inventory.docOrgOptions')
      const orgNodeOptions = (res.items || []).map((item) => ({
        ...item,
        label: `${item.orgNodeType} · ${item.name}${item.isActive ? '' : '（已停用）'}`,
      }))
      this.setData({ orgNodeOptions })
    } catch (err: any) {
      wx.showToast({ title: err?.message || '加载组织范围失败', icon: 'none' })
    }
    await this.refresh()
  },

  async loadPage() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ loading: true })
    try {
      const typeFilter = this.data.subtypeFilter
        ? { docType: this.data.subtypeFilter }
        : { docTypes: DOC_TYPES_BY_CATEGORY[this.data.docCategory] }
      const res = await callStaffApi<{
        items: InventoryRow[]
        total: number
        page: number
        pageSize: number
      }>('inventory.docList', {
        page: this.data.page,
        pageSize: this.data.pageSize,
        ...typeFilter,
        status: this.data.statusFilter || undefined,
        keyword: this.data.keyword || undefined,
        orgNodeId: this.data.selectedOrgNodeId || undefined,
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

  onOrgNodeChange(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value)
    const selected = this.data.orgNodeOptions[index]
    this.setData({
      selectedOrgNodeIndex: Number.isInteger(index) ? index : -1,
      selectedOrgNodeId: selected?.orgNodeId || '',
    })
    this.refresh()
  },

  onClearOrgNode() {
    this.setData({ selectedOrgNodeIndex: -1, selectedOrgNodeId: '' })
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
      url: `/packageMy/inventory/detail?id=${encodeURIComponent(id)}`,
    })
  },

  onCreateTap() {
    if (!this.data.createDocType) return
    wx.navigateTo({
      url: `/packageMy/inventory/form?docType=${encodeURIComponent(this.data.createDocType)}`,
    })
  },
})
