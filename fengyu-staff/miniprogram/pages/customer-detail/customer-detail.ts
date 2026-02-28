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
      this.loadAll({ id: options.id });
    } else if (options.clientUserId) {
      this.loadAll({ clientUserId: options.clientUserId });
    }
  },

  async loadAll(query: { id?: string; clientUserId?: string }) {
    this.setData({ loading: true });
    try {
      const customer = await callStaffApi<any>('customer.detail', query);
      let orders: any[] = [];
      if (customer.clientUserId) {
        orders = await callStaffApi<any[]>('customer.paidOrders', { clientUserId: customer.clientUserId }) || [];
      } else if (customer.phone) {
        orders = await callStaffApi<any[]>('customer.paidOrders', { clientPhone: customer.phone }) || [];
      }
      this.setData({ customer, orders });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onNewService() {
    const customer = this.data.customer;
    if (!customer) return;
    // 优先传 PG clientUserId，否则传 phone
    if (customer.clientUserId) {
      wx.navigateTo({ url: `/pages/service-create/service-create?clientUserId=${customer.clientUserId}` });
    } else if (customer.phone) {
      wx.navigateTo({ url: `/pages/service-create/service-create?clientPhone=${customer.phone}` });
    } else {
      wx.showToast({ title: '顾客未注册，无法创建服务单', icon: 'none' });
    }
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },
});
