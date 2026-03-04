// packageOrder/allocation-list/allocation-list.ts — 待分配订单列表
import { callStaffApi } from '../../utils/cloud';

interface PendingOrder {
  order_no: string;
  customer_name: string;
  client_phone: string;
  total_amount: string;
  paid_at: string;
  order_type: string;
  order_source: 'client' | 'staff';
  preferred_staff_wf_id: string | null;
}

Page({
  data: {
    loading: false,
    orders: [] as PendingOrder[],
    page: 1,
    hasMore: true,
  },

  onLoad() {
    this.loadOrders();
  },

  onShow() {
    // 从分配页返回时刷新
    if (this.data.orders.length > 0) {
      this.setData({ page: 1, orders: [], hasMore: true });
      this.loadOrders();
    }
  },

  onPullDownRefresh() {
    this.setData({ page: 1, orders: [], hasMore: true });
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadOrders();
    }
  },

  async loadOrders() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<{
        orders: PendingOrder[];
        page: number;
        pageSize: number;
      }>('allocation.pendingList', { page: this.data.page, pageSize: 20 });

      const orders = this.data.page === 1
        ? data.orders
        : [...this.data.orders, ...data.orders];

      this.setData({
        orders,
        hasMore: data.orders.length >= 20,
        page: this.data.page + 1,
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapOrder(e: WechatMiniprogram.TouchEvent) {
    const orderNo = e.currentTarget.dataset.orderNo as string;
    wx.navigateTo({
      url: `/packageOrder/revenue-allocation/revenue-allocation?orderNo=${orderNo}`,
    });
  },

  formatTime(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${day} ${h}:${min}`;
  },
});
