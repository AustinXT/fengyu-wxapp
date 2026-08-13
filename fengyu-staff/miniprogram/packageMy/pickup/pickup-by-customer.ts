// packageMy/pickup/pickup-by-customer.ts — 提货：顾客视角 + 录入
import { callStaffApi } from '../../utils/cloud'
import { MemberLevelBadgeData, withMemberLevelBadgeClasses } from '../../utils/member-level-badge'
import { isManager, requireManager } from '../../utils/role'

interface Customer extends MemberLevelBadgeData {
  clientUserId: string
  name: string
  phone: string
  memberLevel?: string | null
}

interface PickupItem {
  saleItemId: string
  saleItemGroupId?: string | null
  sourceSaleItemIds?: string[]
  saleOrderId: string
  skuId: string | null
  productName: string | null
  specName: string | null
  quantity: number
  pickedUpQuantity: number
  remaining: number
  storeId: string
  storeName: string | null
}

interface PickupInventorySkuOption {
  inventorySkuId: string
  productCode: string
  productName: string | null
  specName: string | null
  quantityPerSaleUnit: number
  availableQuantity: number
  requiredQuantity: number
  label: string
}

function normalizeSpecName(productName?: string | null, specName?: string | null): string | null {
  const name = (productName || '').trim()
  const spec = (specName || '').trim()
  return spec && spec !== name ? spec : null
}

function formatProductName(productName?: string | null, specName?: string | null): string {
  const name = (productName || '').trim()
  const spec = normalizeSpecName(name, specName)
  if (!name && !spec) return '商品'
  if (!name) return spec || '商品'
  return spec ? `${name} ${spec}` : name
}

function normalizePickupItem(item: PickupItem): PickupItem {
  return {
    ...item,
    specName: normalizeSpecName(item.productName, item.specName),
  }
}

