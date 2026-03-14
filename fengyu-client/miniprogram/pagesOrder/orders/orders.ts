// pages/orders/orders.ts
import Toast from '@vant/weapp/toast/toast';
import { getStatusClass } from '../../utils/format';

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
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
    this.setData({ isLoading: true });
    try {
      const payload = this.data.activeTab === 'all' ? {} : { status: this.data.activeTab };
      const data = await callClientApi('order.list', payload);
      const orders: any[] = data?.orders || [];
      const list = orders.map(item => {
        const rawDt = String(item.sale_order_datetime);
        const d = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(/-/g, '/'));
        return {
          ...item,
          statusClass: getStatusClass(item.status),
          order_time_fmt: `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`,
        };
      });
      this.setData({ list });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
  },

  onPayTap(e: WechatMiniprogram.TouchEvent) {
    // catch:tap in WXML prevents bubbling; no JS stopPropagation needed
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/checkout/checkout?saleOrderId=${saleOrderId}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pagesOrder/orders/orders' };
  },
});
