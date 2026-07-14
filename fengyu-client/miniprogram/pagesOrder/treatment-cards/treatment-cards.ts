
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { calculateTriProgress } from '../../utils/format';
import { ORDERS_ENTRY_ENABLED } from '../../utils/feature-flags';

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

      
      const cards: any[] = [];
      for (const order of orders) {
        for (const item of (order.items || [])) {
          const paidRaw = item.paidSessions;
          const paid = Number(paidRaw ?? 0);
          const total = Number(item.sessionCount ?? 0);
          const remaining = Number(item.remainingSessions ?? 0);
          const used = Math.max(0, total - remaining);
          const { usedPct, paidUnusedPct, unpaidPct } = calculateTriProgress(total, remaining, paid);
          cards.push({
            ...item,
            paidSessions: paid,
            
            paidSessionsNull: paidRaw == null,
            saleOrderId: order.saleOrderId,
            storeName: order.storeName,
            usedSessions: used,
            paidUnusedSessions: paidRaw == null ? remaining : Math.max(0, paid - used),
            usedPct,
            paidUnusedPct,
            unpaidPct,
            expireFmt: item.expireDate ? item.expireDate.slice(0, 10) : '',
          });
        }
      }

      
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
    
    if (!ORDERS_ENTRY_ENABLED) {
      wx.showToast({ title: '订单功能即将开放', icon: 'none' });
      return;
    }
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
  },

  onBookTap(e: WechatMiniprogram.TouchEvent) {
    
    const { saleItemId } = e.currentTarget.dataset as { saleItemId: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleItemId=${saleItemId}` });
  },
});
