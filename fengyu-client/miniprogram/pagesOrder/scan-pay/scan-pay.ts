// pages/scan-pay/scan-pay.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';

Page({
  data: {
    order: null as any,
    items: [] as any[],
    orderNo: '',
    paymentMethod: 'wechat' as 'wechat' | 'alipay' | 'offline',
    isLoading: true,
    errorMsg: '',
    statusMsg: '',
    submitting: false,
    // 支付宝二维码弹窗
    showAlipayQr: false,
    alipayQrUrl: '',
    alipayAmount: '0.00',
  },

  onLoad(options) {
    const { scene, orderNo, saleOrderId } = options as { scene?: string; orderNo?: string; saleOrderId?: string };
    let targetOrderNo = saleOrderId || orderNo;
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

  async loadOrder(saleOrderId: string) {
    this.setData({ isLoading: true, errorMsg: '', statusMsg: '' });
    try {
      const data = await callClientApi('order.scanDetail', { saleOrderId });

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

  onPayMethodChange(e: WxEvent<string>) {
    this.setData({ paymentMethod: e.detail as 'wechat' | 'alipay' | 'offline' });
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: 'wechat' | 'alipay' | 'offline' };
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
        await callClientApi('order.offlinePay', { saleOrderId: orderNo });
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
        }, 1500);
        return;
      }

      if (paymentMethod === 'alipay') {
        const data = await callClientApi('order.alipayPay', { saleOrderId: orderNo });
        this.setData({
          showAlipayQr: true,
          alipayQrUrl: data?.qrCodeUrl || '',
          alipayAmount: Number(data?.totalAmount || 0).toFixed(2),
        });
        return;
      }

      // 微信支付
      const data = await callClientApi('order.pay', { saleOrderId: orderNo });
      const payParams = data.paymentParams || {};
      await wx.requestPayment(payParams);
      Toast.success('支付成功');
      setTimeout(() => {
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
      }, 1200);
    } catch (err: any) {
      Toast.fail(err?.message || err?.errMsg || '支付失败，请重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onAlipayDone() {
    this.setData({ showAlipayQr: false });
    wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${this.data.orderNo}` });
  },

  onAlipayClose() {
    this.setData({ showAlipayQr: false });
  },

  onShareAppMessage() {
    return { title: '凤御收款', path: '/pages/home/home' };
  },
});
