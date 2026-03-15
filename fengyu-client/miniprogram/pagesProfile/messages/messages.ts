// pagesProfile/messages/messages.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatRelativeTime } from '../../utils/format';

const TYPE_COLOR_MAP: Record<string, string> = {
  appointment: '#096DD9',
  order: '#52C41A',
  system: '#FAAD14',
};

const TYPE_ICON_MAP: Record<string, string> = {
  appointment: 'calendar-o',
  order: 'orders-o',
  system: 'info-o',
};

Page({
  data: {
    records: [] as any[],
    isLoading: false,
    page: 1,
    hasMore: true,
  },

  onLoad() {
    this.loadMessages();
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true, records: [] });
    this.loadMessages().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoading) {
      this.loadMessages();
    }
  },

  async loadMessages() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('message.list', {
        page: this.data.page,
        pageSize: 20,
      });
      const newRecords = (data.records || []).map((r: any) => ({
        ...r,
        displayTime: formatRelativeTime(r.createdAt),
        dotColor: TYPE_COLOR_MAP[r.type] || '#999999',
        iconName: TYPE_ICON_MAP[r.type] || 'info-o',
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
      wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?orderNo=${record.refId}` });
    } else if (record.refEntity === 'appointment' && record.refId) {
      wx.switchTab({ url: '/pages/appointment/appointment' });
    }
  },
});
