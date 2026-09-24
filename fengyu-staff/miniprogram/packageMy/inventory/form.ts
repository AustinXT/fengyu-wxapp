// packageMy/inventory/form.ts — 门店库存业务办理
import { callStaffApi } from '../../utils/cloud'
import { getCurrentStoreId, requireInventoryStoreOperate } from '../../utils/role'

type OperateDocType = '门店报货' | '分院调货出库' | '院退货' | '院产品报损'
type ItemMode = 'reportableSku' | 'stockLot'

interface FormConfig {
  title: string
  itemMode: ItemMode
  needsTargetStore: boolean
  needsReason: boolean
}

interface ReportableSku {
  skuId: string
  productCode: string
  skuName: string
  specName: string | null
  supplier: string | null
  productSeries: string | null
  stockReference: number
  displayName: string
}

interface StockLot {
  id: number
  skuId: string
  skuName: string
  specName: string | null
  batchNo: string
  expiryDate: string | null
  isGift: boolean
  quantityOnHand: number
  displayName: string
}

interface StoreOption {
  storeId: string
  orgNodeId: string
  storeName: string
}

interface DraftItem {
  key: string
  lotId?: number
  skuId: string
  skuName: string
  specName: string | null
  batchNo: string
  quantity: number
  stockReference: number
  reason: string
}

const FORM_CONFIG: Record<OperateDocType, FormConfig> = {
  '门店报货': {
    title: '门店报货',
    itemMode: 'reportableSku',
    needsTargetStore: false,
    needsReason: false,
  },
  '分院调货出库': {
    title: '同市场门店调货',
    itemMode: 'stockLot',
    needsTargetStore: true,
    needsReason: false,
  },
  '院退货': {
    title: '院退货',
    itemMode: 'stockLot',
    needsTargetStore: false,
    needsReason: false,
  },
  '院产品报损': {
    title: '产品报损',
    itemMode: 'stockLot',
    needsTargetStore: false,
    needsReason: true,
  },
}

function validDocType(value: string): value is OperateDocType {
  return Object.prototype.hasOwnProperty.call(FORM_CONFIG, value)
}

function displaySku(item: Omit<ReportableSku, 'displayName'>): string {
  return [item.skuName, item.specName, item.productCode].filter(Boolean).join(' · ')
}

function displayLot(item: Omit<StockLot, 'displayName'>): string {
  const batch = item.batchNo ? `批号 ${item.batchNo}` : '无批号'
  return [item.skuName, item.specName, batch].filter(Boolean).join(' · ')
}

