// pages/appointment/appointment.ts
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { callClientApi } from '../../utils/cloud';
import { formatAppointmentTime } from '../../utils/format';

const PAGE_SIZE = 20;
const app = getApp<IAppOption>();

const STATUS_MAP: Record<string, { label: string; type: string; color: string; textColor: string }> = {
  '待确认': { label: '待确认', type: 'warning',  color: '#FFF7E6', textColor: '#D48806' },
  '已确认': { label: '已确认', type: 'primary',  color: '#F2E8DC', textColor: '#A0785A' },
  '已完成': { label: '已完成', type: 'success',  color: '#F0FAF0', textColor: '#389E0D' },
  '已取消': { label: '已取消', type: 'default',  color: '#F5F5F5', textColor: '#8C8C8C' },
  '已关闭': { label: '已关闭', type: 'default',  color: '#F5F5F5', textColor: '#8C8C8C' },
};

// Tab name → 数据库 status 映射
const TAB_STATUS_MAP: Record<string, string> = {
  'pending':   '待确认',
  'confirmed': '已确认',
  'cancelled': '已取消',
};

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
    loadingMore: false,
    loadError: false,
    hasMore: true,
    isLoggedOut: false,
  },

  _page: 1,

  onShow() {
    if (app.isLoggedOut()) {
      this.clearPrivateData();
      return;
    }
    this.setData({ isLoggedOut: false });
    this.loadList();
  },

  onPullDownRefresh() {
    if (app.isLoggedOut()) {
      this.clearPrivateData();
      wx.stopPullDownRefresh();
      return;
    }
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
    this.setData({ activeTab: e.detail.name });
    this.loadList();
  },

  _mapItems(raw: any[]) {
    return raw.map(item => {
      const meta = STATUS_MAP[item.status] || STATUS_MAP['已关闭'];
      const rawTime = String(item.appointment_time);
      return {
        ...item,
        status_label:     meta.label,
        statusType:       meta.type,
        statusColor:      meta.color,
        statusTextColor:  meta.textColor,
        appointment_time_fmt: formatAppointmentTime(rawTime),
      };
    });
  },

  clearPrivateData() {
    this._page = 1;
    this.setData({
      list: [],
      isLoading: false,
      loadingMore: false,
      loadError: false,
      hasMore: false,
      isLoggedOut: true,
    });
  },

  async loadList() {
    if (app.isLoggedOut()) {
      this.clearPrivateData();
      return;
    }
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const dbStatus = TAB_STATUS_MAP[this.data.activeTab];
      const payload: Record<string, any> = { page: 1, pageSize: PAGE_SIZE };
      if (dbStatus) payload.status = dbStatus;
      const data = await callClientApi('appointment.list', payload);
      const raw: any[] = data?.appointments || [];
      this.setData({
        list: this._mapItems(raw),
        hasMore: data?.hasMore ?? false,
      });
    } catch {
      Toast.fail('加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async loadMore() {
    if (app.isLoggedOut()) {
      this.clearPrivateData();
      return;
    }
    this._page += 1;
    this.setData({ loadingMore: true });
    try {
      const dbStatus = TAB_STATUS_MAP[this.data.activeTab];
      const payload: Record<string, any> = { page: this._page, pageSize: PAGE_SIZE };
      if (dbStatus) payload.status = dbStatus;
      const data = await callClientApi('appointment.list', payload);
      const raw: any[] = data?.appointments || [];
      this.setData({
        list: [...this.data.list, ...this._mapItems(raw)],
        hasMore: data?.hasMore ?? false,
      });
    } catch {
      this._page -= 1;
      Toast.fail('加载更多失败');
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onCreateAppointment() {
    if (app.isLoggedOut()) {
      wx.navigateTo({ url: '/pagesProfile/profile-edit/profile-edit' });
      return;
    }
    wx.navigateTo({ url: '/pagesAppointment/appointment-create/appointment-create' });
  },

  onCancelAppt(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string };
    Dialog.confirm({ title: '取消预约', message: '确定要取消此预约吗？取消后可重新发起。' })
      .then(async () => {
        try {
          await callClientApi('appointment.cancel', { appointmentId: id });
          Toast.success('预约已取消');
          this.loadList();
        } catch {
          Toast.fail('操作失败，请稍后重试');
        }
      })
      .catch(() => {});
  },

  onShareAppMessage() {
    // 分享礼：被分享人进入首页而非分享者的预约页
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御预约', path: `/pages/home/home${invSuffix}` };
  },
});
