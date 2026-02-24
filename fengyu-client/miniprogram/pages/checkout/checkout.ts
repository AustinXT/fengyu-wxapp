// pages/checkout/checkout.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

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
  },

  onLoad(options) {
    const { skuId, spuName, staffWfId, staffName, orderNo } = options as Record<string, string>;
    const storeName = app.globalData.boundStoreName;

    if (orderNo) {
      // 场景 B：扫码收款，订单已存在
      this.setData({ existingOrderNo: orderNo });
      this.loadExistingOrder(orderNo);
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
      const res = await wx.cloud.callFunction({
        name: 'getSkuPrice',
        data: { skuId, storeName: app.globalData.boundStoreName },
      }) as any;
      const data = res.result?.data || {};
      this.setData({
        skuDisplayName: data.sku_display_name || '',
        unitPrice: data.price || '0.00',
      });
    } catch {
      Toast.fail('加载价格失败');
    }
  },

  async loadExistingOrder(orderNo: string) {
    try {
      const res = await wx.cloud.callFunction({ name: 'getOrderDetail', data: { orderNo } }) as any;
      const order = res.result?.data || {};
      const firstItem = order.items?.[0] || {};
      this.setData({
        spuName: firstItem.spu_name || '',
        skuDisplayName: firstItem.sku_display_name || '',
        unitPrice: order.total_amount || '0.00',
        storeName: order.store_name || '',
      });
    } catch {
      Toast.fail('加载订单信息失败');
    }
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
        await wx.cloud.callFunction({
          name: 'submitOfflinePayment',
          data: { orderNo: this.data.existingOrderNo },
        });
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
      const res = await wx.cloud.callFunction({
        name: 'createOrder',
        data: {
          skuId: this.data.skuId,
          staffWfId: this.data.staffWfId || null,
          paymentMethod: this.data.paymentMethod,
          storeName: this.data.storeName,
        },
      }) as any;

      const { orderNo } = res.result?.data || {};
      if (!orderNo) throw new Error('创建订单失败');

      if (this.data.paymentMethod === 'offline') {
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` }), 1500);
      } else {
        await this.doWechatPay(orderNo);
      }
    } catch (err: any) {
      Toast.fail(err?.message || '下单失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  async doWechatPay(orderNo: string) {
    const res = await wx.cloud.callFunction({
      name: 'createWechatPayment',
      data: { orderNo },
    }) as any;
    const payParams = res.result?.data || {};
    await wx.requestPayment(payParams);
    Toast.success('支付成功');
    setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` }), 1200);
  },

  onShareAppMessage() {
    return { title: '凤御美容', path: '/pages/home/home' };
  },
});
