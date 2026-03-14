// pages/treatment-cards/treatment-cards.ts
import Toast from '@vant/weapp/toast/toast';

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
      const data = await callClientApi('order.appointableItems', { includeInactive: true });
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
            saleOrderId: order.saleOrderId,
            storeName: order.storeName,
            percent,
            expireFmt: item.expireDate ? item.expireDate.slice(0, 10) : '',
          });
        }
      }

      // 有余额的排前面，失效的排后面
      cards.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return 0;
      });

      this.setData({ cards });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
  },

  onBookTap(e: WechatMiniprogram.TouchEvent) {
    // catchtap in WXML already prevents event bubbling
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleOrderId=${saleOrderId}` });
  },
});
