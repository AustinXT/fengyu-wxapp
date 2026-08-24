// pagesProfile/messages/messages.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatRelativeTime } from '../../utils/format';
import { ORDERS_ENTRY_ENABLED } from '../../utils/feature-flags';

const PAGE_SIZE = 20;

const TYPE_COLOR_MAP: Record<string, string> = {
  appointment: '#096DD9',
  order: '#52C41A',
  points: '#C0322A',
  system: '#FAAD14',
};

const TYPE_ICON_MAP: Record<string, string> = {
  appointment: 'calendar-o',
  order: 'orders-o',
  points: 'gold-coin-o',
  system: 'info-o',
};

Page({
  data: {
    records: [] as any[],
    isLoading: false,
    loadingMore: false,
    loadError: false,
    hasMore: true,
  },

  _page: 1,

  onLoad() {
    this.loadMessages();
  },

  onPullDownRefresh() {
    this.loadMessages().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  _mapRecords(raw: any[]) {
    return raw.map((r: any) => ({
      ...r,
      displayTime: formatRelativeTime(r.createdAt),
      dotColor: TYPE_COLOR_MAP[r.type] || '#999999',
      iconName: TYPE_ICON_MAP[r.type] || 'info-o',
    }));
  },

  /** 加载首页（重置分页） */
  async loadMessages() {
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const data = await callClientApi('message.list', {
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
      const data = await callClientApi('message.list', {
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

  async onTapMessage(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index;
    const record = this.data.records[index];
    if (!record) return;

    // Mark as read
    if (!record.isRead) {
      try {
        await callClientApi('message.read', { messageId: record.id });
        this.setData({ [`records[${index}].isRead`]: true });
      } catch (err: any) {
        console.error('[messages] mark read error:', err);
      }
    }

    // Navigate based on type
    if (record.refEntity === 'order' && record.refId) {
      // 临时关闭：订单详情入口（业务平稳后恢复）。见 utils/feature-flags.ts
      if (!ORDERS_ENTRY_ENABLED) {
        wx.showToast({ title: '订单功能即将开放', icon: 'none' });
        return;
      }
      wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${record.refId}` });
    } else if (record.refEntity === 'appointment' && record.refId) {
      wx.switchTab({ url: '/pages/appointment/appointment' });
    }
  },
});
