// pagesProfile/prepaid-cards/prepaid-cards.ts

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

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr.replace(/-/g, '/'));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

function formatAmount(amount: number): string {
  return amount >= 0 ? `+${amount.toFixed(2)}` : amount.toFixed(2);
}

Page({
  data: {
    totalBalance: 0,
    cards: [] as any[],
    isLoading: false,
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
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('card.list');
      const cards = data.cards || [];
      const totalBalance = cards.reduce((sum: number, c: any) => sum + (c.balance || 0), 0);
      this.setData({ cards, totalBalance });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async onSelectCard(e: WechatMiniprogram.TouchEvent) {
    const cardId = e.currentTarget.dataset.cardId;
    if (!cardId) return;

    // Toggle: tap again to collapse
    if (this.data.selectedCardId === cardId) {
      this.setData({ selectedCardId: '', transactions: [] });
      return;
    }

    this.setData({ selectedCardId: cardId, transactions: [], txLoading: true });
    try {
      const data = await callClientApi('card.history', { cardId });
      const transactions = (data.records || []).map((r: any) => ({
        ...r,
        displayDate: formatDate(r.createdAt),
        displayAmount: formatAmount(r.amount),
        isPositive: r.amount >= 0,
      }));
      this.setData({ transactions });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ txLoading: false });
    }
  },
});
