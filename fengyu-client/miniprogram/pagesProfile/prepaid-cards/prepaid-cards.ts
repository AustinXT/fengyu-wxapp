
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatShortDate, formatAmount } from '../../utils/format';

Page({
  data: {
    totalBalance: 0,
    cards: [] as any[],
    isLoading: false,
    loadError: false,
    selectedCardId: '',
    transactions: [] as any[],
    txLoading: false,
  },

  onLoad() {
    this.loadCards();
  },

  onPullDownRefresh() {
    this.setData({ selectedCardId: '', transactions: [] });
    this.loadCards().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  async loadCards() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi('card.list');
      const cards = data.cards || [];
      const totalBalance = cards.reduce((sum: number, c: any) => sum + (Number(c.balance) || 0), 0);
      this.setData({ cards, totalBalance });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async onSelectCard(e: WechatMiniprogram.TouchEvent) {
    const cardId = e.currentTarget.dataset.cardId;
    if (!cardId) return;

    
    if (this.data.selectedCardId === cardId) {
      this.setData({ selectedCardId: '', transactions: [] });
      return;
    }

    this.setData({ selectedCardId: cardId, transactions: [], txLoading: true });
    try {
      const data = await callClientApi('card.history', { cardId });
      const transactions = (data.records || []).map((r: any) => ({
        ...r,
        displayDate: formatShortDate(r.createdAt),
        displayAmount: formatAmount(r.amount),
        isPositive: Number(r.amount) >= 0,
      }));
      this.setData({ transactions });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
    } finally {
      this.setData({ txLoading: false });
    }
  },
});
