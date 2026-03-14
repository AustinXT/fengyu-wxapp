// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { calcCartTotal } from '../../utils/cart-calc';

const app = getApp<IAppOption>();
const BIG_CATEGORIES = ['福利活动', '护理项目', '家居产品', '充值卡'];

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
}

Page({
  data: {
    isManager: false,
    // 商品目录（三级：大类 → 分类 → SPU）
    bigCategories: BIG_CATEGORIES,
    activeBigCategoryIndex: 0,
    catalogLoading: false,
    categories: [] as any[],
    activeCategoryIndex: 0,
    spuList: [] as any[],
    // 购物车
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: '0.00',
    // 结算底部弹层
    showCheckout: false,
    checkoutStep: 0,   // 0=选顾客 1=选类型 2=确认
    // Step 0: 顾客
    customerPhone: '',
    customerSearching: false,
    customerInfo: null as null | { id: string; name: string; phone: string; phoneMasked?: string },
    recentCustomers: [] as any[],
    // Step 1: 开单类型
    orderType: 'normal' as 'normal' | 'experience' | 'internal' | 'promotion',
    // Step 2: 确认 + 备注
    remark: '',
    submitting: false,
    // 优惠券
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    couponTotal: '',
    showCouponPopup: false,
    availableCoupons: [] as any[],
    couponsLoading: false,
    // 指定美容师（可选，用于默认分配）
    preferredStaffWfId: '' as string,
    preferredStaffName: '',
    showStaffPicker: false,
    staffListForPicker: [] as Array<{ staffWfId: string; name: string; department: string }>,
    staffPickerColumns: [] as string[],
  },

  // 所有分类（未过滤）
  _allCategories: [] as any[],
  // SPU 缓存：按 categoryId 缓存已加载的 SPU 列表
  _spuCache: {} as Record<string, any[]>,

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
      const recent = wx.getStorageSync('recentCustomers') || [];
      this.setData({ recentCustomers: recent });
    } catch (_) {}

    // 从商品详情页返回：检查 pendingCartItem
    const pending = app.globalData.pendingCartItem;
    if (pending) {
      app.globalData.pendingCartItem = null;

      // 福利活动商品不加入购物车，只能直接下单（清空购物车后单独放入）
      if (pending.productType === '福利活动') {
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
        }];
        this.updateCart(cart);
      } else {
        const cart = [...this.data.cart];
        // 购物车中有福利活动商品时不允许混入其他商品
        if (cart.some(c => c.productType === '福利活动')) {
          wx.showToast({ title: '福利活动订单需单独下单', icon: 'none' });
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
          });
        }
        this.updateCart(cart);
      }
      if (pending.directCheckout) {
        // 福利活动商品直接下单时自动设置类型
        const autoType = pending.productType === '福利活动' ? 'promotion' : 'normal';
        this.setData({ showCheckout: true, checkoutStep: 0, orderType: autoType as any });
      }
    }
  },

  // ===== 商品目录（三级导航 + 缓存） =====

  async loadShopInit() {
    this.setData({ catalogLoading: true });
    try {
      const data = await callStaffApi<any>('product.shopInit');
      const categories: any[] = data.categories || [];
      const spuList: any[] = data.spuList || [];

      this._allCategories = categories;
      if (categories.length > 0) {
        this._spuCache[categories[0].id] = spuList;
      }

      // 按当前大类筛选侧边栏
      const activeBig = BIG_CATEGORIES[this.data.activeBigCategoryIndex];
      const filtered = categories.filter((c: any) => c.productKind === activeBig);

      // 判断首个筛选分类是否有缓存
      let displayList = spuList;
      if (filtered.length > 0 && filtered[0].id !== categories[0]?.id) {
        displayList = [];
      }

      this.setData({
        categories: filtered,
        activeCategoryIndex: 0,
        spuList: displayList,
        catalogLoading: false,
      });

      // 首个大类分类与全局首个分类不同，需单独加载
      if (filtered.length > 0 && displayList.length === 0) {
        this.loadSpuList(filtered[0].id);
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ catalogLoading: false });
    }
  },

  onBigCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.index;
    if (typeof index !== 'number' || index === this.data.activeBigCategoryIndex) return;

    const activeBig = BIG_CATEGORIES[index];
    const filtered = this._allCategories.filter((c: any) => c.productKind === activeBig);

    // 先重置 activeCategoryIndex 为 -1，强制 van-sidebar 刷新选中态
    this.setData({
      activeBigCategoryIndex: index,
      categories: filtered,
      activeCategoryIndex: -1,
      spuList: [],
    }, () => {
      // categories 渲染完成后，再设置正确的选中索引
      this.setData({ activeCategoryIndex: 0 });

      if (filtered.length > 0) {
        const cached = this._spuCache[filtered[0].id];
        if (cached) {
          this.setData({ spuList: cached });
        } else {
          this.loadSpuList(filtered[0].id);
        }
      }
    });
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const cat = categories[index];
    if (!cat) return;

    // 缓存命中：直接替换，不清空不闪烁
    const cached = this._spuCache[cat.id];
    if (cached) {
      this.setData({ activeCategoryIndex: index, spuList: cached });
      return;
    }

    // 未命中：清空列表显示骨架屏，发起请求
    this.setData({ activeCategoryIndex: index, spuList: [] });
    this.loadSpuList(cat.id);
  },

  async loadSpuList(categoryId: string) {
    this.setData({ catalogLoading: true });
    try {
      const spus = await callStaffApi<any[]>('product.spuList', { categoryId });
      const list = spus || [];
      this._spuCache[categoryId] = list;
      this.setData({ spuList: list, catalogLoading: false });
    } catch (_) {
      this.setData({ spuList: [], catalogLoading: false });
    }
  },

  // ===== SPU 点击 → 跳转详情页 =====

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const spu = e.currentTarget.dataset.spu as any;
    if (!spu?.spuId) return;
    wx.navigateTo({ url: `/packageService/product-detail/product-detail?spuId=${spu.spuId}` });
  },

  // ===== 购物车 =====

  onCartItemRemove(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const item = this.data.cart.find(c => c.skuId === skuId);
    if (item?.productType === '福利活动') {
      wx.showToast({ title: '福利活动项目不可删除', icon: 'none' });
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
      if (cart[idx].productType === '福利活动') {
        wx.showToast({ title: '福利活动项目不可修改数量', icon: 'none' });
        return;
      }
      cart[idx].quantity = qty;
    }
    this.updateCart(cart);
  },

  onDiscountChange(e: WechatMiniprogram.CustomEvent) {
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

  updateCart(cart: CartItem[]) {
    const { count, total } = calcCartTotal(cart);
    const updates: Record<string, any> = { cart, cartCount: count, cartTotal: total };
    if (this.data.couponDiscount > 0) {
      updates.couponTotal = (parseFloat(total) - this.data.couponDiscount).toFixed(2);
    }
    this.setData(updates);
  },

  // ===== 结算面板 =====

  onOpenCheckout() {
    if (this.data.cart.length === 0) {
      wx.showToast({ title: '请先添加商品', icon: 'none' });
      return;
    }
    this.setData({ showCheckout: true, checkoutStep: 0, orderType: 'normal' });
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
    // 福利活动类型已锁定，跳过类型选择直接到确认步骤
    if (this.data.orderType === 'promotion') {
      this.setData({ checkoutStep: 2 });
    } else {
      this.setData({ checkoutStep: 1 });
    }
  },

  // Step 1: 选开单类型
  onSelectOrderType(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type as 'normal' | 'experience' | 'internal' | 'promotion';
    if ((type === 'experience' || type === 'internal' || type === 'promotion') && !this.data.isManager) return;
    this.setData({ orderType: type });
  },

  onStep1Back() { this.setData({ checkoutStep: 0 }); },

  onStep1Next() {
    this.setData({ checkoutStep: 2 });
  },

  // Step 2: 确认订单
  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as unknown as string) ?? '' });
  },

  onStep2Back() {
    // 福利活动跳过类型选择，直接返回到选顾客
    this.setData({ checkoutStep: this.data.orderType === 'promotion' ? 0 : 1 });
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
      const data = await callStaffApi<any>('coupon.available', {
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
    const { customerInfo, orderType, cart, remark, submitting } = this.data;
    if (!customerInfo || submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<any>('order.create', {
        clientUserId: customerInfo.id || null,
        clientPhone: customerInfo.phone,
        clientName: customerInfo.name || customerInfo.phone,
        paymentMethod: 'wechat',
        orderType,
        items: cart.map(c => ({
          skuId: c.skuId,
          workfineItemId: c.workfineItemId,
          spuName: c.spuName,
          specName: c.specName,
          quantity: c.quantity,
          unitPrice: c.price,
          discount: c.discount,
        })),
        remark,
        couponId: this.data.selectedCoupon?.couponId || undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({ showCheckout: false, orderType: 'normal', selectedCoupon: null, couponDiscount: 0 });
      wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?orderNo=${res.saleOrderId}` });
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
