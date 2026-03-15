// pagesProfile/points/points.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatDateTime } from '../../utils/format';

Page({
  data: {
    balance: 0,
    levelName: '',
    nextLevel: null as { name: string; pointsNeeded: number } | null,
    activeTab: 0,
    records: [] as any[],
    isLoading: false,
    balanceLoading: true,
    page: 1,
    hasMore: true,
  },

  onLoad() {
    this.loadBalance();
    this.loadHistory();
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true, records: [] });
    Promise.all([this.loadBalance(), this.loadHistory()]).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoading) {
      this.loadHistory();
    }
  },

  async loadBalance() {
    this.setData({ balanceLoading: true });
    try {
      const data = await callClientApi('points.balance');
      this.setData({
        balance: data.balance || 0,
        levelName: data.levelName || '',
        nextLevel: data.nextLevel || null,
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
    } finally {
      this.setData({ balanceLoading: false });
    }
  },

  async loadHistory() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    try {
      const typeMap = ['all', 'earn', 'redeem'];
      const type = typeMap[this.data.activeTab] || 'all';
      const data = await callClientApi('points.history', {
        type: type === 'all' ? undefined : type,
        page: this.data.page,
        pageSize: 20,
      });
      const newRecords = (data.records || []).map((r: any) => ({
        ...r,
        displayDate: formatDateTime(r.createdAt),
        displayAmount: r.amount > 0 ? `+${r.amount}` : `${r.amount}`,
        isEarn: r.amount > 0,
      }));
      this.setData({
        records: this.data.page === 1 ? newRecords : [...this.data.records, ...newRecords],
        hasMore: newRecords.length >= 20,
        page: this.data.page + 1,
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index;
    this.setData({ activeTab: index, page: 1, hasMore: true, records: [] });
    this.loadHistory();
  },
});
