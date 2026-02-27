// pages/order-qrcode/order-qrcode.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

let pollTimer: ReturnType<typeof setInterval> | null = null;

Page({
  data: {
    loading: false,
    orderId: '',
    orderNo: '',
    customerName: '',
    totalAmount: '',
    qrcodeUrl: '',
    status: '待扫码',    // '待扫码' | '支付中' | '已支付' | '待确认收款' | '已关闭'
    isManager: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    const orderId = options.orderId || '';
    if (orderId) {
      this.setData({ orderId });
      this.loadQrcode(orderId);
    }
  },

  onShow() {
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  async loadQrcode(orderId: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<any>('order.qrcode', { orderId });
      this.setData({
        orderNo: data.orderNo || '',
        customerName: data.customerName || '',
        totalAmount: data.totalAmount || data.amount || '',
        qrcodeUrl: data.qrcodeUrl || '',
        status: data.status || '待扫码',
        loading: false,
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  startPolling() {
    this.stopPolling();
    pollTimer = setInterval(() => {
      if (this.data.orderId && (this.data.status === '待扫码' || this.data.status === '支付中')) {
        this.loadQrcode(this.data.orderId);
      }
    }, 3000);
  },

  stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  onConfirmOffline() {
    if (!this.data.isManager) return;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.confirmOffline', { orderId: this.data.orderId });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadQrcode(this.data.orderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onCloseOrder() {
    if (!this.data.isManager) return;
    wx.showModal({
      title: '关闭订单',
      content: '确认关闭该订单？关闭后不可恢复。',
      confirmText: '确认关闭',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.close', { orderId: this.data.orderId });
          wx.showToast({ title: '订单已关闭', icon: 'success' });
          this.stopPolling();
          setTimeout(() => wx.navigateBack(), 1500);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
