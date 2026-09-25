// packageMy/inventory/form.ts — 门店库存业务办理
import { callStaffApi } from '../../utils/cloud'
import { getCurrentStoreId, requireInventoryStoreOperate } from '../../utils/role'
import { ReportableSkuSearch, SKU_PAGE_SIZE } from '../../utils/reportable-sku-search'
import { isValidStocktakeQuantity } from '../../utils/stocktake'

type OperateDocType = '门店报货' | '分院调货出库' | '院退货' | '院产品报损' | '分院库存盘点'
// stocktakeSku（#352）：门店盘点按 SKU 录实盘数，账面数由 createDoc 在提交时汇总写入，前端不传
type ItemMode = 'reportableSku' | 'stockLot' | 'stocktakeSku'

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
  /** 门店报货：本店库存参考；盘点不下发（盲盘），恒 0 且不展示 */
  stockReference: number
  /** 盘点：本店是否有货（只用于排序提示，不含数量） */
  inStock: boolean
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
  '分院库存盘点': {
    title: '门店盘点',
    itemMode: 'stocktakeSku',
    needsTargetStore: false,
    needsReason: false,
  },
}

function validDocType(value: string): value is OperateDocType {
  return Object.prototype.hasOwnProperty.call(FORM_CONFIG, value)
}

