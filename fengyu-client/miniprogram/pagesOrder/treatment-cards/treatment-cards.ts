// pages/treatment-cards/treatment-cards.ts
import Toast from '@vant/weapp/toast/toast';

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
    cards: [] as any[],
    isLoading: false,
  },

  onLoad() {
    this.loadCards();
  },

  onShow() {
    this.loadCards();
  },

  onPullDownRefresh() {
    this.loadCards().finally(() => wx.stopPullDownRefresh());
  },

  async loadCards() {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('order.appointableItems');
      const orders: any[] = data?.orders || [];

      // 展平为卡片列表
      const cards: any[] = [];
      for (const order of orders) {
        for (const item of order.items) {
          const percent = item.sessionCount > 0
            ? Math.round(((item.sessionCount - item.remainingSessions) / item.sessionCount) * 100)
            : 0;
          cards.push({
            ...item,
            orderNo: order.orderNo,
            storeName: order.storeName,
            percent,
            expireFmt: item.expireDate ? item.expireDate.slice(0, 10) : '',
          });
        }
      }

      this.setData({ cards });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?orderNo=${orderNo}` });
  },

  onBookTap(e: WechatMiniprogram.TouchEvent) {
    e.stopPropagation();
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?orderNo=${orderNo}` });
  },
});