Page({
  data: {
    docType: '' as OperateDocType | '',
    title: '',
    sourceStoreId: '',
    sourceStoreName: '',
    itemMode: 'stockLot' as ItemMode,
    needsTargetStore: false,
    needsReason: false,
    skuOptions: [] as ReportableSku[],
    stockOptions: [] as StockLot[],
    storeOptions: [] as StoreOption[],
    selectedSkuIndex: -1,
    selectedLotIndex: -1,
    selectedStoreIndex: -1,
    selectedSku: null as ReportableSku | null,
    selectedLot: null as StockLot | null,
    selectedStore: null as StoreOption | null,
    quantityInput: '',
    reasonInput: '',
    remark: '',
    items: [] as DraftItem[],
    loadingOptions: false,
    submitting: false,
  },

  onLoad(query: { docType?: string }) {
    if (!requireInventoryStoreOperate()) {
      setTimeout(() => wx.navigateBack(), 500)
      return
    }
    const docType = decodeURIComponent(query.docType || '')
    if (!validDocType(docType)) {
      wx.showToast({ title: '不支持的库存业务', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    const config = FORM_CONFIG[docType]
    const app = getApp<IAppOption>()
    const sourceStoreId = getCurrentStoreId()
    const sourceStoreName = app.globalData.scopedStores.find((store) => (
      store.storeId === sourceStoreId
    ))?.storeName || app.globalData.boundStoreName || ''
    this.setData({
      docType,
      title: config.title,
      sourceStoreId,
      sourceStoreName,
      itemMode: config.itemMode,
      needsTargetStore: config.needsTargetStore,
      needsReason: config.needsReason,
    })
    wx.setNavigationBarTitle({ title: config.title })
    if (!sourceStoreId) {
      wx.showToast({ title: '请先在门店模式选择门店', icon: 'none' })
      return
    }
    this.loadOptions()
  },

  async loadOptions() {
    if (!this.data.sourceStoreId) return
    this.setData({ loadingOptions: true })
    try {
      if (this.data.itemMode === 'reportableSku') {
        const res = await callStaffApi<{ items: Omit<ReportableSku, 'displayName'>[] }>(
          'inventory.reportableSkuOptions',
          { locationId: this.data.sourceStoreId, pageSize: 100 },
        )
        const skuOptions = (res.items || []).map((item) => ({
          ...item,
          stockReference: Number(item.stockReference || 0),
          displayName: displaySku(item),
        }))
        this.setData({ skuOptions })
      } else {
        const res = await callStaffApi<{ items: Omit<StockLot, 'displayName'>[] }>(
          'inventory.stockList',
          { locationId: this.data.sourceStoreId, onlyPositive: true, pageSize: 100 },
        )
        const stockOptions = (res.items || []).map((item) => ({
          ...item,
          quantityOnHand: Number(item.quantityOnHand || 0),
          displayName: displayLot(item),
        }))
        this.setData({ stockOptions })
      }
      if (this.data.needsTargetStore) {
        const res = await callStaffApi<{ items: StoreOption[] }>('inventory.storeOptions', {
          sourceStoreId: this.data.sourceStoreId,
        })
        this.setData({ storeOptions: res.items || [] })
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message || '加载选项失败', icon: 'none' })
    } finally {
      this.setData({ loadingOptions: false })
    }
  },

  onSkuChange(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value)
    const selectedSku = this.data.skuOptions[index] || null
    this.setData({ selectedSkuIndex: index, selectedSku })
  },

  onLotChange(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value)
    const selectedLot = this.data.stockOptions[index] || null
    this.setData({ selectedLotIndex: index, selectedLot })
  },

  onStoreChange(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value)
    const selectedStore = this.data.storeOptions[index] || null
    this.setData({ selectedStoreIndex: index, selectedStore })
  },

  onQuantityInput(e: WechatMiniprogram.Input) {
    this.setData({ quantityInput: e.detail.value || '' })
  },

  onReasonInput(e: WechatMiniprogram.Input) {
    this.setData({ reasonInput: e.detail.value || '' })
  },

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ remark: e.detail.value || '' })
  },

  onAddItem() {
    const quantity = Number(this.data.quantityInput)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      wx.showToast({ title: '请输入大于 0 的数量', icon: 'none' })
      return
    }
    const reason = this.data.reasonInput.trim()
    if (this.data.needsReason && !reason) {
      wx.showToast({ title: '请填写报损原因', icon: 'none' })
      return
    }

    let next: DraftItem | null = null
    if (this.data.itemMode === 'reportableSku') {
      const sku = this.data.selectedSku
      if (!sku) {
        wx.showToast({ title: '请选择可报货产品', icon: 'none' })
        return
      }
      next = {
        key: sku.skuId,
        skuId: sku.skuId,
        skuName: sku.skuName,
        specName: sku.specName,
        batchNo: '',
        quantity,
        stockReference: sku.stockReference,
        reason: '',
      }
    } else {
      const lot = this.data.selectedLot
      if (!lot) {
        wx.showToast({ title: '请选择库存批次', icon: 'none' })
        return
      }
      if (quantity > lot.quantityOnHand) {
        wx.showToast({ title: '数量不能超过当前库存', icon: 'none' })
        return
      }
      next = {
        key: String(lot.id),
        lotId: lot.id,
        skuId: lot.skuId,
        skuName: lot.skuName,
        specName: lot.specName,
        batchNo: lot.batchNo,
        quantity,
        stockReference: lot.quantityOnHand,
        reason,
      }
    }

    const draft = next!
    const existingIndex = this.data.items.findIndex((item) => item.key === draft.key)
    const items = [...this.data.items]
    if (existingIndex >= 0) {
      const total = items[existingIndex].quantity + draft.quantity
      if (this.data.itemMode === 'stockLot' && total > items[existingIndex].stockReference) {
        wx.showToast({ title: '数量不能超过当前库存', icon: 'none' })
        return
      }
      items[existingIndex] = { ...items[existingIndex], quantity: total, reason: draft.reason || items[existingIndex].reason }
    } else {
      items.push(draft)
    }
    this.setData({
      items,
      quantityInput: '',
      reasonInput: '',
      selectedSkuIndex: -1,
      selectedLotIndex: -1,
      selectedSku: null,
      selectedLot: null,
    })
  },

  onRemoveItem(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.items.length) return
    const items = this.data.items.filter((_, itemIndex) => itemIndex !== index)
    this.setData({ items })
  },

  async onSubmit() {
    if (this.data.submitting) return
    if (this.data.items.length === 0) {
      wx.showToast({ title: '请至少添加一条明细', icon: 'none' })
      return
    }
    if (this.data.needsTargetStore && !this.data.selectedStore) {
      wx.showToast({ title: '请选择接收门店', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const result = await callStaffApi<{ id: string }>('inventory.createDoc', {
        docType: this.data.docType,
        storeId: this.data.sourceStoreId,
        targetOrgNodeId: this.data.selectedStore?.orgNodeId || undefined,
        remark: this.data.remark.trim() || undefined,
        items: this.data.items.map((item) => ({
          lotId: item.lotId,
          skuId: item.skuId,
          quantity: item.quantity,
          reason: item.reason || undefined,
        })),
      })
      wx.showToast({ title: '提交成功', icon: 'success' })
      setTimeout(() => {
        wx.redirectTo({
          url: `/packageMy/inventory/detail?id=${encodeURIComponent(result.id)}`,
        })
      }, 700)
    } catch (err: any) {
      wx.showToast({ title: err?.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
