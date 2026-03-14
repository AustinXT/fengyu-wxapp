// pagesProfile/messages/messages.ts

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

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr.replace(/-/g, '/'));
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

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
        displayTime: formatTime(r.createdAt),
        dotColor: TYPE_COLOR_MAP[r.type] || '#999999',
        iconName: TYPE_ICON_MAP[r.type] || 'info-o',
      }));
      this.setData({
        records: this.data.page === 1 ? newRecords : [...this.data.records, ...newRecords],
        hasMore: newRecords.length >= 20,
        page: this.data.page + 1,
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
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

export {};
