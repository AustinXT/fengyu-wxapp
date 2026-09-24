// packageMy/pickup/pickup-by-customer.ts — 提货：顾客视角 + 录入
import { callStaffApi } from '../../utils/cloud'
import { MemberLevelBadgeData, withMemberLevelBadgeClasses } from '../../utils/member-level-badge'
import { isManager, requireManager } from '../../utils/role'
import { INVENTORY_LINKAGE_ENABLED } from '../../utils/feature-flags'
import { formatAmount } from '../../utils/number'

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
  paidQuantity: number
  remaining: number
  /** 顾客实际单价（numeric 以字符串下发） */
  unitRealPrice: string | number | null
  storeId: string
  storeName: string | null
  /** 下单日期（sale_orders.sale_order_datetime 的上海日历日，服务端已格式化成 YYYY-MM-DD） */
  orderDate?: string | null
  /** 展示用：顾客实际单价（WXML 不能调方法，在 ts 里格式化好） */
  unitRealPriceText?: string
}

/**
 * 按销售单分组后的一组（#350）：会议 §2.11「选顾客 → 选销售单 → 领取」，
 * 顾客出库必须能对上是哪张销售单的货。组头显示销售单号、下单日期、开单门店。
 */
interface PickupOrderGroup {
  saleOrderId: string
  orderDate: string
  storeName: string
  items: PickupItem[]
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
  // 防御性兜底：sale_items.unit_real_price 是 NOT NULL，服务端还会 `?? '0'`，真实链路到不了这支；
  // 但 null / '' 经 Number() 会变成 0、显示成 ¥0.00 冒充赠品，所以缺值仍显示 --
  const raw = item.unitRealPrice
  const price = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return {
    ...item,
    specName: normalizeSpecName(item.productName, item.specName),
    unitRealPriceText: Number.isFinite(price) ? `¥${formatAmount(price)}` : '--',
  }
}

/** 按销售单分组，组的顺序沿用服务端排序（最近付款在前）中该单第一次出现的位置。 */
function groupPickupItemsByOrder(items: PickupItem[]): PickupOrderGroup[] {
  const groups: PickupOrderGroup[] = []
  const byOrder: Record<string, PickupOrderGroup> = {}
  for (const item of items) {
    let group = byOrder[item.saleOrderId]
    if (!group) {
      group = {
        saleOrderId: item.saleOrderId,
        orderDate: item.orderDate || '--',
        storeName: item.storeName || item.storeId || '--',
        items: [],
      }
      byOrder[item.saleOrderId] = group
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

/** 清单与分组一起落 data：分组给 WXML 渲染，平铺清单给点选时按 saleItemId 查找 */
function pickupListData(raw: PickupItem[] | null | undefined) {
  const items = (raw || []).map(normalizePickupItem)
  return { items, groups: groupPickupItemsByOrder(items) }
}

Page({
  data: {
    keyword: '',
    customers: [] as Customer[],
    selectedCustomer: null as Customer | null,
    items: [] as PickupItem[],
    groups: [] as PickupOrderGroup[],
    loadingItems: false,
    isManager: false,
    inventoryLinkageEnabled: INVENTORY_LINKAGE_ENABLED,
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
    this.setData({ selectedCustomer: customer, loadingItems: true, items: [], groups: [] })
    try {
      const items = await callStaffApi<PickupItem[]>('order.availablePickupItems', {
        clientUserId: customer.clientUserId,
      })
      // 请求在途时用户可能已改选另一位顾客：旧请求后返回会把 A 的清单挂到 B 的头下，
      // 接着录入的提货就记在 A 的权益上（createPickup 只认 saleItemId）。
      if (this.data.selectedCustomer?.clientUserId !== customer.clientUserId) return
      this.setData({ ...pickupListData(items), loadingItems: false })
    } catch (err: any) {
      if (this.data.selectedCustomer?.clientUserId !== customer.clientUserId) return
      this.setData({ loadingItems: false })
      wx.showToast({ title: err?.message || '加载失败', icon: 'none' })
    }
  },

  onBackToSearch() {
    this.setData({ selectedCustomer: null, items: [], groups: [] })
  },

  async onPickupTap(e: WechatMiniprogram.CustomEvent) {
    if (!this.ensureManagerAccess()) return
    // 分组后是两层 wx:for，内层 index 只是组内序号，必须按 saleItemId 定位
    const saleItemId = String(e.currentTarget.dataset.saleItemId || '')
    const item = this.data.items.find((row) => row.saleItemId === saleItemId)
    if (!item) return
    this.setData({
      pickupDialog: {
        visible: true,
        saleItemId: item.saleItemId,
        sourceSaleItemIds: item.sourceSaleItemIds || [item.saleItemId],
        productName: formatProductName(item.productName, item.specName),
        remaining: item.remaining,
        inventorySkuOptions: [],
        inventoryReady: !INVENTORY_LINKAGE_ENABLED,
        loadingInventorySkuOptions: INVENTORY_LINKAGE_ENABLED,
        quantity: 1,
        remark: '',
        submitting: false,
      },
    })
    if (!INVENTORY_LINKAGE_ENABLED) return
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
    if (!INVENTORY_LINKAGE_ENABLED) {
      this.setData({ 'pickupDialog.quantity': quantity })
      return
    }
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
    if (INVENTORY_LINKAGE_ENABLED) {
      if (d.inventorySkuOptions.length === 0) {
        wx.showToast({ title: '该商品尚未配置库存组成', icon: 'none' })
        return
      }
      const insufficient = d.inventorySkuOptions.find((item) => item.availableQuantity < item.requiredQuantity)
      if (insufficient) {
        wx.showToast({ title: `${insufficient.productName || '库存商品'}库存不足`, icon: 'none' })
        return
      }
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
    } catch (err: any) {
      wx.showToast({ title: err?.message || '提货失败', icon: 'none' })
      return
    } finally {
      this.setData({ 'pickupDialog.submitting': false })
    }
    // 刷新清单单独 try：提货已成功时刷新失败只提示刷新失败，不能覆盖成「提货失败」——
    // 用户会以为没提上再点一次，而 idempotencyKey 含 Date.now()，重复提交会真的再出库一次。
    const customer = this.data.selectedCustomer
    if (!customer) return
    try {
      const items = await callStaffApi<PickupItem[]>('order.availablePickupItems', {
        clientUserId: customer.clientUserId,
      })
      // 刷新在途时已改选别的顾客：丢弃结果，别把 A 的清单挂到 B 的头下
      if (this.data.selectedCustomer?.clientUserId !== customer.clientUserId) return
      // 走与首次加载同一个归一化 + 分组：原先这里直接 setData 原始清单，规格名不去重、单价不格式化
      this.setData(pickupListData(items))
    } catch (err: any) {
      wx.showToast({ title: '提货已成功，清单刷新失败，请重新选择顾客', icon: 'none' })
    }
  },

  onNavToList() {
    if (!this.ensureManagerAccess()) return
    wx.navigateTo({ url: '/packageMy/pickup/pickup-list' })
  },
})
