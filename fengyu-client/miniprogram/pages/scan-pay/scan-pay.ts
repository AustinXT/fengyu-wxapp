// pages/scan-pay/scan-pay.ts
import Toast from '@vant/weapp/toast/toast';

Page({
  data: {
    order: null as any,
    orderNo: '',
    paymentMethod: 'wechat' as 'wechat' | 'offline',
    isLoading: true,
    errorMsg: '',
    submitting: false,
  },

  onLoad(options) {
    const { scene, orderNo } = options as { scene?: string; orderNo?: string };
    let targetOrderNo = orderNo;
    if (scene) {
      // 扫码进入，scene 是二维码参数
      targetOrderNo = decodeURIComponent(scene);
    }
    if (!targetOrderNo) {
      this.setData({ isLoading: false, errorMsg: '无效的二维码' });
      return;
    }
    this.setData({ orderNo: targetOrderNo });
    this.loadOrder(targetOrderNo);
  },

  async loadOrder(orderNo: string) {
    this.setData({ isLoading: true, errorMsg: '' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getOrderDetail', data: { orderNo } }) as any;
      const order = res.result?.data;
      if (!order) {
        this.setData({ errorMsg: '订单不存在或已被删除' });
        return;
      }
      if (order.status !== '待支付') {
        this.setData({ errorMsg: `订单状态为「${order.status}」，无需再次付款` });
        return;
      }
      this.setData({ order });
    } catch {
      this.setData({ errorMsg: '加载订单信息失败，请稍后重试' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onPayMethodChange(e: WechatMiniprogram.CustomEvent<string>) {
    this.setData({ paymentMethod: e.detail as 'wechat' | 'offline' });
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: 'wechat' | 'offline' };
    this.setData({ paymentMethod: method });
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      const { orderNo, paymentMethod } = this.data;

      if (paymentMethod === 'offline') {
        await wx.cloud.callFunction({
          name: 'submitOfflinePayment',
          data: { orderNo },
        });
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` });
        }, 1500);
        return;
      }

      // 微信支付
      const res = await wx.cloud.callFunction({
        name: 'createWechatPayment',
        data: { orderNo },
      }) as any;
      const payParams = res.result?.data || {};
      await wx.requestPayment(payParams);
      Toast.success('支付成功');
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` });
      }, 1200);
    } catch (err: any) {
      Toast.fail(err?.errMsg || '支付失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return { title: '凤御收款', path: '/pages/home/home' };
  },
});
