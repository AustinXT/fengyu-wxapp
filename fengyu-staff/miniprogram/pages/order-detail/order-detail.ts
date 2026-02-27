// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const STATUS_CLASS: Record<string, string> = {
  '待支付': 'pending',
  '待确认收款': 'pending',
  '已支付': 'success',
  '已完成': 'done',
  '支付失败': 'error',
  '已关闭': 'done',
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  normal: '正常单',
  promotion: '促销方案',
  experience: '体验单',
};

const PAY_TYPE_LABEL: Record<string, string> = {
  wechat: '微信支付',
  offline: '线下收款',
};

Page({
  data: {
    loading: false,
    order: null as any,
    isManager: false,
    statusClass: '',
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.loadDetail(options.id);
    }
  },

  async loadDetail(orderId: string) {
    this.setData({ loading: true });
    try {
      const order = await callStaffApi<any>('order.detail', { orderId });
      this.setData({
        order: {
          ...order,
          orderTypeLabel: ORDER_TYPE_LABEL[order.orderType] || order.orderType,
          payTypeLabel: PAY_TYPE_LABEL[order.payType] || order.payType || '—',
        },
        statusClass: STATUS_CLASS[order.status] || 'pending',
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReAllocation() {
    const id = this.data.order?.id;
    wx.navigateTo({ url: `/pages/revenue-allocation/revenue-allocation?orderId=${id}` });
  },

  onResetFailed() {
    const id = this.data.order?.id;
    wx.showModal({
      title: '重置支付',
      content: '确认将此订单重置为"待支付"状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.resetFailed', { orderId: id });
          wx.showToast({ title: '已重置', icon: 'success' });
          this.loadDetail(id);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  async onConfirmOffline() {
    const id = this.data.order?.id;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.confirmOffline', { orderId: id });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadDetail(id);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
