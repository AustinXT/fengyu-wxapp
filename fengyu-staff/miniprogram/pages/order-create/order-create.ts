// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { calcCartTotal, calcHalfPriceTotal } from '../../utils/cart-calc';
import { evaluateCouponAfterCartChange } from '../../utils/coupon-evaluator';

const app = getApp<IAppOption>();

/**
 * 顶部商品类型 4 选 1（PR-B 改版）
 * - 组合套餐：走 BundlePicker 子视图（products.is_bundle=true）
 * - 普通商品：productKind IN ('护理项目','家居产品') AND isBundle != true
 * - 体验卡 / 充值卡：productKind='体验卡' / '充值卡'（grid 布局）
 */
const PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡'] as const;
type ProductKindChoice = typeof PRODUCT_KIND_CHOICES[number];

/**
 * 订单类型（PR-C §C1）—— 与 DB 原生枚举 sale_order_type 对齐，仅使用前 3 值
 * - 销售单：默认，正常计价（支持 couponId / 行级 customPrice）
 * - 内部单：managerOnly，所有 SKU 半价（后端计算），禁优惠券/禁改价
 * - 转换单：managerOnly，调 order.createConversion；需要已注册 clientUserId
 */
type SaleOrderType = '销售单' | '内部单' | '转换单';

interface CartItem {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  price: number;
  quantity: number;
  discount: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  /** 预计算：price × quantity（避免 WXML 浮点精度问题） */
  subtotal: string;
  /** 预计算：price × quantity - discount */
  itemTotal: string;
  /** 预计算：内部单半价实付（price × 0.5 × quantity），仅 saleOrderType='内部单' 时展示 */
  halfPriceItemTotal: string;
  /** 前端临时字段：同一套餐生成的多行共享此 id（PR-B §2.2），非 schema 字段 */
  refBundleId?: string;
  /** PR-C §C6：行级自定义单价（仅销售单可用；空字符串=不启用） */
  customPrice?: string;
}

interface Category {
  id: string;
  name: string;
  productKind: string;
}

/** SKU 列表项（从 product.shopInit / product.skuList 返回） */
interface SkuItem {
  skuId: string;
  specName: string;
  categoryId: string;
  categoryName: string;
  productKind: string;
  salesCategory: string;
  price: number;
  specialPrice: number | null;
  sessionCount: number | null;
  productType: string;
  serviceFee: number;
  isShengmei: boolean | null;
  /** 是否为套餐 SKU（关联任一 products.is_bundle=true 则为 true；用于"普通商品"视图过滤） */
  isBundle?: boolean;
}

/** 套餐分组（PR-A 云函数 product.shopInit 返回 mallBundleGroups[]） */
interface BundleGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  skuIds: string[];
}

/** 套餐商品（bundle SPU） */
interface BundleSpu {
  productId: string;
  name: string;
  coverImage: string | null;
  description: string | null;
  price: number;
  specialPrice: number | null;
  groups: BundleGroup[];
}

/** 展示用 SPU 格式（兼容 WXML 模板） */
interface DisplayItem {
  spuId: string;
  spuName: string;
  price: number;
  specialPrice: number | null;
  productKind: string;
  productType: string;
  sessionCount: number | null;
  isBundle?: boolean;
}

interface CustomerInfo {
  id: string;
  name: string;
  phone: string;
  phoneMasked?: string;
}

interface CouponInfo {
  couponId: string;
  name: string;
  discount: number;
  description?: string;
}

interface ShopInitResponse {
  categories: Category[];
  skuList: SkuItem[];
  mallBundleGroups?: BundleSpu[];
}

interface OrderCreateResponse {
  saleOrderId: string;
}

interface CouponAvailableResponse {
  coupons: CouponInfo[];
}

/** 将后端 SKU 项映射为兼容 WXML 的展示格式 */
function skuToDisplay(sku: SkuItem): DisplayItem {
  return {
    spuId: sku.skuId,
    spuName: sku.specName,
    price: Number(sku.specialPrice || sku.price) || 0,
    specialPrice: sku.specialPrice ? Number(sku.specialPrice) : null,
    productKind: sku.productKind,
    productType: sku.productType,
    sessionCount: sku.sessionCount,
    isBundle: !!sku.isBundle,
  }
}

