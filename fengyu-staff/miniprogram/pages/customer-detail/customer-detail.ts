// pages/customer-detail/customer-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

Page({
  data: {
    loading: false,
    customer: null as any,
    orders: [] as any[],
    appointments: [] as any[],
    isManager: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.loadAll(options.id);
    }
  },

  async loadAll(clientId: string) {
    this.setData({ loading: true });
    try {
      const [customer, orders] = await Promise.all([
        callStaffApi<any>('customer.detail', { id: clientId }),
        callStaffApi<any[]>('customer.paidOrders', { clientUserId: clientId }),
      ]);
      this.setData({ customer, orders: orders || [] });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onNewService() {
    const id = this.data.customer?.id;
    wx.navigateTo({ url: `/pages/service-create/service-create?clientUserId=${id}` });
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },
});
