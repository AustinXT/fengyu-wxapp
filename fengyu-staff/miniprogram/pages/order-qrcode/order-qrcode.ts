// pages/order-qrcode/order-qrcode.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

let pollTimer: ReturnType<typeof setInterval> | null = null;

Page({
  data: {
    loading: false,
    orderNo: '',
    customerName: '',
    totalAmount: '',
    qrcodeUrl: '',
    qrcodeError: '',
    retryCount: 0,
    status: '待扫码',    // '待扫码' | '待确认收款' | '已支付' | '已关闭'
    isManager: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    const orderNo = options.orderNo || '';
    if (orderNo) {
      this.setData({ orderNo });
      this.loadQrcode(orderNo);
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

  async loadQrcode(orderNo: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<any>('order.qrcode', { orderNo });

      // 后端返回了 qrcodeError 说明小程序码生成失败
      if (data.qrcodeError && !data.qrcodeUrl) {
        const retryCount = this.data.retryCount + 1;
        this.setData({
          orderNo: data.orderNo || '',
          customerName: data.customerName || '',
          totalAmount: data.totalAmount || '',
          qrcodeUrl: '',
          qrcodeError: data.qrcodeError,
          retryCount,
          status: data.qrCodeStatus || '待扫码',
          loading: false,
        });
        // 连续 3 次失败后停止轮询，等用户手动重试
        if (retryCount >= 3) {
          this.stopPolling();
        }
        return;
      }

      this.setData({
        orderNo: data.orderNo || '',
        customerName: data.customerName || '',
        totalAmount: data.totalAmount || '',
        qrcodeUrl: data.qrcodeUrl || '',
        qrcodeError: '',
        retryCount: 0,
        status: data.qrCodeStatus || '待扫码',
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
      if (this.data.orderNo && (this.data.status === '待扫码' || this.data.status === '待确认收款')) {
        this.loadQrcode(this.data.orderNo);
      }
    }, 3000);
  },

  stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  onRetryQrcode() {
    this.setData({ qrcodeError: '', retryCount: 0 });
    this.loadQrcode(this.data.orderNo);
    this.startPolling();
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
          await callStaffApi('order.confirmOffline', { orderNo: this.data.orderNo });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadQrcode(this.data.orderNo);
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
          await callStaffApi('order.close', { orderNo: this.data.orderNo });
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