Page({
  data: {
    keyword: '',
    customers: [] as Customer[],
    selectedCustomer: null as Customer | null,
    items: [] as PickupItem[],
    loadingItems: false,
    isManager: false,
    pickupDialog: {
      visible: false,
      saleItemId: '',
      sourceSaleItemIds: [] as string[],
      productName: '',
      remaining: 0,
      inventorySkuOptions: [] as PickupInventorySkuOption[],
      inventoryReady: false,
      loadingInventorySkuOptions: false,
      quantity: 1,
      remark: '',
      submitting: false,
    },
  },

  onLoad() {
    this.ensureManagerAccess()
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

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value })
  },

  async onSearch() {
    if (!this.ensureManagerAccess()) return
    const keyword = (this.data.keyword || '').trim()
    if (!keyword) {
      wx.showToast({ title: '请输入手机号或姓名', icon: 'none' })
      return
    }
    try {
      // 提货选顾客：需支持临时跨店顾客，故传 crossStore=true 放宽搜索范围
      // （后端返回 is_cross_store_temp 标记，业务层根据实际需要判断是否允许跨店提货）
      const res = await callStaffApi<Customer[]>('customer.search', {
        keyword: keyword.match(/^\d/) ? undefined : keyword,
        phone: keyword.match(/^\d{6,}$/) ? keyword : undefined,
        crossStore: true,
      })
      this.setData({ customers: withMemberLevelBadgeClasses(res || []) })
    } catch (err: any) {
      wx.showToast({ title: err?.message || '搜索失败', icon: 'none' })
    }
  },

  async onSelectCustomer(e: WechatMiniprogram.CustomEvent) {
    if (!this.ensureManagerAccess()) return
    const idx = Number(e.currentTarget.dataset.idx)
    const customer = this.data.customers[idx]
    if (!customer) return
    this.setData({ selectedCustomer: customer, loadingItems: true, items: [] })
    try {
      const items = await callStaffApi<PickupItem[]>('order.availablePickupItems', {
        clientUserId: customer.clientUserId,
      })
      this.setData({ items: (items || []).map(normalizePickupItem), loadingItems: false })
    } catch (err: any) {
      this.setData({ loadingItems: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
    }
  },

  onBackToSearch() {
    this.setData({ selectedCustomer: null, items: [] })
  },

  async onPickupTap(e: WechatMiniprogram.CustomEvent) {
    if (!this.ensureManagerAccess()) return
    const idx = Number(e.currentTarget.dataset.idx)
    const item = this.data.items[idx]
    if (!item) return
    this.setData({
      pickupDialog: {
        visible: true,
        saleItemId: item.saleItemId,
        sourceSaleItemIds: item.sourceSaleItemIds || [item.saleItemId],
        productName: formatProductName(item.productName, item.specName),
        remaining: item.remaining,
        inventorySkuOptions: [],
        inventoryReady: false,
        loadingInventorySkuOptions: true,
        quantity: 1,
        remark: '',
        submitting: false,
      },
    })
    try {
      const inventorySkuOptions = await callStaffApi<PickupInventorySkuOption[]>(
        'order.pickupInventorySkuOptions',
        { saleItemId: item.saleItemId },
      )
      const options = (inventorySkuOptions || []).map((option) => ({
        ...option,
        requiredQuantity: option.quantityPerSaleUnit,
      }))
      this.setData({
        'pickupDialog.inventorySkuOptions': options,
        'pickupDialog.inventoryReady': options.length > 0
          && options.every((option) => option.availableQuantity >= option.requiredQuantity),
        'pickupDialog.loadingInventorySkuOptions': false,
      })
    } catch (err: any) {
      this.setData({ 'pickupDialog.loadingInventorySkuOptions': false })
      wx.showToast({ title: err?.message || '加载销售商品组成失败', icon: 'none' })
    }
  },

  onPickupQtyInput(e: WechatMiniprogram.Input) {
    const v = parseInt(e.detail.value, 10)
    const quantity = isNaN(v) || v < 1 ? 1 : v
    const options = this.data.pickupDialog.inventorySkuOptions.map((option) => ({
      ...option,
      requiredQuantity: option.quantityPerSaleUnit * quantity,
    }))
    this.setData({
      'pickupDialog.quantity': quantity,
      'pickupDialog.inventorySkuOptions': options,
      'pickupDialog.inventoryReady': options.length > 0
        && options.every((option) => option.availableQuantity >= option.requiredQuantity),
    })
  },

  onPickupRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ 'pickupDialog.remark': e.detail.value })
  },

  closePickupDialog() {
    this.setData({ 'pickupDialog.visible': false })
  },

  async submitPickup() {
    if (!this.ensureManagerAccess()) return
    const d = this.data.pickupDialog
    if (d.quantity <= 0 || d.quantity > d.remaining) {
      wx.showToast({ title: `数量必须在 1 到 ${d.remaining} 之间`, icon: 'none' })
      return
    }
    if (d.inventorySkuOptions.length === 0) {
      wx.showToast({ title: '该商品尚未配置库存组成', icon: 'none' })
      return
    }
    const insufficient = d.inventorySkuOptions.find((item) => item.availableQuantity < item.requiredQuantity)
    if (insufficient) {
      wx.showToast({ title: `${insufficient.productName || '库存商品'}库存不足`, icon: 'none' })
      return
    }
    this.setData({ 'pickupDialog.submitting': true })
    try {
      await callStaffApi('order.createPickup', {
        saleItemId: d.saleItemId,
        ...(d.sourceSaleItemIds.length > 1 ? { saleItemIds: d.sourceSaleItemIds } : {}),
        pickupQuantity: d.quantity,
        remark: d.remark || undefined,
        idempotencyKey: `pickup-${d.saleItemId}-${Date.now()}`,
      })
      wx.showToast({ title: '提货成功', icon: 'success' })
      this.setData({ 'pickupDialog.visible': false })
      // 刷新清单
      if (this.data.selectedCustomer) {
        const customer = this.data.selectedCustomer
        const items = await callStaffApi<PickupItem[]>('order.availablePickupItems', {
          clientUserId: customer.clientUserId,
        })
        this.setData({ items: items || [] })
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message || '提货失败', icon: 'none' })
    } finally {
      this.setData({ 'pickupDialog.submitting': false })
    }
  },

  onNavToList() {
    if (!this.ensureManagerAccess()) return
    wx.navigateTo({ url: '/packageMy/pickup/pickup-list' })
  },
})
