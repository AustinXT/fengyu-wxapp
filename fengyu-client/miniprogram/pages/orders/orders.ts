// pages/orders/orders.ts
import Toast from '@vant/weapp/toast/toast';

const STATUS_CLASS: Record<string, string> = {
  '待支付':     'status-class-pending',
  '待确认收款': 'status-class-confirm',
  '已支付':     'status-class-paid',
  '已完成':     'status-class-done',
  '支付失败':   'status-class-failed',
  '已关闭':     'status-class-closed',
};

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
  },

  onLoad() {
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
      const raw: any[] = data?.orders || [];
      const list = raw.map(item => {
        const d = new Date(item.order_datetime);
        return {
          ...item,
          statusClass: STATUS_CLASS[item.status] || 'status-class-done',
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
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` });
  },

  onPayTap(e: WechatMiniprogram.TouchEvent) {
    e.stopPropagation();
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pages/checkout/checkout?orderNo=${orderNo}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pages/orders/orders' };
  },
});
