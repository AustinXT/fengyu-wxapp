// pagesProfile/points/points.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatDate, formatDateTimeShort } from '../../utils/format';
import { getMemberLevelBadgeClass } from '../../utils/member-level-badge';

const PAGE_SIZE = 20;

Page({
  data: {
    balance: 0,
    levelName: '',
    levelBadgeClass: 'member-level-badge--default',
    nextLevel: null as { name: string; minPoints: number } | null,
    expiringSoonPoints: 0,
    nextExpireDate: '',
    records: [] as any[],
    isLoading: false,
    loadingMore: false,
    loadError: false,
    balanceLoading: true,
    hasMore: true,
  },

  _page: 1,

  onLoad() {
    this.loadBalance();
    this.loadHistory();
  },

  onPullDownRefresh() {
    Promise.all([this.loadBalance(), this.loadHistory()]).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  async loadBalance() {
    this.setData({ balanceLoading: true });
    try {
      const data = await callClientApi('points.balance');
      this.setData({
        balance: data.balance || 0,
        levelName: data.levelName || '',
        levelBadgeClass: getMemberLevelBadgeClass(data.levelName || ''),
        nextLevel: data.nextLevel || null,
        expiringSoonPoints: data.expiringSoonPoints || 0,
        nextExpireDate: data.nextExpireAt ? formatDate(data.nextExpireAt) : '',
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
    } finally {
      this.setData({ balanceLoading: false });
    }
  },

  _mapRecords(raw: any[]) {
    return raw.map((r: any) => ({
      ...r,
      displayDate: formatDateTimeShort(r.createdAt),
      displayAmount: r.amount > 0 ? `+${r.amount}` : `${r.amount}`,
      isEarn: r.amount > 0,
    }));
  },

  /** 加载首页（重置分页） */
  async loadHistory() {
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const data = await callClientApi('points.history', {
        page: 1,
        pageSize: PAGE_SIZE,
      });
      const newRecords = this._mapRecords(data.records || []);
      this.setData({
        records: newRecords,
        hasMore: newRecords.length === PAGE_SIZE,
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  /** 加载更多（追加，错误不覆盖已有数据） */
  async loadMore() {
    this._page += 1;
    this.setData({ loadingMore: true });
    try {
      const data = await callClientApi('points.history', {
        page: this._page,
        pageSize: PAGE_SIZE,
      });
      const newRecords = this._mapRecords(data.records || []);
      this.setData({
        records: [...this.data.records, ...newRecords],
        hasMore: newRecords.length === PAGE_SIZE,
      });
    } catch {
      this._page -= 1;
      Toast.fail('加载更多失败');
    } finally {
      this.setData({ loadingMore: false });
    }
  },

});
