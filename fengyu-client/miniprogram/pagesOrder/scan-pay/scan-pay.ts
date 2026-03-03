// pages/scan-pay/scan-pay.ts
import Toast from '@vant/weapp/toast/toast';

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const msg = (res.result?.message || '请求失败').replace(/^[A-Z_]+:\s*/, '');
    throw new Error(msg);
  }
  return res.result.data;
}

Page({
  data: {
    order: null as any,
    items: [] as any[],
    orderNo: '',
    paymentMethod: 'wechat' as 'wechat' | 'offline',
    isLoading: true,
    errorMsg: '',
    statusMsg: '',
    submitting: false,
  },

  onLoad(options) {
    const { scene, orderNo } = options as { scene?: string; orderNo?: string };
    let targetOrderNo = orderNo;
    if (scene) {
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
    this.setData({ isLoading: true, errorMsg: '', statusMsg: '' });
    try {
      const data = await callClientApi('order.scanDetail', { orderNo });

      // 非待支付订单：显示状态提示
      if (data.statusMsg) {
        this.setData({ statusMsg: data.statusMsg });
        return;
      }

      this.setData({
        order: data.order,
        items: data.items || [],
      });
    } catch (err: any) {
      this.setData({ errorMsg: err.message || '加载订单信息失败，请稍后重试' });
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
        await callClientApi('order.offlinePay', { orderNo });
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?orderNo=${orderNo}` });
        }, 1500);
        return;
      }

      // 微信支付
      const data = await callClientApi('order.pay', { orderNo });
      const payParams = data.paymentParams || {};
      await wx.requestPayment(payParams);
      Toast.success('支付成功');
      setTimeout(() => {
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?orderNo=${orderNo}` });
      }, 1200);
    } catch (err: any) {
      Toast.fail(err?.message || err?.errMsg || '支付失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return { title: '凤御收款', path: '/pages/home/home' };
  },
});
