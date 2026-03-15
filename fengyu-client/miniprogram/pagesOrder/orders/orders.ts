// pages/orders/orders.ts
import Toast from '@vant/weapp/toast/toast';
import { getStatusClass } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
    loadError: false,
  },

  onLoad(options) {
    const { status } = options as { status?: string };
    if (status) {
      this.setData({ activeTab: status });
    }
    this.loadOrders();
  },

  onShow() {
    this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
    this.setData({ activeTab: e.detail.name });
    this.loadOrders();
  },

  async loadOrders() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const payload = this.data.activeTab === 'all' ? {} : { status: this.data.activeTab };
      const data = await callClientApi('order.list', payload);
      const orders: any[] = data?.orders || [];
      const list = orders.map(item => {
        const rawDt = String(item.sale_order_datetime);
        const d = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(/-/g, '/'));
        const hasAppointable = item.status === '已支付'
          && (item.items || []).some((i: any) =>
            i.product_type !== '院装产品' && (i.remaining_sessions ?? 0) > 0
          );
        return {
          ...item,
          statusClass: getStatusClass(item.status),
          order_time_fmt: `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`,
          hasAppointable,
        };
      });
      this.setData({ list });
    } catch {
      Toast.fail('加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
  },

  onPayTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/checkout/checkout?saleOrderId=${saleOrderId}` });
  },

  async onCancelTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    try {
      const res = await wx.showModal({
        title: '确认取消',
        content: '确定要取消该订单吗？取消后无法恢复。',
        confirmText: '确定取消',
        confirmColor: '#FF4D4F',
      });
      if (!res.confirm) return;
      Toast.loading({ message: '取消中...', forbidClick: true, duration: 0 });
      await callClientApi('order.cancel', { saleOrderId });
      Toast.success('订单已取消');
      this.loadOrders();
    } catch (err: any) {
      Toast.fail(err.message || '取消失败');
    }
  },

  onAppointmentTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleOrderId=${saleOrderId}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pagesOrder/orders/orders' };
  },
});
