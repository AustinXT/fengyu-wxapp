// packageOrder/allocation-list/allocation-list.ts — 待分配订单列表
import { callStaffApi } from '../../utils/cloud';

interface PendingOrder {
  sale_order_id: string;
  customer_name: string;
  client_phone: string;
  total_amount: string;
  paid_at: string;
  sale_order_type: string;
  preferred_employee_id: string | null;
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
    // 从分配页返回时始终刷新
    this.setData({ page: 1, orders: [], hasMore: true });
    this.loadOrders();
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

      const formatted = (data.orders || []).map(o => ({
        ...o,
        paid_at_display: this.formatTime(o.paid_at),
      }));
      const orders = this.data.page === 1
        ? formatted
        : [...this.data.orders, ...formatted];

      this.setData({
        orders,
        hasMore: data.orders.length >= 20,
        page: this.data.page + 1,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapOrder(e: WechatMiniprogram.TouchEvent) {
    const saleOrderId = e.currentTarget.dataset.saleOrderId as string;
    wx.navigateTo({
      url: `/packageOrder/revenue-allocation/revenue-allocation?saleOrderId=${saleOrderId}`,
    });
  },

  formatTime(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr.replace(/-/g, '/'));
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${day} ${h}:${min}`;
  },
});
