// pages/checkout/checkout.ts
import Toast from '@vant/weapp/toast/toast';
import { clearCart } from '../../utils/cart';

const app = getApp<IAppOption>();

interface CheckoutItem {
  skuId: string;
  spuName: string;
  skuDisplayName: string;
  price: number;
  quantity: number;
}

interface Staff {
  staff_wf_id: string;
  name: string;
  position: string;
}

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

Page({
  data: {
    spuName: '',
    skuId: '',
    skuDisplayName: '',
    unitPrice: '0.00',
    staffWfId: '',
    staffName: '',
    storeName: '',
    paymentMethod: 'wechat' as 'wechat' | 'offline',
    agreed: false,
    submitting: false,
    // 若从员工端扫码进入，持有已有 orderNo
    existingOrderNo: '',
    // 购物车批量下单
    fromCart: false,
    cartItems: [] as CheckoutItem[],
    totalPrice: '0.00',
    // 手机号绑定弹窗
    showPhoneBind: false,
    // 美容师选择
    staffList: [] as Staff[],
    showStaffPopup: false,
  },

  onLoad(options) {
    const { skuId, spuName, staffWfId, staffName, orderNo, fromCart } = options as Record<string, string>;
    const storeName = app.globalData.boundStoreName;

    // 加载美容师列表 + 默认美容师
    this.loadStaffList();
    this.loadDefaultStaff();

    if (orderNo) {
      // 场景 B：扫码收款，订单已存在
      this.setData({ existingOrderNo: orderNo });
      this.loadExistingOrder(orderNo);
    } else if (fromCart === '1') {
      // 场景 C：购物车批量下单
      const checkoutItems: CheckoutItem[] = wx.getStorageSync('checkoutItems') || [];
      if (checkoutItems.length === 0) {
        Toast.fail('无结算商品');
        setTimeout(() => wx.navigateBack(), 1000);
        return;
      }
      const total = checkoutItems.reduce((s, i) => s + i.price * i.quantity, 0);
      this.setData({
        fromCart: true,
        cartItems: checkoutItems,
        spuName: checkoutItems.length === 1 ? checkoutItems[0].spuName : `${checkoutItems.length} 件商品`,
        skuDisplayName: checkoutItems.length === 1 ? checkoutItems[0].skuDisplayName : checkoutItems.map(i => i.spuName).join('、'),
        unitPrice: total.toFixed(2),
        totalPrice: total.toFixed(2),
        storeName,
      });
    } else {
      // 场景 A：自助下单
      this.loadSkuPrice(skuId);
      this.setData({
        skuId: skuId || '',
        spuName: decodeURIComponent(spuName || ''),
        staffWfId: staffWfId || '',
        staffName: decodeURIComponent(staffName || ''),
        storeName,
      });
    }
  },

  async loadSkuPrice(skuId: string) {
    try {
      // 使用 product.skuDetail 获取 SKU 价格
      const data = await callClientApi('product.skuDetail', { skuId });
      const sku = data?.sku;
      this.setData({
        skuDisplayName: sku?.sku_display_name || '',
        unitPrice: String(sku?.originalPrice || '0.00'),
      });
    } catch {
      Toast.fail('加载价格失败');
    }
  },

  async loadExistingOrder(orderNo: string) {
    try {
      const data = await callClientApi('order.detail', { orderNo });
      const order = data?.order || {};
      const items = data?.items || [];
      const firstItem = items[0] || {};
      this.setData({
        spuName: firstItem.spu_name || '',
        skuDisplayName: firstItem.sku_display_name || '',
        unitPrice: order.receivable || '0.00',
        storeName: order.store_name || '',
      });
    } catch {
      Toast.fail('加载订单信息失败');
    }
  },

  async loadStaffList() {
    try {
      const storeName = app.globalData.boundStoreName;
      if (!storeName) return;
      const data = await callClientApi('staff.list', { storeName });
      const staffList: Staff[] = (data?.staffList || []).map((s: any) => ({
        staff_wf_id: s.staff_id,
        name: s.name,
        position: s.position
      }));
      this.setData({ staffList });
    } catch {
      // 美容师加载失败不影响主流程
    }
  },

  async loadDefaultStaff() {
    try {
      // 若 URL 已传入 staffWfId，不覆盖
      if (this.data.staffWfId) return;
      const data = await callClientApi('staff.default', {});
      if (data?.mainStaffId) {
        this.setData({
          staffWfId: data.mainStaffId,
          staffName: data.mainStaffName || '',
        });
      }
    } catch {
      // 获取默认美容师失败不影响主流程
    }
  },

  onSelectStaff() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.TouchEvent) {
    const { wfId, name } = e.currentTarget.dataset as { wfId: string; name: string };
    this.setData({
      staffWfId: wfId,
      staffName: name,
      showStaffPopup: false,
    });
  },

  onAgreementChange(e: WechatMiniprogram.CustomEvent<boolean>) {
    this.setData({ agreed: e.detail });
  },

  onPayMethodChange(e: WechatMiniprogram.CustomEvent<string>) {
    this.setData({ paymentMethod: e.detail as 'wechat' | 'offline' });
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: 'wechat' | 'offline' };
    this.setData({ paymentMethod: method });
  },

  onViewAgreement() {
    wx.showModal({
      title: '服务消费协议',
      content: '本协议为凤御美容服务消费协议（内容由运营方补充）。购买服务即代表您同意本协议条款。',
      showCancel: false,
    });
  },

  async onSubmitOrder() {
    if (!this.data.agreed) {
      Toast('请先同意消费协议');
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      if (this.data.existingOrderNo && this.data.paymentMethod === 'offline') {
        // 扫码 + 线下付款
        await callClientApi('order.offlinePay', { orderNo: this.data.existingOrderNo });
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }

      if (this.data.existingOrderNo && this.data.paymentMethod === 'wechat') {
        // 扫码 + 微信支付
        await this.doWechatPay(this.data.existingOrderNo);
        return;
      }

      // 自助下单
      // 需要先获取门店的市场名称
      const storeList = await callClientApi('store.list');
      const store = storeList?.stores?.find((s: any) => s.store_name === this.data.storeName);
      const marketName = store?.market_name || '';

      // 构建订单项
      let items: { skuId: string; quantity: number }[];
      if (this.data.fromCart) {
        items = this.data.cartItems.map(i => ({ skuId: i.skuId, quantity: i.quantity }));
      } else {
        items = [{ skuId: this.data.skuId, quantity: 1 }];
      }

      const data = await callClientApi('order.create', {
        storeName: this.data.storeName,
        marketName,
        items,
        preferredStaffWfId: this.data.staffWfId || null,
        paymentMethod: this.data.paymentMethod
      });

      const { orderNo } = data || {};
      if (!orderNo) throw new Error('创建订单失败');

      if (this.data.paymentMethod === 'offline') {
        if (this.data.fromCart) clearCart();
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` }), 1500);
      } else {
        await this.doWechatPay(orderNo);
        if (this.data.fromCart) clearCart();
      }
    } catch (err: any) {
      if (err?.code === -403 && err?.message?.includes('PHONE_REQUIRED')) {
        this.setData({ showPhoneBind: true });
      } else {
        Toast.fail(err?.message || '下单失败，请重试');
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  onClosePhoneBind() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast('您拒绝了授权');
      }
      return;
    }

    try {
      wx.showLoading({ title: '绑定中...', mask: true });

      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'auth.bindPhone',
          payload: {},
          phoneData: wx.cloud.CloudID(cloudID as string)
        }
      }) as any;

      wx.hideLoading();

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '绑定失败');
      }

      wx.setStorageSync('phone', res.result.data.phone);
      this.setData({ showPhoneBind: false });

      Toast.success('绑定成功');
      // 绑定成功后自动重新提交订单
      setTimeout(() => this.onSubmitOrder(), 800);
    } catch (err: any) {
      wx.hideLoading();
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  async doWechatPay(orderNo: string) {
    const data = await callClientApi('order.pay', { orderNo });
    const paymentParams = data?.paymentParams || {};
    await wx.requestPayment(paymentParams);
    Toast.success('支付成功');
    setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` }), 1200);
  },

  onShareAppMessage() {
    return { title: '凤御美容', path: '/pages/home/home' };
  },
});
