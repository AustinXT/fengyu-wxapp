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

/** 门店报货选品弹层每页条数；staffApi reportableSkuOptions 上限 100 */
const SKU_PAGE_SIZE = 20
/** 关键词防抖：逐字输入不逐字发请求（#339） */
const SKU_SEARCH_DEBOUNCE_MS = 300

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
    // 门店报货选品弹层（#339）：服务端检索 + 分页，替换原来只拉前 100 条的原生 picker
    showSkuPicker: false,
    skuKeyword: '',
    skuPage: 0,
    skuTotal: 0,
    skuHasMore: true,
    skuLoading: false,
    skuError: '',
  },

  _skuSearchTimer: null as ReturnType<typeof setTimeout> | null,
  /** 只有最后一次发出的检索能落地：关键词连打与上拉翻页交错时丢弃先发后到的旧结果 */
  _skuRequestSeq: 0,

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
      // 可报货产品不在这里预拉：打开选品弹层时按关键词分页检索（loadSkuPage）
      if (this.data.itemMode === 'stockLot') {
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

  onUnload() {
    if (this._skuSearchTimer) clearTimeout(this._skuSearchTimer)
    this._skuSearchTimer = null
  },

  onOpenSkuPicker() {
    if (!this.data.sourceStoreId) {
      wx.showToast({ title: '请先在门店模式选择门店', icon: 'none' })
      return
    }
    this.setData({ showSkuPicker: true })
    // 首次打开或上次加载失败时拉第一页；关掉再开保留上次的关键词与结果
    if (this.data.skuPage === 0 || this.data.skuError) this.loadSkuPage(true)
  },

  onCloseSkuPicker() {
    this.setData({ showSkuPicker: false })
  },

  onSkuKeywordChange(e: WechatMiniprogram.CustomEvent) {
    // van-search 边缘事件形态下 detail 可能不是字符串
    const value = typeof e.detail === 'string' ? e.detail : ''
    this.setData({ skuKeyword: value })
    if (this._skuSearchTimer) clearTimeout(this._skuSearchTimer)
    this._skuSearchTimer = setTimeout(() => {
      this._skuSearchTimer = null
      this.loadSkuPage(true)
    }, SKU_SEARCH_DEBOUNCE_MS)
  },

  onSkuKeywordClear() {
    if (this._skuSearchTimer) clearTimeout(this._skuSearchTimer)
    this._skuSearchTimer = null
    this.setData({ skuKeyword: '' })
    this.loadSkuPage(true)
  },

  onSkuListReachBottom() {
    if (this.data.skuLoading || !this.data.skuHasMore || this.data.skuError) return
    this.loadSkuPage(false)
  },

  async loadSkuPage(reset: boolean) {
    const seq = ++this._skuRequestSeq
    const page = reset ? 1 : this.data.skuPage + 1
    const patch: Record<string, unknown> = { skuLoading: true, skuError: '' }
    if (reset) Object.assign(patch, { skuOptions: [], skuPage: 0, skuTotal: 0, skuHasMore: true })
    this.setData(patch)
    try {
      const keyword = this.data.skuKeyword.trim()
      const res = await callStaffApi<{ items: Omit<ReportableSku, 'displayName'>[]; total: number }>(
        'inventory.reportableSkuOptions',
        { locationId: this.data.sourceStoreId, keyword: keyword || undefined, page, pageSize: SKU_PAGE_SIZE },
      )
      if (seq !== this._skuRequestSeq) return
      const incoming = (res.items || []).map((item) => ({
        ...item,
        stockReference: Number(item.stockReference || 0),
        displayName: displaySku(item),
      }))
      const existing = reset ? [] : this.data.skuOptions
      const seen = new Set(existing.map((item) => item.skuId))
      const skuOptions = existing.concat(incoming.filter((item) => !seen.has(item.skuId)))
      const skuTotal = Number(res.total || 0)
      this.setData({
        skuOptions,
        skuPage: page,
        skuTotal,
        // 以服务端 total 为准；本页不足一页也视为到底（total 统计口径万一漂移也不会无限上拉）
        skuHasMore: skuOptions.length < skuTotal && incoming.length === SKU_PAGE_SIZE,
      })
    } catch (err: any) {
      if (seq !== this._skuRequestSeq) return
      this.setData({ skuError: err?.message || '加载可报货产品失败' })
    } finally {
      if (seq === this._skuRequestSeq) this.setData({ skuLoading: false })
    }
  },

  onSelectSku(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index)
    const sku = this.data.skuOptions[index]
    if (!sku) return
    // 已选产品独立保存一份：之后换关键词、列表里不再有它，展示名称也不受影响
    this.setData({ selectedSku: { ...sku }, showSkuPicker: false })
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
