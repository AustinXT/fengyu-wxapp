// packageMy/inventory/detail.ts — 库存单据详情（只读）
import { callStaffApi } from '../../utils/cloud'
import { formatDateTime } from '../../utils/formatters'
import { canAccessInventory } from '../../utils/role'

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
  reason?: string | null
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
  sourceLocationId: string | null
  sourceLocationName: string | null
  targetLocationId: string | null
  targetLocationName: string | null
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
    submitting: false,
  },

  onLoad(query: { id?: string }) {
    const id = query.id || ''
    this.setData({ id })
    this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      const detail = await callStaffApi<InventoryDetail>('inventory.docDetail', {
        id: this.data.id,
      })
      const formatted = detail
        ? {
            ...detail,
            confirmedAt: detail.confirmedAt ? formatDateTime(detail.confirmedAt) : detail.confirmedAt,
            statusKey: STATUS_KEY_MAP[detail.status] || 'unknown',
            lineage: detail.lineage || [],
          }
        : detail
      const canReceive = Boolean(
        canAccessInventory()
        &&
        detail
        && detail.status === '待收货'
        && ['分院配货', '分院调货出库'].includes(detail.docType),
      )
      this.setData({ detail: formatted, loading: false, canReceive })
    } catch (err: any) {
      this.setData({ loading: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
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
