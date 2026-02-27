// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

interface CartItem {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  price: number;
  quantity: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  isGift?: boolean;       // 促销方案赠品
  isPromoPlan?: boolean;  // 来自促销方案，数量锁定
}

Page({
  data: {
    isManager: false,
    // 商品目录
    catalogLoading: false,
    categories: [] as any[],
    activeCategoryIndex: 0,
    spuList: [] as any[],
    // 购物车
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: '0.00',
    // SKU 选择弹层
    showSkuPopup: false,
    currentSpu: null as any,
    // 结算底部弹层
    showCheckout: false,
    checkoutStep: 0,   // 0=选顾客 1=选类型 2=确认
    // Step 0: 顾客
    customerPhone: '',
    customerSearching: false,
    customerInfo: null as null | { id: string; name: string; phone: string; phoneMasked?: string },
    recentCustomers: [] as any[],
    // Step 1: 开单类型
    orderType: 'normal' as 'normal' | 'experience' | 'promotion',
    // 促销方案
    showPromoList: false,
    promoPlansLoading: false,
    promoPlans: [] as any[],
    selectedPlan: null as any,
    // Step 2: 确认 + 备注
    remark: '',
    submitting: false,
  },

  onShow() {
    this.setData({ isManager: isManager() });
    if (this.data.categories.length === 0) {
      this.loadCategories();
    }
    try {
      const recent = wx.getStorageSync('recentCustomers') || [];
      this.setData({ recentCustomers: recent });
    } catch (_) {}
  },

  async loadCategories() {
    this.setData({ catalogLoading: true });
    try {
      const cats = await callStaffApi<any[]>('product.categories');
      this.setData({ categories: cats || [], catalogLoading: false });
      if (cats && cats.length > 0) {
        this.loadSpuList(cats[0].id);
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ catalogLoading: false });
    }
  },

  async loadSpuList(categoryId: string) {
    try {
      const spus = await callStaffApi<any[]>('product.spuList', { categoryId });
      this.setData({ spuList: spus || [] });
    } catch (_) {
      this.setData({ spuList: [] });
    }
  },

  async loadPromoPlans() {
    this.setData({ promoPlansLoading: true });
    try {
      const plans = await callStaffApi<any[]>('product.promotionPlans');
      this.setData({ promoPlans: plans || [] });
    } catch (_) {
      this.setData({ promoPlans: [] });
    } finally {
      this.setData({ promoPlansLoading: false });
    }
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeCategoryIndex: index });
    const cat = this.data.categories[index];
    if (cat) this.loadSpuList(cat.id);
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const spu = e.currentTarget.dataset.spu as any;
    this.setData({ showSkuPopup: true, currentSpu: spu });
  },

  onSkuPopupClose() {
    this.setData({ showSkuPopup: false, currentSpu: null });
  },

  onAddSku(e: WechatMiniprogram.TouchEvent) {
    const sku = e.currentTarget.dataset.sku as any;
    const spu = this.data.currentSpu;
    if (!spu || !sku) return;
    const cart = [...this.data.cart];
    const existing = cart.findIndex(c => c.skuId === sku.skuId && !c.isPromoPlan);
    if (existing >= 0) {
      cart[existing].quantity += 1;
    } else {
      cart.push({
        spuId: spu.spuId,
        skuId: sku.skuId,
        spuName: spu.spuName,
        specName: sku.specName,
        price: sku.price,
        quantity: 1,
        sessionCount: sku.sessionCount || 0,
        productType: spu.productType,
        workfineItemId: sku.workfineItemId,
      });
    }
    this.updateCart(cart);
    this.setData({ showSkuPopup: false, currentSpu: null });
  },

  onCartItemRemove(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const cart = this.data.cart.filter(c => c.skuId !== skuId);
    this.updateCart(cart);
  },

  onCartQtyChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const qty = parseInt(e.detail) || 1;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx >= 0) cart[idx].quantity = qty;
    this.updateCart(cart);
  },

  updateCart(cart: CartItem[]) {
    const count = cart.reduce((s, c) => s + c.quantity, 0);
    const total = cart.reduce((s, c) => s + c.price * c.quantity, 0);
    this.setData({ cart, cartCount: count, cartTotal: total.toFixed(2) });
  },

  onOpenCheckout() {
    if (this.data.cart.length === 0) {
      wx.showToast({ title: '请先添加商品', icon: 'none' });
      return;
    }
    this.setData({ showCheckout: true, checkoutStep: 0, orderType: 'normal', selectedPlan: null });
  },

  onOpenPromoShortcut() {
    const { cart } = this.data;
    const hasNonPromo = cart.some(c => !c.isPromoPlan);
    if (hasNonPromo) {
      wx.showModal({
        title: '切换促销方案',
        content: '切换促销方案将清空当前已选商品，是否继续？',
        success: (res) => {
          if (res.confirm) {
            this.updateCart([]);
            this.setData({ showCheckout: true, checkoutStep: 0, orderType: 'promotion', selectedPlan: null });
          }
        },
      });
    } else {
      this.setData({ showCheckout: true, checkoutStep: 0, orderType: 'promotion', selectedPlan: null });
    }
  },

  onCloseCheckout() {
    this.setData({ showCheckout: false });
  },

  // Step 0: 选顾客
  onCustomerPhoneChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerPhone: e.detail, customerInfo: null });
  },

  async onSearchCustomer() {
    const phone = this.data.customerPhone.trim();
    if (!phone || phone.length < 11) {
      wx.showToast({ title: '请输入完整手机号', icon: 'none' });
      return;
    }
    this.setData({ customerSearching: true });
    try {
      const results = await callStaffApi<any[]>('customer.search', { phone });
      const found = results && results[0];
      if (found) {
        this.setData({ customerInfo: found });
      } else {
        this.setData({ customerInfo: { id: '', name: '', phone } });
        wx.showToast({ title: '未注册顾客，将以手机号开单', icon: 'none' });
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '查询失败', icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onSelectRecentCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = e.currentTarget.dataset.customer as any;
    this.setData({ customerInfo: customer, customerPhone: customer.phone });
  },

  onStep0Next() {
    if (!this.data.customerInfo) {
      wx.showToast({ title: '请先选择顾客', icon: 'none' });
      return;
    }
    this.setData({ checkoutStep: 1 });
    // 若已选促销方案模式，自动打开方案列表
    if (this.data.orderType === 'promotion') {
      this.loadPromoPlans();
      this.setData({ showPromoList: true });
    }
  },

  // Step 1: 选开单类型
  onSelectOrderType(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as 'normal' | 'experience' | 'promotion';
    if (type === 'experience' && !this.data.isManager) return;
    this.setData({ orderType: type });
    if (type === 'promotion') {
      // 切换到促销方案时清空现有购物车并加载方案列表
      if (this.data.cart.some(c => !c.isPromoPlan)) {
        this.updateCart([]);
      }
      this.setData({ selectedPlan: null, showPromoList: true });
      this.loadPromoPlans();
    } else {
      // 切换到其他类型时清除促销方案选中状态
      if (this.data.cart.some(c => c.isPromoPlan)) {
        this.updateCart([]);
      }
      this.setData({ selectedPlan: null });
    }
  },

  onStep1Back() { this.setData({ checkoutStep: 0 }); },

  onStep1Next() {
    const { orderType, selectedPlan } = this.data;
    if (orderType === 'promotion' && !selectedPlan) {
      wx.showToast({ title: '请先选择促销方案', icon: 'none' });
      this.setData({ showPromoList: true });
      this.loadPromoPlans();
      return;
    }
    this.setData({ checkoutStep: 2 });
  },

  // 促销方案弹层
  onPromoListClose() {
    this.setData({ showPromoList: false });
    if (!this.data.selectedPlan) {
      this.setData({ orderType: 'normal' });
    }
  },

  onSelectPromoPlan(e: WechatMiniprogram.TouchEvent) {
    const plan = e.currentTarget.dataset.plan as any;
    // 用促销方案项目替换购物车
    const cartItems: CartItem[] = plan.items.map((item: any) => ({
      spuId: item.skuId,
      skuId: item.skuId,
      spuName: item.itemName,
      specName: item.specName,
      price: item.promoPrice,
      quantity: 1,
      sessionCount: item.sessionCount || 0,
      productType: item.productType || '疗程卡',
      workfineItemId: item.workfineItemId,
      isGift: item.isGift || false,
      isPromoPlan: true,
    }));
    this.updateCart(cartItems);
    this.setData({ selectedPlan: plan, showPromoList: false });
  },

  // Step 2: 确认订单
  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: e.detail.value });
  },

  onStep2Back() { this.setData({ checkoutStep: 1 }); },

  async onSubmitOrder() {
    const { customerInfo, orderType, cart, remark, selectedPlan } = this.data;
    if (!customerInfo) return;
    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<any>('order.create', {
        clientUserId: customerInfo.id || null,
        customerPhone: customerInfo.phone,
        customerName: customerInfo.name || customerInfo.phone,
        orderType,
        promotionPlanId: orderType === 'promotion' && selectedPlan ? selectedPlan.id : null,
        items: cart.map(c => ({
          skuId: c.skuId,
          workfineItemId: c.workfineItemId,
          spuName: c.spuName,
          specName: c.specName,
          quantity: c.quantity,
          unitPrice: c.price,
          isGift: c.isGift || false,
        })),
        remark,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({ showCheckout: false, selectedPlan: null, orderType: 'normal' });
      wx.navigateTo({ url: `/pages/order-qrcode/order-qrcode?orderId=${res.orderId}` });
    } catch (err: any) {
      wx.showToast({ title: err.message || '开单失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  saveRecentCustomer(customer: any) {
    try {
      let recent: any[] = wx.getStorageSync('recentCustomers') || [];
      recent = recent.filter(c => c.phone !== customer.phone);
      recent.unshift(customer);
      recent = recent.slice(0, 5);
      wx.setStorageSync('recentCustomers', recent);
      this.setData({ recentCustomers: recent });
    } catch (_) {}
  },
});
