
import { callStaffApi } from '../../utils/cloud';
import { isManager, getCurrentStoreId } from '../../utils/role';
import { calcCartTotal, calcHalfPriceTotal, allocateCouponPerLine } from '../../utils/cart-calc';
import { evaluateCouponAfterCartChange } from '../../utils/coupon-evaluator';
import { computePrepaidDeduction } from '../../utils/prepaid-card-calc';
import { formatDate } from '../../utils/formatters';

const app = getApp<IAppOption>();


const PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡'] as const;
type ProductKindChoice = typeof PRODUCT_KIND_CHOICES[number];


type SaleOrderType = '销售单' | '内部单' | '转换单' | '寄存单';

interface CartItem {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  
  price: number;
  
  listPrice?: number;
  
  specialPrice?: number | null;
  quantity: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  
  priceLine: string;
  
  couponShare: string;
  
  saleAmount: string;
  
  halfPriceSaleAmount: string;
  
  received: string;
  
  isManagerSpecial?: boolean;
  
  saleAmountOverride?: string;
  
  refBundleId?: string;
}

interface Category {
  id: string;
  name: string;
  productKind: string;
}


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
  
  isExperience?: boolean;
  
  isManagerSpecial?: boolean;
  
  isBundle?: boolean;
}


interface BundleGroupSku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  productType: string;
  isShengmei: boolean;
  bundlePrice: number;
  listPrice: number;
  listSpecialPrice: number | null;
  sortOrder: number;
}

interface BundleGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  skus: BundleGroupSku[];
}


interface BundleSpu {
  productId: string;
  name: string;
  coverImage: string | null;
  description: string | null;
  price: number;
  specialPrice: number | null;
  groups: BundleGroup[];
}


interface DisplayItem {
  spuId: string;
  spuName: string;
  
  price: number;
  
  listPrice: number;
  specialPrice: number | null;
  productKind: string;
  productType: string;
  sessionCount: number | null;
  isBundle?: boolean;
  
  isManagerSpecial?: boolean;
}

interface CustomerInfo {
  id: string | null;
  clientUserId: string;
  customerNo?: string | null;
  name: string;
  phone: string;
  phoneMasked?: string;
  
  boundStoreId?: string | null;
  
  storeName?: string;
  
  isCrossStoreTemp?: boolean;
  
  crossStore?: boolean;
  
  customerType?: string | null;
  
  memberLevel?: string | null;
}


function markCrossStore(c: CustomerInfo): CustomerInfo {
  return { ...c, crossStore: !!c.boundStoreId && c.boundStoreId !== getCurrentStoreId() };
}

interface CouponInfo {
  couponId: string;
  name: string;
  discount: number;
  description?: string;
  
  expireAt?: string;
}


interface GroupedCategory {
  productKind: string;
  kindSortOrder: number;
  items: Category[];
}

interface ShopInitResponse {
  categories: Category[];
  
  groupedCategories?: GroupedCategory[];
  skuList: SkuItem[];
  mallBundleGroups?: BundleSpu[];
  
  experienceSkus?: SkuItem[];
}

interface OrderCreateResponse {
  saleOrderId: string;
  
  status?: string;
  
  prepaidCardAmount?: number;
}

interface CouponAvailableResponse {
  coupons: CouponInfo[];
}


interface CustomerBalanceResponse {
  balance: number;
  cardId: string | null;
}


function deriveIsMember(c: { customerType?: string | null; memberLevel?: string | null } | null): boolean {
  return !!c && (c.customerType === '会员客' || (c.memberLevel != null && c.memberLevel !== ''));
}


function skuToDisplay(sku: SkuItem, isMember: boolean): DisplayItem {
  const list = Number(sku.price) || 0;
  const special = sku.specialPrice != null ? Number(sku.specialPrice) : null;
  const hasSpecial = special != null && special < list;
  const useSpecial = isMember && hasSpecial; 
  return {
    spuId: sku.skuId,
    spuName: sku.specName,
    price: useSpecial ? special : list,
    listPrice: list,
    specialPrice: hasSpecial ? special : null, 
    productKind: sku.productKind,
    productType: sku.productType,
    sessionCount: sku.sessionCount,
    isBundle: !!sku.isBundle,
    isManagerSpecial: !!sku.isManagerSpecial,
  }
}


function filterSkusByKindChoice(skus: SkuItem[], choice: ProductKindChoice): SkuItem[] {
  if (choice === '组合套餐') return [];
  if (choice === '普通商品') {
    return skus.filter(s => !s.isExperience);
  }
  if (choice === '体验卡') {
    return skus.filter(s => s.isExperience === true);
  }
  
  return [];
}


function filterCategoriesByKindChoice(categories: Category[], choice: ProductKindChoice): Category[] {
  if (choice === '组合套餐' || choice === '普通商品') return [];
  return categories.filter(c => c.productKind === choice);
}