/**
 * 商品类型过滤器（PR-B §1.2）
 * - 普通商品：productKind ∈ {护理项目, 家居产品} 且非 bundle
 * - 体验卡 / 充值卡：按 productKind 匹配
 * - 组合套餐：不走 SKU 列表，由 BundlePicker 接管
 */
function filterSkusByKindChoice(skus: SkuItem[], choice: ProductKindChoice): SkuItem[] {
  if (choice === '组合套餐') return [];
  if (choice === '普通商品') {
    return skus.filter(s => (s.productKind === '护理项目' || s.productKind === '家居产品') && !s.isBundle);
  }
  // 体验卡 / 充值卡
  return skus.filter(s => s.productKind === choice);
}

/** 分类过滤器（按选中商品类型裁剪侧边栏候选分类） */
function filterCategoriesByKindChoice(categories: Category[], choice: ProductKindChoice): Category[] {
  if (choice === '组合套餐') return [];
  if (choice === '普通商品') {
    return categories.filter(c => c.productKind === '护理项目' || c.productKind === '家居产品');
  }
  return categories.filter(c => c.productKind === choice);
}

Page({
  data: {
    isManager: false,
    // 顶部商品类型 4 选 1（PR-B）
    productKindChoices: PRODUCT_KIND_CHOICES as unknown as string[],
    productKindChoiceIndex: 1, // 默认"普通商品"
    productKindChoice: '普通商品' as ProductKindChoice,
    // 商品目录（侧边栏分类 + SKU 列表）
    catalogLoading: false,
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as DisplayItem[],
    // 组合套餐（BundlePicker 数据源）
    bundleSpus: [] as BundleSpu[],
    skuMap: {} as Record<string, SkuItem>,
    /** 卡类型（体验卡/充值卡）→ grid 简化布局 */
    isCardType: false,
    // 购物车
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: '0.00',
    // 结算底部弹层
    showCheckout: false,
    checkoutStep: 0,   // 0=选顾客 2=确认（Step 1 历史遗留编号，已废弃）
    // Step 0: 顾客
    customerPhone: '',
    customerSearching: false,
    customerInfo: null as null | CustomerInfo,
    recentCustomers: [] as CustomerInfo[],
    // Step 2 顶部：订单类型 3 选 1（PR-C §C1）
    saleOrderType: '销售单' as SaleOrderType,
    /** 内部单半价合计（原价 × 0.5 - 每行 discount；discount 禁用时实际始终为 原价 × 0.5） */
    halfPriceTotal: '0.00',
    // Step 2: 确认 + 备注
    remark: '',
    submitting: false,
    /**
     * PR-D1：销售单 / 内部单的支付方式（默认微信）
     * - 仅作用于 saleOrderType ∈ {销售单, 内部单}（转换单的支付方式由 ConversionPanel 内部管理）
     * - 白名单：'微信' | '线下'（暂未支持支付宝，待业务确认）
     */
    paymentMethod: '微信' as '微信' | '线下',
    // 转换单（ConversionPanel 反馈 → 主页记录用于提交）
    conversionSelectedSaleItemIds: [] as string[],
    conversionDeductibleSum: 0,
    conversionPriceDiff: 0,
    conversionPaymentMethod: null as null | '微信' | '线下',
    // 优惠券
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    couponTotal: '',
    showCouponPopup: false,
    availableCoupons: [] as CouponInfo[],
    couponsLoading: false,
    // 指定美容师（可选，用于默认分配）
    preferredStaffWfId: '' as string,
    preferredStaffName: '',
    showStaffPicker: false,
    staffListForPicker: [] as Array<{ staffWfId: string; name: string; department: string }>,
    staffPickerColumns: [] as string[],
  },

  // 所有分类（未过滤）
  _allCategories: [] as Category[],
  // 所有 SKU（未过滤，shopInit 一次性返回全量）
  _allSkus: [] as SkuItem[],
  // SKU 缓存：按 `${productKindChoice}:${categoryId}` 缓存已加载的展示列表
  _spuCache: {} as Record<string, DisplayItem[]>,

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isManager: isManager() });
    if (this._allCategories.length === 0) {
      this.loadShopInit();
    }
    try {
      const recent: CustomerInfo[] = wx.getStorageSync('recentCustomers') || [];
      this.setData({ recentCustomers: recent });
    } catch (_) {}

    // 从商品详情页返回：检查 pendingCartItem
    const pending = app.globalData.pendingCartItem;
    if (pending) {
      app.globalData.pendingCartItem = null;

      // 组合套餐商品不加入购物车，只能直接下单（清空购物车后单独放入）
      if (pending.productType === '组合套餐') {
        const cart: CartItem[] = [{
          spuId: pending.spuId,
          skuId: pending.skuId,
          spuName: pending.spuName,
          specName: pending.specName,
          price: pending.price,
          quantity: pending.quantity,
          discount: 0,
          sessionCount: pending.sessionCount || 0,
          productType: pending.productType,
          workfineItemId: pending.workfineItemId || '',
          subtotal: '', itemTotal: '', halfPriceItemTotal: '',
        }];
        this.updateCart(cart);
      } else {
        const cart = [...this.data.cart];
        // 购物车中有组合套餐商品时不允许混入其他商品
        if (cart.some(c => c.productType === '组合套餐')) {
          wx.showToast({ title: '组合套餐订单需单独下单', icon: 'none' });
          return;
        }
        const existing = cart.findIndex(c => c.skuId === pending.skuId);
        if (existing >= 0) {
          cart[existing].quantity += pending.quantity;
        } else {
          cart.push({
            spuId: pending.spuId,
            skuId: pending.skuId,
            spuName: pending.spuName,
            specName: pending.specName,
            price: pending.price,
            quantity: pending.quantity,
            discount: 0,
            sessionCount: pending.sessionCount || 0,
            productType: pending.productType,
            workfineItemId: pending.workfineItemId || '',
            subtotal: '', itemTotal: '', halfPriceItemTotal: '',
          });
        }
        this.updateCart(cart);
      }
      if (pending.directCheckout) {
        // PR-C §C6：旧 orderType='promotion' 分支删除；saleOrderType 默认 '销售单'
        this.setData({ showCheckout: true, checkoutStep: 0, saleOrderType: '销售单' });
      }
    }
  },

  // ===== 商品目录（三级导航 + 缓存） =====

  async loadShopInit() {
    this.setData({ catalogLoading: true });
    try {
      const data = await callStaffApi<ShopInitResponse>('product.shopInit');
      const categories: Category[] = data.categories || [];
      const rawSkus: SkuItem[] = data.skuList || [];
      const bundleSpus: BundleSpu[] = data.mallBundleGroups || [];

      this._allCategories = categories;
      this._allSkus = rawSkus;
      this._spuCache = {};

      const skuMap: Record<string, SkuItem> = {};
      for (const s of rawSkus) skuMap[s.skuId] = s;

      this.setData({ bundleSpus, skuMap, catalogLoading: false });
      this.applyKindChoice(this.data.productKindChoice);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ catalogLoading: false });
    }
  },

  /**
   * 按 productKindChoice 过滤侧边栏 + SKU 列表
   * 组合套餐不走此路径（由 BundlePicker 接管，主区域通过 wx:if 切视图）
   */
  applyKindChoice(choice: ProductKindChoice) {
    const isCardType = choice === '体验卡' || choice === '充值卡';
    this.setData({ isCardType });

    if (choice === '组合套餐') {
      this.setData({
        categories: [],
        activeCategoryIndex: 0,
        spuList: [],
      });
      return;
    }

    const filtered = filterCategoriesByKindChoice(this._allCategories, choice);
    if (filtered.length === 0) {
      this.setData({
        categories: [],
        activeCategoryIndex: 0,
        spuList: [],
      });
      return;
    }

    const firstCatId = filtered[0].id;
    const cacheKey = `${choice}:${firstCatId}`;
    let list = this._spuCache[cacheKey];
    if (!list) {
      // 首次进入该 choice 的首分类：从 _allSkus 本地过滤
      const skusInCat = this._allSkus.filter(s => s.categoryId === firstCatId);
      list = filterSkusByKindChoice(skusInCat, choice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
    }

    // 先把 activeCategoryIndex 置 -1 强制 van-sidebar 刷新
    this.setData({
      categories: filtered,
      activeCategoryIndex: -1,
      spuList: [],
    }, () => {
      this.setData({ activeCategoryIndex: 0, spuList: list });
    });
  },

  onBigCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as { index?: number })?.index;
    if (typeof index !== 'number' || index === this.data.productKindChoiceIndex) return;
    const nextChoice = PRODUCT_KIND_CHOICES[index];
    if (!nextChoice) return;

    const apply = () => {
      this.setData({
        productKindChoiceIndex: index,
        productKindChoice: nextChoice,
      });
      this.applyKindChoice(nextChoice);
    };

    // 切商品类型时购物车非空 → 确认清空（B4）
    if (this.data.cart.length > 0) {
      wx.showModal({
        title: '切换商品类型',
        content: '切换后将清空购物车，是否继续？',
        confirmColor: '#C0322A',
        success: (res) => {
          if (res.confirm) {
            this.updateCart([]);
            apply();
          }
        },
      });
      return;
    }
    apply();
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as { key?: number })?.key;
    if (typeof index !== 'number') return;
    const { categories, productKindChoice } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const cat = categories[index];
    if (!cat) return;

    const cacheKey = `${productKindChoice}:${cat.id}`;
    const cached = this._spuCache[cacheKey];
    if (cached) {
      this.setData({ activeCategoryIndex: index, spuList: cached });
      return;
    }

    this.setData({ activeCategoryIndex: index, spuList: [] });
    this.loadSpuList(cat.id);
  },

  async loadSpuList(categoryId: string) {
    const { productKindChoice } = this.data;
    const cacheKey = `${productKindChoice}:${categoryId}`;

    // 优先用本地 _allSkus 过滤（shopInit 已返全量）
    const localSkus = this._allSkus.filter(s => s.categoryId === categoryId);
    if (localSkus.length > 0) {
      const list = filterSkusByKindChoice(localSkus, productKindChoice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list });
      return;
    }

    // 本地无缓存兜底：发请求（补 productKind 参数）
    this.setData({ catalogLoading: true });
    try {
      const skus = await callStaffApi<SkuItem[]>('product.skuList', { categoryId });
      // 追加到 _allSkus（便于后续缓存命中）
      this._allSkus = this._allSkus.concat(skus || []);
      const list = filterSkusByKindChoice(skus || [], productKindChoice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list, catalogLoading: false });
    } catch (_) {
      this.setData({ spuList: [], catalogLoading: false });
    }
  },

  // ===== BundlePicker 选完后覆盖购物车 =====

  onBundlePickerSelect(e: WechatMiniprogram.CustomEvent) {
    const { cartItems, bundleName } = (e.detail || {}) as { cartItems?: CartItem[]; bundleName?: string };
    if (!cartItems || cartItems.length === 0) return;
    // 组合套餐独占：直接覆盖 cart（保留 §2.1 决策）
    this.updateCart(cartItems);
    wx.showToast({
      title: bundleName ? `${bundleName} 已加入` : '已加入购物车',
      icon: 'success',
      duration: 1000,
    });
  },

  // ===== SPU 点击 → 跳转详情页 =====

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.spu as DisplayItem;
    if (!item?.spuId) return;

    // SKU 扁平化后直接加入购物车（qty=1）
    const cart = [...this.data.cart];

    // 购物车中有组合套餐行（refBundleId / productType='组合套餐'）时不允许混入其他商品
    if (cart.some(c => c.refBundleId || c.productType === '组合套餐')) {
      wx.showToast({ title: '组合套餐订单需单独下单', icon: 'none' });
      return;
    }

    const existing = cart.findIndex(c => c.skuId === item.spuId);
    if (existing >= 0) {
      if (cart[existing].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      cart[existing].quantity += 1;
    } else {
      cart.push({
        spuId: item.spuId,
        skuId: item.spuId,
        spuName: item.spuName,
        specName: item.spuName,
        price: item.price,
        quantity: 1,
        discount: 0,
        sessionCount: item.sessionCount || 0,
        productType: item.productKind || item.productType,
        workfineItemId: '',
        subtotal: '', itemTotal: '', halfPriceItemTotal: '',
      });
    }
    this.updateCart(cart);
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 800 });
  },

  // ===== 购物车 =====

  onCartItemRemove(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const item = this.data.cart.find(c => c.skuId === skuId);
    // PR-B: 组合套餐生成的多行（refBundleId 同源）整组清空
    if (item?.refBundleId) {
      const refId = item.refBundleId;
      const cart = this.data.cart.filter(c => c.refBundleId !== refId);
      this.updateCart(cart);
      return;
    }
    if (item?.productType === '组合套餐') {
      wx.showToast({ title: '组合套餐项目不可删除', icon: 'none' });
      return;
    }
    const cart = this.data.cart.filter(c => c.skuId !== skuId);
    this.updateCart(cart);
  },

  onCartQtyChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const qty = parseInt(e.detail as unknown as string) || 1;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx >= 0) {
      if (cart[idx].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      cart[idx].quantity = qty;
    }
    this.updateCart(cart);
  },

  onDiscountChange(e: WechatMiniprogram.CustomEvent) {
    // 内部单禁改 discount（UI 已 disabled，防御性再拒一次）
    if (this.data.saleOrderType === '内部单') return;
    const skuId = e.currentTarget.dataset.skuId as string;
    const val = parseFloat(e.detail.value) || 0;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx >= 0) {
      const max = cart[idx].price * cart[idx].quantity;
      cart[idx].discount = val < 0 ? 0 : val > max ? max : val;
    }
    this.updateCart(cart);
  },

  /**
   * PR-C §C6：行级自定义单价（customPrice）。
   * 仅销售单启用；内部单/转换单不显示该输入。空字符串=不启用，后端回落至 SKU 标价。
   */
  onCustomPriceChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.saleOrderType !== '销售单') return;
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = (e.detail?.value ?? '') as string;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx < 0) return;
    const parsed = parseFloat(raw);
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      cart[idx].customPrice = '';
    } else {
      cart[idx].customPrice = String(Math.round(parsed * 100) / 100);
    }
    this.updateCart(cart);
  },

  updateCart(cart: CartItem[]) {
    for (const c of cart) {
      c.subtotal = (c.price * c.quantity).toFixed(2);
      c.itemTotal = (c.price * c.quantity - c.discount).toFixed(2);
      // PR-C §C2：内部单半价行总计（与云函数 create 内部单分支口径对齐）
      const halfUnit = Math.round(c.price * 50) / 100;
      c.halfPriceItemTotal = (halfUnit * c.quantity - (c.discount || 0)).toFixed(2);
    }
    const { count, total } = calcCartTotal(cart);
    const halfPriceTotal = calcHalfPriceTotal(cart);
    const update: Record<string, any> = {
      cart, cartCount: count, cartTotal: total, halfPriceTotal,
    };
    if (this.data.couponDiscount > 0) {
      update.couponTotal = (parseFloat(total) - this.data.couponDiscount).toFixed(2);
    }
    this.setData(update);
    // cart 变动后重新评估已选优惠券（未选券时内部短路，零开销）
    void this.revalidateCoupon();
  },

  // ===== 结算面板 =====

  onOpenCheckout() {
    if (this.data.cart.length === 0) {
      wx.showToast({ title: '请先添加商品', icon: 'none' });
      return;
    }
    this.setData({
      showCheckout: true,
      checkoutStep: 0,
      saleOrderType: '销售单',
      // 重置转换单 state
      conversionSelectedSaleItemIds: [],
      conversionDeductibleSum: 0,
      conversionPriceDiff: 0,
      conversionPaymentMethod: null,
    });
  },

  onCloseCheckout() {
    this.setData({ showCheckout: false });
  },

  // Step 0: 选顾客
  onCustomerPhoneChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerPhone: e.detail as unknown as string, customerInfo: null });
  },

  async onSearchCustomer() {
    const phone = this.data.customerPhone.trim();
    if (!phone || phone.length < 11) {
      wx.showToast({ title: '请输入完整手机号', icon: 'none' });
      return;
    }
    this.setData({ customerSearching: true });
    try {
      const results = await callStaffApi<CustomerInfo[]>('customer.search', { phone });
      const found = results && results[0];
      if (found) {
        this.setData({ customerInfo: found });
      } else {
        this.setData({ customerInfo: { id: '', name: '', phone } });
        wx.showToast({ title: '未注册顾客，将以手机号开单', icon: 'none' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '查询失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onSelectRecentCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = e.currentTarget.dataset.customer as CustomerInfo;
    this.setData({ customerInfo: customer, customerPhone: customer.phone });
  },

  onStep0Next() {
    if (!this.data.customerInfo) {
      wx.showToast({ title: '请先选择顾客', icon: 'none' });
      return;
    }
    // PR-B: Step 1 "选开单模式" 已废除；Step 0 → Step 2 直跳确认页。
    // Step 1 当前为空占位，PR-C 将填入"订单类型 3 选 1"。
    this.setData({ checkoutStep: 2 });
  },

  /**
   * PR-C §C1 / §C5 — 订单类型 3 选 1 切换
   * - managerOnly 守卫：内部单 / 转换单仅店长可切（前端 UI 也按 isManager 显示 disabled 态）
   * - 转换单守卫：clientUserId 必填（未注册顾客禁用转换单 tab）
   * - 切走销售单/转换单后清空优惠券（内部单/转换单均不允许券）
   * - 切出转换单清空转换 state
   */
  onSelectSaleOrderType(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.type as SaleOrderType;
    if (!next || next === this.data.saleOrderType) return;
    if ((next === '内部单' || next === '转换单') && !this.data.isManager) {
      wx.showToast({ title: '仅店长可用', icon: 'none' });
      return;
    }
    if (next === '转换单' && !this.data.customerInfo?.id) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    const update: Record<string, any> = { saleOrderType: next };
    if (next !== '销售单' && this.data.selectedCoupon) {
      update.selectedCoupon = null;
      update.couponDiscount = 0;
      update.couponTotal = '';
    }
    if (next !== '转换单') {
      update.conversionSelectedSaleItemIds = [];
      update.conversionDeductibleSum = 0;
      update.conversionPriceDiff = 0;
      update.conversionPaymentMethod = null;
    } else {
      // PR-D1：切到转换单时重置销售/内部单的 paymentMethod，避免脏值（转换单走 ConversionPanel 内部 picker）
      update.paymentMethod = '微信';
    }
    // 切到非销售单时清空行级 customPrice（后端内部单/转换单均不接受 customPrice）
    if (next !== '销售单') {
      const cart = this.data.cart.map(c => ({ ...c, customPrice: '' }));
      update.cart = cart;
      this.setData(update);
      this.updateCart(cart);
      return;
    }
    this.setData(update);
  },

  /** PR-C §C3 — ConversionPanel 子组件 change 事件：同步选卡/差额到主 state */
  onConversionPanelChange(e: WechatMiniprogram.CustomEvent) {
    const { selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod } = (e.detail || {}) as {
      selectedSaleItemIds?: string[];
      deductibleSum?: number;
      priceDiff?: number;
      paymentMethod?: '微信' | '线下' | null;
    };
    this.setData({
      conversionSelectedSaleItemIds: selectedSaleItemIds || [],
      conversionDeductibleSum: Number(deductibleSum) || 0,
      conversionPriceDiff: Number(priceDiff) || 0,
      conversionPaymentMethod: paymentMethod ?? null,
    });
  },

  /**
   * PR-D1 — 支付方式切换（仅销售单/内部单生效；转换单的支付方式由 ConversionPanel 内部管理）
   * 白名单：'微信' | '线下'
   */
  onPaymentMethodTap(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.method as '微信' | '线下';
    if (!next || (next !== '微信' && next !== '线下')) return;
    if (next === this.data.paymentMethod) return;
    this.setData({ paymentMethod: next });
  },

  // Step 2: 确认订单
  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as unknown as string) ?? '' });
  },

  onStep2Back() {
    // PR-B: 直接返回 Step 0（跳过空占位 Step 1）
    this.setData({ checkoutStep: 0 });
  },

  // ===== 优惠券选择 =====

  async onSelectCoupon() {
    const { customerInfo, cart } = this.data;
    if (!customerInfo?.phone) return;

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: c.price * c.quantity - c.discount,
      }));
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      this.setData({ availableCoupons: data?.coupons || [] });
    } catch {
      this.setData({ availableCoupons: [] });
    } finally {
      this.setData({ couponsLoading: false });
    }
  },

  onCloseCouponPopup() {
    this.setData({ showCouponPopup: false });
  },

  onCouponPick(e: WechatMiniprogram.TouchEvent) {
    const { couponId, name, discount } = e.currentTarget.dataset as {
      couponId: string; name: string; discount: number;
    };
    const d = Number(discount) || 0;
    const couponTotal = (parseFloat(this.data.cartTotal) - d).toFixed(2);
    this.setData({
      selectedCoupon: { couponId, name, discount: d },
      couponDiscount: d,
      couponTotal,
      showCouponPopup: false,
    });
  },

  onClearCoupon() {
    this.setData({ selectedCoupon: null, couponDiscount: 0, couponTotal: '', showCouponPopup: false });
  },

  /**
   * cart 变动后重新评估已选优惠券
   * - 未选券 / 未选顾客时短路返回
   * - 原券仍在可用列表 → discount 变化则更新（品项券可能因 cart 变化而变）
   * - 原券已不在列表 → 清空选择并 Toast 提示
   * 决策纯函数在 utils/coupon-evaluator.ts，便于单测
   */
  async revalidateCoupon() {
    const { selectedCoupon, customerInfo, cart } = this.data;
    if (!selectedCoupon || !customerInfo?.phone) return;
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: Math.round((c.price * c.quantity - c.discount) * 100) / 100,
      }));
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      const result = evaluateCouponAfterCartChange(
        selectedCoupon.couponId,
        selectedCoupon.discount,
        data?.coupons || []
      );
      if (result.kind === 'cleared') {
        this.setData({
          selectedCoupon: null,
          couponDiscount: 0,
          couponTotal: '',
        });
        wx.showToast({ title: '商品已变动，原优惠券已失效', icon: 'none' });
      } else if (result.kind === 'updated') {
        this.setData({
          selectedCoupon: { ...selectedCoupon, discount: result.discount },
          couponDiscount: result.discount,
          couponTotal: (parseFloat(this.data.cartTotal) - result.discount).toFixed(2),
        });
      }
    } catch {
      // 评估失败保持原状，提交时由后端兜底拒绝
    }
  },

  // ===== 指定美容师 =====

  async onSelectPreferredStaff() {
    if (this.data.staffListForPicker.length === 0) {
      try {
        const data = await callStaffApi<{ staffList: Array<{ staffWfId: string; name: string; department: string }> }>('staff.list');
        const list = data?.staffList || [];
        this.setData({
          staffListForPicker: list,
          staffPickerColumns: ['不指定', ...list.map(s => `${s.name}（${s.department || '未分组'}）`)],
        });
      } catch {
        return;
      }
    }
    this.setData({ showStaffPicker: true });
  },

  onStaffPickerClose() {
    this.setData({ showStaffPicker: false });
  },

  onPreferredStaffConfirm(e: WechatMiniprogram.CustomEvent) {
    const picked = e.detail.value as string;
    if (picked === '不指定') {
      this.setData({ preferredStaffWfId: '', preferredStaffName: '', showStaffPicker: false });
      return;
    }
    const idx = this.data.staffPickerColumns.indexOf(picked) - 1; // offset by "不指定"
    const staff = this.data.staffListForPicker[idx];
    if (staff) {
      this.setData({
        preferredStaffWfId: staff.staffWfId,
        preferredStaffName: staff.name,
        showStaffPicker: false,
      });
    }
  },

  async onSubmitOrder() {
    const { customerInfo, saleOrderType, cart, remark, submitting } = this.data;
    if (!customerInfo || submitting) return;

    // PR-C §C4 — 分支到 createConversion
    if (saleOrderType === '转换单') {
      return this._submitConversion();
    }

    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<OrderCreateResponse>('order.create', {
        clientUserId: customerInfo.id || null,
        clientPhone: customerInfo.phone,
        clientName: customerInfo.name || customerInfo.phone,
        // PR-D1：使用 state（销售单 / 内部单可选 微信 / 线下）；转换单不走此分支
        paymentMethod: this.data.paymentMethod,
        saleOrderType,
        items: cart.map(c => {
          const payloadItem: Record<string, any> = {
            skuId: c.skuId,
            workfineItemId: c.workfineItemId,
            spuName: c.spuName,
            specName: c.specName,
            quantity: c.quantity,
            // 内部单 discount 前端禁用，但若有残值会被后端校验；销售单透传
            discount: saleOrderType === '内部单' ? 0 : c.discount,
          };
          // PR-C §C6 — 行级自定义单价（仅销售单，后端字段名 customPrice）
          if (saleOrderType === '销售单' && c.customPrice && parseFloat(c.customPrice) > 0) {
            payloadItem.customPrice = parseFloat(c.customPrice);
          }
          return payloadItem;
        }),
        remark,
        // 内部单不允许优惠券（云函数已守卫）
        couponId: saleOrderType === '销售单'
          ? (this.data.selectedCoupon?.couponId || undefined)
          : undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        selectedCoupon: null,
        couponDiscount: 0,
        paymentMethod: '微信',
      });
      wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '开单失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * PR-C §C3/§C4 — 转换单提交：order.createConversion
   * - convertOutSaleItemIds 来自 ConversionPanel change 事件
   * - convertInItems 来自当前购物车（只取 skuId + quantity）
   * - paymentMethod：差额>0 必填；差额<=0 后端忽略但仍需字段，默认 '微信'
   * - Toast 按差额方向差异化
   */
  async _submitConversion() {
    const {
      customerInfo, cart, remark, submitting,
      conversionSelectedSaleItemIds, conversionPriceDiff, conversionPaymentMethod,
    } = this.data;
    if (!customerInfo?.id) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    if (conversionSelectedSaleItemIds.length === 0) {
      wx.showToast({ title: '请选择折抵卡', icon: 'none' });
      return;
    }
    if (conversionPriceDiff > 0 && !conversionPaymentMethod) {
      wx.showToast({ title: '请选择支付方式', icon: 'none' });
      return;
    }
    if (submitting) return;
    this.setData({ submitting: true });
    try {
      const paymentMethod: '微信' | '线下' =
        conversionPriceDiff > 0 ? (conversionPaymentMethod as '微信' | '线下') : '微信';
      const res = await callStaffApi<{
        saleOrderId: string; priceDiff: number; prepaidCardCredit: number; status: string;
      }>('order.createConversion', {
        clientUserId: customerInfo.id,
        convertOutSaleItemIds: conversionSelectedSaleItemIds,
        convertInItems: cart.map(c => ({ skuId: c.skuId, quantity: c.quantity })),
        paymentMethod,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
        remark: remark || undefined,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        conversionSelectedSaleItemIds: [],
        conversionDeductibleSum: 0,
        conversionPriceDiff: 0,
        conversionPaymentMethod: null,
      });
      // Toast 差异化
      const diff = Number(res.priceDiff) || 0;
      let title = '转换成功';
      if (diff > 0) {
        title = paymentMethod === '微信'
          ? `请微信支付差额 ¥${diff.toFixed(2)}`
          : `请确认补差额收款 ¥${diff.toFixed(2)}`;
      } else if (diff < 0) {
        const credit = Math.abs(diff).toFixed(2);
        title = `差额 ¥${credit} 已充入储值卡`;
      }
      wx.showToast({ title, icon: 'none', duration: 2500 });
      // 差额>0 → 跳订单码继续收款；差额<=0 直接完成，返回即可
      if (diff > 0) {
        wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '转换失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  saveRecentCustomer(customer: CustomerInfo) {
    try {
      let recent: CustomerInfo[] = wx.getStorageSync('recentCustomers') || [];
      recent = recent.filter(c => c.phone !== customer.phone);
      recent.unshift(customer);
      recent = recent.slice(0, 5);
      wx.setStorageSync('recentCustomers', recent);
      this.setData({ recentCustomers: recent });
    } catch (_) {}
  },
});
