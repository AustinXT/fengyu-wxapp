
import { callStaffApi } from '../../utils/cloud';
import { isManager, getStaffWfId } from '../../utils/role';

let pollTimer: ReturnType<typeof setInterval> | null = null;

Page({
  data: {
    loading: false,
    submitting: false,
    saleOrderId: '',
    customerName: '',
    totalAmount: '',
    actualPayable: '',
    qrcodeUrl: '',
    qrcodeError: '',
    retryCount: 0,
    status: '待扫码',    
    isManager: false,
    isCreator: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    const saleOrderId = options.saleOrderId || '';
    if (saleOrderId) {
      this.setData({
        saleOrderId,
        customerName: options.customerName ? decodeURIComponent(options.customerName) : '',
      });
      this.loadQrcode(saleOrderId);
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

  async loadQrcode(saleOrderId: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<any>('order.qrcode', { saleOrderId });
      const isCreator = data.openedBy === getStaffWfId();

      
      if (data.qrcodeError && !data.qrcodeUrl) {
        const retryCount = this.data.retryCount + 1;
        this.setData({
          saleOrderId: data.saleOrderId || '',
          customerName: data.customerName || '',
          totalAmount: data.totalAmount || '',
          actualPayable: data.actualPayable != null ? data.actualPayable : '',
          qrcodeUrl: '',
          qrcodeError: data.qrcodeError,
          retryCount,
          status: data.qrCodeStatus || '待扫码',
          isCreator,
          loading: false,
        });
        
        if (retryCount >= 3) {
          this.stopPolling();
        }
        return;
      }

      const status = data.qrCodeStatus || '待扫码';
      this.setData({
        saleOrderId: data.saleOrderId || '',
        customerName: data.customerName || '',
        totalAmount: data.totalAmount || '',
        actualPayable: data.actualPayable != null ? data.actualPayable : '',
        qrcodeUrl: data.qrcodeUrl || '',
        qrcodeError: '',
        retryCount: 0,
        status,
        isCreator,
        loading: false,
      });

      if (status === '已支付') {
        this.stopPolling();
        wx.showToast({ title: '支付成功', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 1500);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  startPolling() {
    this.stopPolling();
    pollTimer = setInterval(() => {
      if (this.data.saleOrderId && (this.data.status === '待扫码' || this.data.status === '待确认收款')) {
        this.loadQrcode(this.data.saleOrderId);
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
    this.loadQrcode(this.data.saleOrderId);
    this.startPolling();
  },

  onConfirmOffline() {
    if (!this.data.isManager || this.data.submitting) return;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          const result = await callStaffApi<{ status?: string }>('order.confirmOffline', { saleOrderId: this.data.saleOrderId });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          if (result && result.status === '已支付') {
            
            this.loadQrcode(this.data.saleOrderId);
          } else {
            
            
            this.stopPolling();
            setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 1500);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  async onCloseOrder() {
    
    if ((!this.data.isManager && !this.data.isCreator) || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await callStaffApi('order.close', { saleOrderId: this.data.saleOrderId });
      wx.showToast({ title: '订单已作废', icon: 'success' });
      this.stopPolling();
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
      
      const slider = this.selectComponent('#closeSlider') as { reset?: () => void } | null;
      slider?.reset?.();
    } finally {
      this.setData({ submitting: false });
    }
  },
});
