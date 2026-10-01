// packageMy/inventory/detail.ts — 库存单据详情（只读；门店报货草稿可继续编辑 / 删除，#348）
import { callStaffApi } from '../../utils/cloud'
import { formatDateTime } from '../../utils/formatters'
import { canOperateStoreInventory, getCurrentStoreId } from '../../utils/role'
import { isStocktakeDocType, stocktakeDiffDisplay, stocktakeSummary } from '../../utils/stocktake'

const STATUS_KEY_MAP: Record<string, string> = {
  '已完成': 'done',
  '草稿': 'draft',
  '已取消': 'cancelled',
  '待审批': 'pending',
  '待收货': 'pending',
  '已驳回': 'rejected',
}

interface ItemRow {
  id: number
  skuId: string
  skuName: string
  specName: string | null
  batchNo: string | null
  quantity: number
  /** 盘点单账面数（提交时按 主体+SKU 汇总）；非盘点单 / 修复前的历史盘点单为 null */
  stockSnapshot: number | null
  reason?: string | null
  // 盘点单前端派生（#352）：差异 = 实盘 − 账面，不落库
  diffText?: string
  diffKey?: string
}

interface LineageRow {
  direction: string
  relationType: string
  docId: string
  docType: string
  status: string
  docDate: string
  totalQuantity: number
  linkedQuantity: number
}

interface InventoryDetail {
  id: string
  docType: string
  status: string
  statusKey?: string
  sourceOrgNodeId: string | null
  sourceOrgNodeName: string | null
  /** 发起门店的库存主体 id（门店 = store_id），判断草稿是不是当前门店的（#348） */
  sourceLocationId?: string | null
  targetOrgNodeId: string | null
  targetOrgNodeName: string | null
  docDate: string
  totalQuantity: number
  remark: string | null
  confirmedAt: string | null
  customerName: string | null
  employeeName: string | null
  supplierName: string | null
  trackingNo: string | null
  relatedSaleOrderId: string | null
  auditRemark: string | null
  lineage: LineageRow[]
  items: ItemRow[]
}

Page({
  data: {
    id: '',
    detail: null as InventoryDetail | null,
    loading: true,
    canReceive: false,
    // 门店报货草稿（#348）：继续编辑 / 删除草稿入口；云端 updateDraft/submitDraft/deleteDraft 同样只认本店草稿
    canEditDraft: false,
    submitting: false,
    isStocktake: false,
    stocktakeSummary: '',
  },

  onLoad(query: { id?: string }) {
    const id = query.id || ''
    this.setData({ id })
    this.load()
  },

  _loadSeq: 0,

  async load() {
    if (!this.data.id) return
    // 请求序号：onShow 刷新与删除后的刷新可能并发，迟到的旧响应不能把「已取消」改回「草稿」
    const seq = ++this._loadSeq
    this.setData({ loading: true })
    try {
      const detail = await callStaffApi<InventoryDetail>('inventory.docDetail', {
        id: this.data.id,
      })
      if (seq !== this._loadSeq) return
      const isStocktake = Boolean(detail && isStocktakeDocType(detail.docType))
      // 缺字段一律按 null（未记账面）处理，不能让 undefined 参与减法算出 NaN
      const stocktakeItems = isStocktake && detail
        ? (detail.items || []).map((item) => ({ ...item, stockSnapshot: item.stockSnapshot ?? null }))
        : []
      const formatted = detail
        ? {
            ...detail,
            confirmedAt: detail.confirmedAt ? formatDateTime(detail.confirmedAt) : detail.confirmedAt,
            statusKey: STATUS_KEY_MAP[detail.status] || 'unknown',
            lineage: detail.lineage || [],
            items: isStocktake
              ? stocktakeItems.map((item) => ({ ...item, ...stocktakeDiffDisplay(item) }))
              : detail.items,
          }
        : detail
      const canReceive = Boolean(
        // 收货确认是门店写操作，云端 confirmReceive 仅认 inventory:store_operate，
        // 不能随入口（canAccessInventory 三动作并集）放宽。
        canOperateStoreInventory()
        &&
        detail
        && detail.status === '待收货'
        && ['分院配货', '分院调货出库'].includes(detail.docType),
      )
      // 只给「当前门店」的草稿：云端 updateDraft/submitDraft 按当前门店核对单头门店，别店草稿点进去必报错
      const canEditDraft = Boolean(
        canOperateStoreInventory() && detail && detail.docType === '门店报货' && detail.status === '草稿'
        && detail.sourceLocationId && detail.sourceLocationId === getCurrentStoreId(),
      )
      this.setData({
        detail: formatted,
        loading: false,
        canReceive,
        canEditDraft,
        isStocktake,
        stocktakeSummary: isStocktake ? stocktakeSummary(stocktakeItems) : '',
      })
    } catch (err: any) {
      if (seq !== this._loadSeq) return
      this.setData({ loading: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
    }
  },

  onShow() {
    // 从编辑页提交 / 存草稿返回时刷新（首次进入由 onLoad 加载）
    if (this.data.detail) this.load()
  },

  onEditDraftTap() {
    if (!this.data.canEditDraft) return
    wx.navigateTo({
      url: `/packageMy/inventory/form?docType=${encodeURIComponent('门店报货')}&id=${encodeURIComponent(this.data.id)}`,
    })
  },

  onDeleteDraftTap() {
    if (!this.data.canEditDraft || this.data.submitting) return
    wx.showModal({
      title: '删除草稿',
      content: '删除后该草稿作废（单据保留为已取消），不能恢复。',
      confirmColor: '#C0322A',
      success: (result) => {
        if (result.confirm) this.deleteDraft()
      },
    })
  },

  async deleteDraft() {
    if (this.data.submitting || !this.data.id) return
    this.setData({ submitting: true })
    try {
      await callStaffApi<{ id: string }>('inventory.deleteDraft', { id: this.data.id })
      wx.showToast({ title: '草稿已删除', icon: 'success' })
      await this.load()
    } catch (err: any) {
      wx.showToast({ title: err?.message || '删除失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onConfirmReceiveTap() {
    if (!this.data.canReceive || this.data.submitting) return
    wx.showModal({
      title: '确认收货',
      content: '确认后将登记入库，且不能撤销。',
      confirmColor: '#C0322A',
      success: (result) => {
        if (result.confirm) this.confirmReceive()
      },
    })
  },

  async confirmReceive() {
    if (this.data.submitting || !this.data.id) return
    this.setData({ submitting: true })
    try {
      await callStaffApi<{ inboundDocId: string }>('inventory.confirmReceive', { id: this.data.id })
      wx.showToast({ title: '收货成功', icon: 'success' })
      await this.load()
    } catch (err: any) {
      wx.showToast({ title: err?.message || '收货失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