function displaySku(item: Pick<ReportableSku, 'skuName' | 'specName' | 'productCode'>): string {
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
    isStocktake: false,
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
    // 盘点：已加入明细的 SKU（WXML 不能调方法，选品弹层据此标「已添加」）
    addedSkuIds: {} as Record<string, boolean>,
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

  _skuSearch: null as ReportableSkuSearch<ReportableSku> | null,

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
      isStocktake: config.itemMode === 'stocktakeSku',
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
      // 可报货产品不在这里预拉：打开选品弹层时按关键词分页检索（utils/reportable-sku-search）
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
    // 取消防抖并作废在途检索：页面卸载后回来的结果不再 setData
    this._skuSearch?.dispose()
  },

  /** 选品检索状态机（懒创建：只有门店报货与门店盘点用得到） */
  skuSearch(): ReportableSkuSearch<ReportableSku> {
    if (!this._skuSearch) {
      this._skuSearch = new ReportableSkuSearch<ReportableSku>({
        fetchPage: async (keyword, page) => {
          if (this.data.itemMode === 'stocktakeSku') {
            // 盘点候选不限可报货（#352），且不带账面数
            const res = await callStaffApi<{ items: Omit<ReportableSku, 'displayName' | 'stockReference'>[]; total: number }>(
              'inventory.stocktakeSkuOptions',
              { locationId: this.data.sourceStoreId, keyword: keyword || undefined, page, pageSize: SKU_PAGE_SIZE },
            )
            return {
              total: res.total,
              items: (res.items || []).map((item) => ({
                ...item,
                stockReference: 0,
                inStock: Boolean(item.inStock),
                displayName: displaySku(item),
              })),
            }
          }
          const res = await callStaffApi<{ items: Omit<ReportableSku, 'displayName' | 'inStock'>[]; total: number }>(
            'inventory.reportableSkuOptions',
            { locationId: this.data.sourceStoreId, keyword: keyword || undefined, page, pageSize: SKU_PAGE_SIZE },
          )
          return {
            total: res.total,
            items: (res.items || []).map((item) => ({
              ...item,
              stockReference: Number(item.stockReference || 0),
              inStock: false,
              displayName: displaySku(item),
            })),
          }
        },
        onState: (patch) => this.setData(patch),
      })
    }
    return this._skuSearch
  },

  onOpenSkuPicker() {
    if (!this.data.sourceStoreId) {
      wx.showToast({ title: '请先在门店模式选择门店', icon: 'none' })
      return
    }
    this.setData({ showSkuPicker: true })
    // 关掉再开保留上次的关键词与结果
    this.skuSearch().open()
  },

  onRetrySkuPage() {
    this.skuSearch().retry()
  },

  onLoadMoreSku() {
    this.skuSearch().loadMore()
  },

  onCloseSkuPicker() {
    this.setData({ showSkuPicker: false })
  },

  onSkuKeywordChange(e: WechatMiniprogram.CustomEvent) {
    // van-search 边缘事件形态下 detail 可能不是字符串
    const value = typeof e.detail === 'string' ? e.detail : ''
    this.setData({ skuKeyword: value })
    this.skuSearch().onKeyword(value)
  },

  onSkuKeywordClear() {
    this.setData({ skuKeyword: '' })
    this.skuSearch().clearKeyword()
  },

  onSkuListReachBottom() {
    this.skuSearch().loadMore()
  },

  onSelectSku(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index)
    const sku = this.data.skuOptions[index]
    if (!sku) return
    // 盘点一个 SKU 只能一行（账面数按 主体+SKU 汇总，重复行会重复计差异）：选的时候就挡住
    if (this.data.itemMode === 'stocktakeSku' && this.data.addedSkuIds[sku.skuId]) {
      wx.showToast({ title: '该产品已在盘点明细中，请先删除原行', icon: 'none' })
      return
    }
    // 已选产品独立保存一份：之后换关键词、列表里不再有它，展示名称也不受影响
    this.setData({ selectedSku: { ...sku }, showSkuPicker: false })
  },

  onClearSelectedSku() {
    this.setData({ selectedSku: null, quantityInput: '' })
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
    if (this.data.itemMode === 'stocktakeSku') {
      this.addStocktakeItem()
      return
    }
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

  /**
   * 盘点明细（#352）：实盘数可以是 0（货架上没有 = 盘亏），但**留空不行**——
   * Number('') 是 0，不拦就把「没填」当成「实盘 0」。同一 SKU 不合并、直接拒绝：
   * 两次录入是「补录」还是「改数」说不清，让用户删掉原行重录。
   */
  addStocktakeItem() {
    const sku = this.data.selectedSku
    if (!sku) {
      wx.showToast({ title: '请选择盘点产品', icon: 'none' })
      return
    }
    if (this.data.addedSkuIds[sku.skuId]) {
      wx.showToast({ title: '该产品已在盘点明细中，请先删除原行', icon: 'none' })
      return
    }
    const input = this.data.quantityInput.trim()
    if (!isValidStocktakeQuantity(input)) {
      wx.showToast({ title: '请填写实盘数（0 或正数，最多两位小数）', icon: 'none' })
      return
    }
    const items: DraftItem[] = [...this.data.items, {
      key: sku.skuId,
      skuId: sku.skuId,
      skuName: sku.skuName,
      specName: sku.specName,
      batchNo: '',
      quantity: Number(input),
      stockReference: 0,
      reason: '',
    }]
    this.setData({
      items,
      addedSkuIds: { ...this.data.addedSkuIds, [sku.skuId]: true },
      quantityInput: '',
      selectedSku: null,
    })
  },

  onRemoveItem(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.items.length) return
    const removed = this.data.items[index]
    const items = this.data.items.filter((_, itemIndex) => itemIndex !== index)
    const addedSkuIds = { ...this.data.addedSkuIds }
    delete addedSkuIds[removed.skuId]
    this.setData({ items, addedSkuIds })
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
    // 盘点：选了产品、填了实盘却没点「添加明细」，提交会把这一行静默丢掉——
    // 漏掉的 SKU 既不算盘亏也不算相符，结论就偏了（#352）
    if (this.data.isStocktake && this.data.selectedSku) {
      wx.showToast({ title: '还有未加入的盘点产品，请先点「添加明细」或清除', icon: 'none' })
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
      // 成功后保持 submitting=true 直到跳走：跳转前的 700ms 里按钮若恢复可点，
      // 再点一次就会建出第二张单（盘点单会有两个不同时点的账面快照）
      setTimeout(() => {
        wx.redirectTo({
          url: `/packageMy/inventory/detail?id=${encodeURIComponent(result.id)}`,
          // 跳转失败（页面栈满等）时单据已建成，恢复按钮只会引出重复建单；提示去列表查看
          fail: () => {
            wx.showToast({ title: '已提交，请返回库存记录查看', icon: 'none', duration: 3000 })
          },
        })
      }, 700)
    } catch (err: any) {
      this.setData({ submitting: false })
      wx.showToast({ title: err?.message || '提交失败', icon: 'none' })
    }
  },
})
