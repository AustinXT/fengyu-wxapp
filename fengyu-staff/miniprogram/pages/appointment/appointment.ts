// pages/appointment/appointment.ts — 预约管理
import { callStaffApi } from '../../utils/cloud';

type ApptStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'closed';

interface ApptItem {
  id: string;
  customerName: string;
  customerPhone: string;
  staffName: string;
  appointmentTime: string;
  status: ApptStatus;
  statusText: string;
  statusType: string;
}

const STATUS_MAP: Record<ApptStatus, { text: string; type: string }> = {
  pending:   { text: '待确认', type: 'warning' },
  confirmed: { text: '已确认', type: 'primary' },
  completed: { text: '已完成', type: 'success' },
  cancelled: { text: '已取消', type: 'default' },
  closed:    { text: '已关闭', type: 'default' },
};

Page({
  data: {
    loading: false,
    tabActive: 'pending',
    list: [] as ApptItem[],
    page: 1,
    hasMore: true,
  },

  onShow() {
    this.resetAndLoad();
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ tabActive: e.detail.name });
    this.resetAndLoad();
  },

  resetAndLoad() {
    this.setData({ list: [], page: 1, hasMore: true });
    this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const rawList = await callStaffApi<any[]>('appointment.list', {
        status: this.data.tabActive === 'all' ? undefined : this.data.tabActive,
        todayOnly: this.data.tabActive === 'today',
        page: this.data.page,
        pageSize: 20,
      });
      const mapped: ApptItem[] = (rawList || []).map((r: any) => ({
        id: r.id,
        customerName: r.customerName || '',
        customerPhone: r.customerPhone || '',
        staffName: r.staffName || '',
        appointmentTime: r.appointmentTime || '',
        status: r.status as ApptStatus,
        statusText: STATUS_MAP[r.status as ApptStatus]?.text || r.status,
        statusType: STATUS_MAP[r.status as ApptStatus]?.type || 'default',
      }));
      this.setData({
        list: [...this.data.list, ...mapped],
        hasMore: mapped.length === 20,
        page: this.data.page + 1,
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    this.loadList();
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/appointment-detail/appointment-detail?id=${id}` });
  },

  async onConfirmAppt(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    try {
      await callStaffApi('appointment.confirm', { appointmentId: id });
      wx.showToast({ title: '已确认预约', icon: 'success' });
      this.resetAndLoad();
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  async onCheckin(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    try {
      await callStaffApi('appointment.checkin', { appointmentId: id });
      wx.showToast({ title: '顾客到店已记录', icon: 'success' });
      this.resetAndLoad();
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onCreateService(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/service-create/service-create?appointmentId=${id}` });
  },
});
