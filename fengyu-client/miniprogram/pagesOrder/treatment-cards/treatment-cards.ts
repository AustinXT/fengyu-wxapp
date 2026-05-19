// pages/treatment-cards/treatment-cards.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { calculateTriProgress } from '../../utils/format';

Page({
  data: {
    cards: [] as any[],
    isLoading: false,
    loadError: false,
  },

  onShow() {
    this.loadCards();
  },

  onPullDownRefresh() {
    this.loadCards().finally(() => wx.stopPullDownRefresh());
  },

  async loadCards() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi('order.appointableItems', { includeInactive: true });
      const orders: any[] = data?.orders || [];

      // 展平为卡片列表（含三段进度：已用 / 已付未用 / 未付）
      const cards: any[] = [];
      for (const order of orders) {
        for (const item of (order.items || [])) {
          const paid = Number(item.paidSessions ?? 0);
          const total = Number(item.sessionCount ?? 0);
          const remaining = Number(item.remainingSessions ?? 0);
          const used = Math.max(0, total - remaining);
          const { usedPct, paidUnusedPct, unpaidPct } = calculateTriProgress(total, remaining, paid);
          cards.push({
            ...item,
            paidSessions: paid,
            saleOrderId: order.saleOrderId,
            storeName: order.storeName,
            usedSessions: used,
            usedPct,
            paidUnusedPct,
            unpaidPct,
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
      this.setData({ loadError: true });
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
    const { saleItemId } = e.currentTarget.dataset as { saleItemId: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleItemId=${saleItemId}` });
  },
});