Page({
  data: {
    isManager: false,
    
    productKindChoices: PRODUCT_KIND_CHOICES as unknown as string[],
    productKindChoiceIndex: 1, 
    productKindChoice: '普通商品' as ProductKindChoice,
    
    catalogLoading: false,
    categories: [] as Category[],
    activeCategoryIndex: 0,
    
    groupedCategories: [] as GroupedCategory[],
    
    activeCategoryId: '' as string,
    spuList: [] as DisplayItem[],
    
    productKeyword: '',
    
    searching: false,
    
    bundleSpus: [] as BundleSpu[],
    
    isCardType: false,
    
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: '0.00',
    cartPopupVisible: false,
    
    showCheckout: false,
    checkoutStep: 0,   
    
    customerKeyword: '',
    customerSearching: false,
    customerInfo: null as null | CustomerInfo,
    buyerIsMember: false,   
    customerResults: [] as CustomerInfo[],
    recentCustomers: [] as CustomerInfo[],
    
    saleOrderType: '销售单' as SaleOrderType,
    
    depositReceivedMap: {} as Record<string, string>,
    
    halfPriceTotal: '0.00',
    
    payableTotal: '0.00',
    
    receivedTotal: '0.00',
    
    remark: '',
    submitting: false,
    
    paymentMethod: '微信' as '微信' | '支付宝' | '线下',
    
    customerCardBalance: 0 as number,
    useCard: false as boolean,
    prepaidCardAmount: 0 as number,
    paidAmount: '0.00' as string,
    showPayMethodGroup: true as boolean,
    prepaidCardLoaded: false as boolean,
    customerBalanceLoading: false as boolean,
    
    isActivity: false as boolean,
    
    conversionSelectedSaleItemIds: [] as string[],
    conversionDeductibleSum: 0,
    conversionPriceDiff: 0,
    conversionPaymentMethod: null as null | '微信' | '支付宝' | '线下',
    
    conversionPrepaidCardAmount: 0,
    
    conversionRemaining: 0,
    
    conversionIsActivity: false as boolean,
    
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    couponTotal: '',
    showCouponPopup: false,
    availableCoupons: [] as CouponInfo[],
    couponsLoading: false,
    
    preferredStaffWfId: '' as string,
    preferredStaffName: '',
    showStaffPicker: false,
    staffListForPicker: [] as Array<{ staffWfId: string; name: string; department: string; skills?: string[] }>,
    staffPickerColumns: [] as string[],
  },

  
  _allCategories: [] as Category[],
  
  _allGroupedCategories: [] as GroupedCategory[],
  
  _allSkus: [] as SkuItem[],
  
  _experienceSkus: [] as SkuItem[],
  
  _spuCache: {} as Record<string, DisplayItem[]>,
  
  _kwTimer: null as ReturnType<typeof setTimeout> | null,

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isManager: isManager() });
    
    this.resetOrderState();
    if (this._allCategories.length === 0) {
      this.loadShopInit();
    }
    try {
      const recent: CustomerInfo[] = wx.getStorageSync('recentCustomers') || [];
      const valid = recent.filter((c) => c && c.id);
      if (valid.length !== recent.length) {
        wx.setStorageSync('recentCustomers', valid);
      }
      this.setData({ recentCustomers: valid });
    } catch (_) {}
  },

  

  async loadShopInit() {
    this.setData({ catalogLoading: true });
    try {
      const data = await callStaffApi<ShopInitResponse>('product.shopInit');
      const categories: Category[] = data.categories || [];
      const groupedCategories: GroupedCategory[] = data.groupedCategories || [];
      const rawSkus: SkuItem[] = data.skuList || [];
      const bundleSpus: BundleSpu[] = data.mallBundleGroups || [];
      const experienceSkus: SkuItem[] = data.experienceSkus || [];

      this._allCategories = categories;
      this._allGroupedCategories = groupedCategories;
      this._allSkus = rawSkus;
      this._experienceSkus = experienceSkus;
      this._spuCache = {};

      
      
      this.setData({ bundleSpus, catalogLoading: false });
      this.applyKindChoice(this.data.productKindChoice);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ catalogLoading: false });
    }
  },

  
  applyKindChoice(choice: ProductKindChoice) {
    const isCardType = choice === '体验卡' || choice === '充值卡';
    this.setData({ isCardType });

    if (choice === '组合套餐') {
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: [],
      });
      return;
    }

    
    if (choice === '普通商品') {
      
      const groups = this._allGroupedCategories.filter(g => g.items && g.items.length > 0);
      if (groups.length === 0) {
        this.setData({
          categories: [],
          groupedCategories: [],
          activeCategoryIndex: 0,
          activeCategoryId: '',
          spuList: [],
        });
        return;
      }
      
      const flatCategories = groups.reduce<Category[]>((acc, g) => acc.concat(g.items), []);
      const firstCat = groups[0].items[0];
      const firstCatId = firstCat.id;
      const cacheKey = `${choice}:${firstCatId}`;
      let list = this._spuCache[cacheKey];
      if (!list) {
        const skusInCat = this._allSkus.filter(s => s.categoryId === firstCatId);
        list = filterSkusByKindChoice(skusInCat, choice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
        this._spuCache[cacheKey] = list;
      }
      this.setData({
        categories: flatCategories,
        groupedCategories: groups,
        activeCategoryIndex: 0,
        activeCategoryId: firstCatId,
        spuList: list,
      });
      return;
    }

    
    if (choice === '体验卡') {
      const list = this._experienceSkus.map((s) => skuToDisplay(s, this.data.buyerIsMember));   
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: list,
        isCardType: false,
      });
      return;
    }

    
    const filtered = filterCategoriesByKindChoice(this._allCategories, choice);
    if (filtered.length === 0) {
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: [],
      });
      return;
    }

    const firstCatId = filtered[0].id;
    const cacheKey = `${choice}:${firstCatId}`;
    let list = this._spuCache[cacheKey];
    if (!list) {
      
      const skusInCat = this._allSkus.filter(s => s.categoryId === firstCatId);
      list = filterSkusByKindChoice(skusInCat, choice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
      this._spuCache[cacheKey] = list;
    }

    
    this.setData({
      categories: filtered,
      groupedCategories: [],
      activeCategoryIndex: -1,
      activeCategoryId: firstCatId,
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

    
    
    
    if (nextChoice === '充值卡') {
      const customer = this.data.customerInfo;
      
      if (customer?.crossStore && !customer?.isCrossStoreTemp) {
        wx.showModal({
          title: '无法充值',
          content: `该顾客属于「${customer.storeName || '其他'}」门店，非本店顾客无法充值。`,
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
      const params: string[] = [];
      if (customer?.clientUserId) {
        params.push(`clientUserId=${encodeURIComponent(customer.clientUserId)}`);
        if (customer.name) params.push(`customerName=${encodeURIComponent(customer.name)}`);
        if (customer.phone) params.push(`customerPhone=${encodeURIComponent(customer.phone)}`);
      }
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      wx.navigateTo({ url: `/packageOrder/card-recharge/card-recharge${qs}` });
      
      return;
    }

    const apply = () => {
      if (this._kwTimer) clearTimeout(this._kwTimer);
      this.setData({
        productKindChoiceIndex: index,
        productKindChoice: nextChoice,
        productKeyword: '',
        searching: false,
      });
      this.applyKindChoice(nextChoice);
    };

    
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
      this.setData({ activeCategoryIndex: index, activeCategoryId: cat.id, spuList: cached });
      return;
    }

    this.setData({ activeCategoryIndex: index, activeCategoryId: cat.id, spuList: [] });
    this.loadSpuList(cat.id);
  },

  
  onGroupedCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const categoryId = e.currentTarget.dataset.id as string;
    if (!categoryId) return;
    
    const wasSearching = this.data.searching;
    if (this.data.productKeyword) {
      if (this._kwTimer) clearTimeout(this._kwTimer);
      this.setData({ productKeyword: '', searching: false });
    }
    
    if (categoryId === this.data.activeCategoryId) {
      if (wasSearching) {
        const cacheKey = `${this.data.productKindChoice}:${categoryId}`;
        this.setData({ spuList: this._spuCache[cacheKey] || [] });
      }
      return;
    }

    const { productKindChoice } = this.data;
    
    const index = this.data.categories.findIndex(c => c.id === categoryId);

    const cacheKey = `${productKindChoice}:${categoryId}`;
    const cached = this._spuCache[cacheKey];
    if (cached) {
      this.setData({
        activeCategoryId: categoryId,
        activeCategoryIndex: index >= 0 ? index : this.data.activeCategoryIndex,
        spuList: cached,
      });
      return;
    }

    this.setData({
      activeCategoryId: categoryId,
      activeCategoryIndex: index >= 0 ? index : this.data.activeCategoryIndex,
      spuList: [],
    });
    this.loadSpuList(categoryId);
  },

  async loadSpuList(categoryId: string) {
    const { productKindChoice } = this.data;
    const cacheKey = `${productKindChoice}:${categoryId}`;

    
    const localSkus = this._allSkus.filter(s => s.categoryId === categoryId);
    if (localSkus.length > 0) {
      const list = filterSkusByKindChoice(localSkus, productKindChoice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list });
      return;
    }

    
    this.setData({ catalogLoading: true });
    try {
      const skus = await callStaffApi<SkuItem[]>('product.skuList', {
        categoryId,
        excludeCards: productKindChoice === '普通商品',
      });
      
      
      
      this._allSkus = this._allSkus.concat(skus || []);
      const list = filterSkusByKindChoice(skus || [], productKindChoice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list, catalogLoading: false });
    } catch (_) {
      this.setData({ spuList: [], catalogLoading: false });
    }
  },

  

  onProductKeywordChange(e: WechatMiniprogram.CustomEvent) {
    const kw = ((e.detail as unknown as string) || '').trim();
    this.setData({ productKeyword: kw });
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this._kwTimer = setTimeout(() => this.applyProductSearch(), 200);
  },

  onProductKeywordClear() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this.setData({ productKeyword: '' });
    this.applyProductSearch();
  },

  
  applyProductSearch() {
    const kw = this.data.productKeyword.trim().toLowerCase();
    if (!kw) {
      const cacheKey = `普通商品:${this.data.activeCategoryId}`;
      this.setData({ searching: false, spuList: this._spuCache[cacheKey] || [] });
      return;
    }
    const matched = filterSkusByKindChoice(this._allSkus, '普通商品')
      .filter(s => (s.specName || '').toLowerCase().includes(kw))
      .map((s) => skuToDisplay(s, this.data.buyerIsMember));
    this.setData({ searching: true, spuList: matched });
  },

  
  

  onBundlePickerSelect(e: WechatMiniprogram.CustomEvent) {
    const { cartItems } = (e.detail || {}) as { cartItems?: CartItem[]; bundleName?: string };
    if (!cartItems || cartItems.length === 0) return;
    this.updateCart(cartItems);
    
    this.onOpenCheckout();
  },

  

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.spu as DisplayItem;
    if (!item?.spuId) return;

    
    const cart = [...this.data.cart];

    
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
        listPrice: item.listPrice,
        specialPrice: item.specialPrice,
        quantity: 1,
        sessionCount: item.sessionCount || 0,
        productType: item.productKind || item.productType,
        workfineItemId: '',
        isManagerSpecial: !!item.isManagerSpecial,
        priceLine: '', couponShare: '0.00', saleAmount: '', halfPriceSaleAmount: '', received: '',
      });
    }
    this.updateCart(cart);
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 800 });
  },

  

  onOpenCartPopup() {
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }
    this.setData({ cartPopupVisible: true });
  },

  onCloseCartPopup() {
    this.setData({ cartPopupVisible: false });
  },

  onClearCart() {
    wx.showModal({
      title: '清空已选项目',
      content: '确定清空购物车？组合套餐项目会保留。',
      confirmColor: '#C0322A',
      success: (res) => {
        if (!res.confirm) return;
        
        const cart = this.data.cart.filter(c => c.productType === '组合套餐' || c.refBundleId);
        this.updateCart(cart);
        if (cart.length === 0) this.setData({ cartPopupVisible: false });
      },
    });
  },

  onCartItemRemove(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const item = this.data.cart.find(c => c.skuId === skuId);
    
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
      
      
      if (cart[idx].refBundleId || cart[idx].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      cart[idx].quantity = qty;
    }
    this.updateCart(cart);
  },

  
  onReceivedChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = (e.detail?.value ?? '') as string;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx < 0) return;
    const row = cart[idx];
    const cap = parseFloat(
      this.data.saleOrderType === '内部单' ? row.halfPriceSaleAmount : row.saleAmount
    ) || 0;
    const parsed = parseFloat(raw);
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      row.received = cap.toFixed(2);
    } else {
      const clamped = Math.min(parsed, cap);
      row.received = (Math.round(clamped * 100) / 100).toFixed(2);
    }
    this.updateCart(cart, { preserveReceived: true });
  },

  
  onSaleAmountChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = (e.detail?.value ?? '') as string;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx < 0) return;
    const row = cart[idx];
    
    if (this.data.saleOrderType !== '销售单' || !row.isManagerSpecial
        || row.refBundleId || row.productType === '组合套餐') {
      return;
    }
    const stdLine = row.price * row.quantity;
    const parsed = parseFloat(raw);
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      row.saleAmountOverride = undefined;
    } else {
      const clamped = Math.min(parsed, stdLine);
      row.saleAmountOverride = (Math.round(clamped * 100) / 100).toFixed(2);
    }
    
    this.updateCart(cart);
  },

  
  onDepositReceivedChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = String(e.detail.value ?? '');
    const parsed = parseFloat(raw);
    const next = { ...this.data.depositReceivedMap };
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      delete next[skuId];
    } else {
      next[skuId] = (Math.round(parsed * 100) / 100).toFixed(2);
    }
    this.setData({ depositReceivedMap: next });
  },

  
  updateCart(cart: CartItem[], opts?: { preserveReceived?: boolean }) {
    const isInternal = this.data.saleOrderType === '内部单';
    const isSales = this.data.saleOrderType === '销售单';
    
    
    const effBase = cart.map(c => {
      const stdLine = c.price * c.quantity;
      const editable = isSales && !!c.isManagerSpecial && !c.refBundleId && c.productType !== '组合套餐';
      if (editable && c.saleAmountOverride != null && c.saleAmountOverride !== '') {
        const v = parseFloat(c.saleAmountOverride);
        if (!Number.isNaN(v)) return Math.max(0, Math.min(v, stdLine));
      }
      return stdLine;
    });
    
    for (const c of cart) {
      c.priceLine = (c.price * c.quantity).toFixed(2);
    }
    
    const baseLines = cart.map((c, i) => {
      if (isInternal) {
        const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100;
        return halfUnit * c.quantity;
      }
      return effBase[i];
    });
    
    const shares = allocateCouponPerLine(baseLines, this.data.couponDiscount || 0);
    for (let i = 0; i < cart.length; i++) {
      const c = cart[i];
      const share = shares[i] || 0;
      c.couponShare = share.toFixed(2);
      
      const saleAmountNum = Math.max(0, Math.round((effBase[i] - share) * 100) / 100);
      c.saleAmount = saleAmountNum.toFixed(2);
      
      const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100;
      const halfSaleNum = Math.max(0, Math.round((halfUnit * c.quantity - (isInternal ? share : 0)) * 100) / 100);
      c.halfPriceSaleAmount = halfSaleNum.toFixed(2);
      
      const cap = (isInternal ? halfSaleNum : saleAmountNum);
      if (opts?.preserveReceived && c.received) {
        const prev = parseFloat(c.received) || 0;
        c.received = Math.min(prev, cap).toFixed(2);
      } else {
        c.received = cap.toFixed(2);
      }
    }
    const { count, total } = calcCartTotal(cart);
    const halfPriceTotal = calcHalfPriceTotal(cart);
    
    let payableSum = 0, receivedSum = 0;
    for (const c of cart) {
      payableSum += parseFloat(isInternal ? c.halfPriceSaleAmount : c.saleAmount) || 0;
      receivedSum += parseFloat(c.received) || 0;
    }
    const update: Record<string, any> = {
      cart, cartCount: count, cartTotal: total, halfPriceTotal,
      payableTotal: payableSum.toFixed(2),
      receivedTotal: receivedSum.toFixed(2),
    };
    if (this.data.couponDiscount > 0) {
      update.couponTotal = payableSum.toFixed(2);
    }
    
    if (count === 0 && this.data.cartPopupVisible) {
      update.cartPopupVisible = false;
    }
    this.setData(update);
    
    void this.revalidateCoupon();
    
    this.recomputePrepaidAmounts();
  },

  

  onOpenCheckout() {
    if (this.data.cart.length === 0) {
      wx.showToast({ title: '请先添加商品', icon: 'none' });
      return;
    }
    this.setData({
      showCheckout: true,
      checkoutStep: 0,
      saleOrderType: '销售单',
      
      conversionSelectedSaleItemIds: [],
      conversionDeductibleSum: 0,
      conversionPriceDiff: 0,
      conversionPaymentMethod: null,
      conversionPrepaidCardAmount: 0,
      conversionRemaining: 0,
      conversionIsActivity: false,
      
      customerCardBalance: 0,
      useCard: false,
      prepaidCardAmount: 0,
      paidAmount: '0.00',
      showPayMethodGroup: true,
      prepaidCardLoaded: false,
      isActivity: false,
    });
  },

  onCloseCheckout() {
    
    this.resetCheckoutForm();
  },

  
  resetCheckoutForm() {
    this.setData({
      showCheckout: false,
      checkoutStep: 0,
      
      customerKeyword: '',
      customerSearching: false,
      customerInfo: null,
      customerResults: [],
      buyerIsMember: false,   
      
      saleOrderType: '销售单',
      depositReceivedMap: {},
      
      remark: '',
      submitting: false,
      
      paymentMethod: '微信',
      
      customerCardBalance: 0,
      useCard: false,
      prepaidCardAmount: 0,
      paidAmount: '0.00',
      showPayMethodGroup: true,
      prepaidCardLoaded: false,
      customerBalanceLoading: false,
      
      isActivity: false,
      
      conversionSelectedSaleItemIds: [],
      conversionDeductibleSum: 0,
      conversionPriceDiff: 0,
      conversionPaymentMethod: null,
      conversionPrepaidCardAmount: 0,
      conversionRemaining: 0,
      conversionIsActivity: false,
      
      selectedCoupon: null,
      couponDiscount: 0,
      couponTotal: '',
      showCouponPopup: false,
      availableCoupons: [],
      couponsLoading: false,
      
      preferredStaffWfId: '',
      preferredStaffName: '',
      showStaffPicker: false,
      
      cartPopupVisible: false,
    });
    
    this._spuCache = {};
    
    
    
    if (this.data.cart.length > 0) {
      this.updateCart(this.data.cart);
    }
  },

  
  resetOrderState() {
    this.resetCheckoutForm();
    this.updateCart([]); 
    if (this._kwTimer) {
      clearTimeout(this._kwTimer);
      this._kwTimer = null;
    }
    this.setData({
      productKindChoiceIndex: 1,
      productKindChoice: '普通商品',
      productKeyword: '',
      searching: false,
    });
    
    
    this.applyKindChoice('普通商品');
  },

  
  onCustomerKeywordChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerKeyword: e.detail as unknown as string, customerInfo: null, customerResults: [] });
  },

  async onSearchCustomer() {
    const keyword = this.data.customerKeyword.trim();
    if (!keyword) {
      wx.showToast({ title: '请输入顾客姓名或手机号', icon: 'none' });
      return;
    }
    this.setData({ customerSearching: true });
    try {
      
      const raw = await callStaffApi<CustomerInfo[]>('customer.search', { keyword, crossStore: true });
      const results = (raw || []).map(markCrossStore);
      if (results.length === 0) {
        this.setData({ customerInfo: null, customerResults: [] });
        wx.showToast({ title: '未找到该顾客（需已绑定门店）', icon: 'none' });
      } else if (results.length === 1) {
        
        this.setData({ customerInfo: results[0], customerResults: [] });
        this.refreshForCustomer(results[0]);
      } else {
        this.setData({ customerInfo: null, customerResults: results });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '查询失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onSelectCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = markCrossStore(e.currentTarget.dataset.customer as CustomerInfo);
    this.setData({ customerInfo: customer, customerResults: [], customerKeyword: customer.phone || customer.name });
    this.refreshForCustomer(customer);
  },

  onSelectRecentCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = markCrossStore(e.currentTarget.dataset.customer as CustomerInfo);
    this.setData({ customerInfo: customer, customerKeyword: customer.phone, customerResults: [] });
    this.refreshForCustomer(customer);
  },

  
  refreshForCustomer(customer: CustomerInfo) {
    const buyerIsMember = deriveIsMember(customer);
    this._spuCache = {};   
    
    
    const skuMap: Record<string, SkuItem> = {};
    for (const s of this._allSkus) skuMap[s.skuId] = s;
    for (const s of this._experienceSkus) skuMap[s.skuId] = s;
    
    const spuList = this.data.spuList.map((row) => {
      const sku = skuMap[row.spuId];
      return sku ? skuToDisplay(sku, buyerIsMember) : row;
    });
    this.setData({ buyerIsMember, spuList });
    
    const cart = this.data.cart.map((c) => {
      if (c.refBundleId || c.productType === '组合套餐') return c;
      const sku = skuMap[c.skuId];
      if (!sku) return c;
      const disp = skuToDisplay(sku, buyerIsMember);
      return { ...c, price: disp.price, listPrice: disp.listPrice, specialPrice: disp.specialPrice };
    });
    this.updateCart(cart);
  },

  onStep0Next() {
    if (!this.data.customerInfo) {
      wx.showModal({
        title: '无法开单',
        content: '请先用手机号搜索并选择已绑定门店的顾客。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    
    if (this.data.customerInfo.crossStore && !this.data.customerInfo.isCrossStoreTemp) {
      wx.showModal({
        title: '无法开单',
        content: `该顾客属于「${this.data.customerInfo.storeName || '其他'}」门店，非本店顾客无法开单。`,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    
    
    this.setData({ checkoutStep: 2 });
    
    void this.loadCustomerBalance();
  },

  

  
  async loadCustomerBalance() {
    const customer = this.data.customerInfo;
    if (!customer?.clientUserId || this.data.prepaidCardLoaded) {
      
      this.recomputePrepaidAmounts();
      return;
    }
    this.setData({ customerBalanceLoading: true });
    try {
      const data = await callStaffApi<CustomerBalanceResponse>('customer.customerBalance', {
        customerUserId: customer.clientUserId,
      });
      const balance = Math.max(0, Number(data?.balance) || 0);
      this.setData({
        customerCardBalance: balance,
        useCard: balance > 0,
        prepaidCardLoaded: true,
      });
    } catch (_) {
      
      this.setData({
        customerCardBalance: 0,
        useCard: false,
        prepaidCardLoaded: true,
      });
    } finally {
      this.setData({ customerBalanceLoading: false });
      this.recomputePrepaidAmounts();
    }
  },

  
  recomputePrepaidAmounts() {
    if (this.data.saleOrderType === '转换单') {
      this.setData({ prepaidCardAmount: 0, paidAmount: '0.00', showPayMethodGroup: true });
      return;
    }
    
    
    
    const baseForPrepaid = parseFloat(this.data.receivedTotal) || 0;
    const result = computePrepaidDeduction({
      payableAmount: baseForPrepaid,
      customerCardBalance: this.data.customerCardBalance || 0,
      useCard: !!this.data.useCard,
    });
    this.setData({
      prepaidCardAmount: result.prepaidCardAmount,
      paidAmount: result.paidAmount.toFixed(2),
      showPayMethodGroup: result.showPayMethodGroup,
    });
  },

  
  onTogglePrepaidCard(e: WechatMiniprogram.CustomEvent) {
    
    const next = !!e.detail;
    if (next === this.data.useCard) return;
    if (next && this.data.customerCardBalance <= 0) {
      
      return;
    }
    this.setData({ useCard: next });
    this.recomputePrepaidAmounts();
  },

  
  onToggleActivity(e: WechatMiniprogram.CustomEvent) {
    this.setData({ isActivity: !!e.detail });
  },

  
  onSelectSaleOrderType(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.type as SaleOrderType;
    if (!next || next === this.data.saleOrderType) return;
    if ((next === '转换单' || next === '寄存单') && !this.data.customerInfo) {
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
      update.conversionPrepaidCardAmount = 0;
      update.conversionRemaining = 0;
      update.conversionIsActivity = false;
    } else {
      
      update.paymentMethod = '微信';
    }
    
    if (next === '寄存单') {
      update.useCard = false;
      update.prepaidCardAmount = 0;
    }
    
    
    this.setData(update);
    this.updateCart(this.data.cart);
  },

  
  onConversionPanelChange(e: WechatMiniprogram.CustomEvent) {
    const { selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod, prepaidCardAmount, remaining, isActivity } = (e.detail || {}) as {
      selectedSaleItemIds?: string[];
      deductibleSum?: number;
      priceDiff?: number;
      paymentMethod?: '微信' | '支付宝' | '线下' | null;
      prepaidCardAmount?: number;
      remaining?: number;
      isActivity?: boolean;
    };
    this.setData({
      conversionSelectedSaleItemIds: selectedSaleItemIds || [],
      conversionDeductibleSum: Number(deductibleSum) || 0,
      conversionPriceDiff: Number(priceDiff) || 0,
      conversionPaymentMethod: paymentMethod ?? null,
      conversionPrepaidCardAmount: Number(prepaidCardAmount) || 0,
      conversionRemaining: Number(remaining) || 0,
      conversionIsActivity: !!isActivity,
    });
  },

  
  onPaymentMethodTap(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.method as '微信' | '支付宝' | '线下';
    if (!next || (next !== '微信' && next !== '支付宝' && next !== '线下')) return;
    if (next === this.data.paymentMethod) return;
    this.setData({ paymentMethod: next });
  },

  
  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as unknown as string) ?? '' });
  },

  onStep2Back() {
    
    this.setData({ checkoutStep: 0 });
  },

  

  async onSelectCoupon() {
    const { customerInfo, cart } = this.data;
    if (!customerInfo?.phone) return;

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: c.price * c.quantity,
      }));
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      
      const coupons = (data?.coupons || []).map(c => ({ ...c, expireAt: c.expireAt ? formatDate(c.expireAt) : c.expireAt }));
      this.setData({ availableCoupons: coupons });
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
    this.setData({
      selectedCoupon: { couponId, name, discount: d },
      couponDiscount: d,
      showCouponPopup: false,
    });
    
    this.updateCart(this.data.cart);
  },

  onClearCoupon() {
    this.setData({ selectedCoupon: null, couponDiscount: 0, couponTotal: '', showCouponPopup: false });
    this.updateCart(this.data.cart);
  },

  
  async revalidateCoupon() {
    const { selectedCoupon, customerInfo, cart } = this.data;
    if (!selectedCoupon || !customerInfo?.phone) return;
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: Math.round(c.price * c.quantity * 100) / 100,
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
        
        this.updateCart(this.data.cart);
        wx.showToast({ title: '商品已变动，原优惠券已失效', icon: 'none' });
      } else if (result.kind === 'updated') {
        this.setData({
          selectedCoupon: { ...selectedCoupon, discount: result.discount },
          couponDiscount: result.discount,
        });
        this.updateCart(this.data.cart);
      }
    } catch {
      
    }
  },

  

  async onSelectPreferredStaff() {
    if (this.data.staffListForPicker.length === 0) {
      try {
        const data = await callStaffApi<{ staffList: Array<{ staffWfId: string; name: string; department: string; skills?: string[] }> }>('staff.list');
        const list = data?.staffList || [];
        const roleTag = (skills?: string[]) => (skills || []).filter(s => s === '美容师' || s === '养生师').join('/');
        this.setData({
          staffListForPicker: list,
          staffPickerColumns: ['不指定', ...list.map(s => `${s.name}（${[roleTag(s.skills), s.department].filter(Boolean).join('·') || '未分组'}）`)],
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
    const idx = this.data.staffPickerColumns.indexOf(picked) - 1; 
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

    
    if (!this.data.isManager) {
      wx.showToast({ title: '您无开单权限，请联系店长', icon: 'none', duration: 2500 });
      return;
    }

    
    if (saleOrderType === '转换单') {
      return this._submitConversion();
    }
    
    if (saleOrderType === '寄存单') {
      return this._submitDeposit();
    }

    this.setData({ submitting: true });
    try {
      
      
      const useCard = this.data.useCard && this.data.prepaidCardAmount > 0;
      const prepaidCardAmount = useCard ? this.data.prepaidCardAmount : 0;
      const res = await callStaffApi<OrderCreateResponse>('order.create', {
        clientUserId: customerInfo.clientUserId,
        clientPhone: customerInfo.phone,
        clientName: customerInfo.name || customerInfo.phone,
        
        
        paymentMethod: this.data.paymentMethod,
        saleOrderType,
        items: cart.map(c => {
          
          
          const editable = saleOrderType === '销售单' && !!c.isManagerSpecial
            && !c.refBundleId && c.productType !== '组合套餐';
          const hasOv = editable && c.saleAmountOverride != null && c.saleAmountOverride !== '';
          const effSale = hasOv
            ? Math.max(0, Math.min(parseFloat(c.saleAmountOverride as string) || 0, c.price * c.quantity))
            : c.price * c.quantity;
          return {
            skuId: c.skuId,
            workfineItemId: c.workfineItemId,
            spuName: c.spuName,
            specName: c.specName,
            quantity: c.quantity,
            
            
            
            
            
            
            unitPrice: ((c.listPrice ?? c.price) || 0).toFixed(2),
            unitRealPrice: hasOv ? (effSale / c.quantity).toFixed(2) : (c.price || 0).toFixed(2),
            saleAmount: hasOv ? effSale.toFixed(2) : c.priceLine,
            
            received: parseFloat(c.received) || 0,
          };
        }),
        remark,
        
        couponId: saleOrderType === '销售单'
          ? (this.data.selectedCoupon?.couponId || undefined)
          : undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
        
        useCard,
        prepaidCardAmount,
        
        isActivity: this.data.isActivity,
        
        bundleProductId: cart.find(c => c.refBundleId)?.refBundleId || undefined,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        selectedCoupon: null,
        couponDiscount: 0,
        paymentMethod: '微信',
        isActivity: false,
      });
      
      if (res.status === '已支付') {
        const title = Number(res.prepaidCardAmount || 0) > 0
          ? '储值卡已全额抵扣，订单已结清'
          : '优惠券已全额抵扣，订单已结清';
        wx.showToast({ title, icon: 'none', duration: 2500 });
      } else {
        wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '开单失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  
  async _submitConversion() {
    const {
      customerInfo, cart, remark, submitting,
      conversionSelectedSaleItemIds, conversionPriceDiff, conversionPaymentMethod,
      conversionPrepaidCardAmount, conversionRemaining,
    } = this.data;
    if (!customerInfo) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    if (conversionSelectedSaleItemIds.length === 0) {
      wx.showToast({ title: '请选择折抵卡', icon: 'none' });
      return;
    }
    
    if (conversionRemaining > 0 && !conversionPaymentMethod) {
      wx.showToast({ title: '请选择支付方式', icon: 'none' });
      return;
    }
    if (submitting) return;
    this.setData({ submitting: true });
    try {
      
      const paymentMethod: '微信' | '支付宝' | '线下' =
        conversionRemaining > 0 ? (conversionPaymentMethod as '微信' | '支付宝' | '线下') : '微信';
      const res = await callStaffApi<{
        saleOrderId: string; priceDiff: number; prepaidCardCredit: number; prepaidCardAmount: number; status: string;
      }>('order.createConversion', {
        clientUserId: customerInfo.clientUserId,
        convertOutSaleItemIds: conversionSelectedSaleItemIds,
        convertInItems: cart.map(c => ({ skuId: c.skuId, quantity: c.quantity })),
        paymentMethod,
        prepaidCardAmount: conversionPrepaidCardAmount > 0 ? conversionPrepaidCardAmount : undefined,
        isActivity: this.data.conversionIsActivity,
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
        conversionPrepaidCardAmount: 0,
        conversionRemaining: 0,
        conversionIsActivity: false,
      });
      
      const diff = Number(res.priceDiff) || 0;
      const card = Number(res.prepaidCardAmount) || 0;
      const remaining = Math.max(0, Math.round((diff - card) * 100) / 100);
      let title = '转换成功';
      if (diff > 0 && remaining > 0) {
        title = paymentMethod === '线下'
          ? `请确认补差额收款 ¥${remaining.toFixed(2)}`
          : `请${paymentMethod}支付差额 ¥${remaining.toFixed(2)}`;
      } else if (diff > 0 && remaining <= 0) {
        title = `储值卡全额抵扣 ¥${card.toFixed(2)}，已结清`;
      } else if (diff < 0) {
        const credit = Math.abs(diff).toFixed(2);
        title = `差额 ¥${credit} 已充入储值卡`;
      }
      wx.showToast({ title, icon: 'none', duration: 2500 });
      
      if (remaining > 0) {
        wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '转换失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  
  async _submitDeposit() {
    const { customerInfo, cart, remark, submitting, depositReceivedMap } = this.data;
    if (!customerInfo) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    if (!customerInfo.clientUserId) {
      wx.showToast({ title: '顾客尚未注册小程序', icon: 'none' });
      return;
    }
    if (cart.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }
    if (submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<{ saleOrderId: string; itemCount: number; status: string }>(
        'order.createDeposit',
        {
          clientUserId: customerInfo.clientUserId,
          items: cart.map(c => ({
            skuId: c.skuId,
            quantity: c.quantity,
            received: Math.max(0, parseFloat(depositReceivedMap[c.skuId] || '0') || 0),
          })),
          remark: remark || undefined,
        }
      );
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        depositReceivedMap: {},
      });
      wx.showToast({
        title: `寄存单已创建（${res.itemCount} 项）`,
        icon: 'success',
        duration: 2000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '寄存失败';
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
