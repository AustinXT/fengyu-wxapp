// pages/appointment/appointment.ts — 预约管理
import { callStaffApi } from '../../utils/cloud';
import { isManagementMode } from '../../utils/role';

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
  checkinAt: string | null;
}

const STATUS_MAP: Record<ApptStatus, { text: string; type: string }> = {
  pending:   { text: '待确认', type: 'warning' },
  confirmed: { text: '已确认', type: 'primary' },
  completed: { text: '已完成', type: 'success' },
  cancelled: { text: '已取消', type: 'default' },
  closed:    { text: '已关闭', type: 'default' },
};

const STATUS_OPTIONS = [
  { text: '全部状态', value: 'all' },
  { text: '待确认', value: 'pending' },
  { text: '已确认', value: 'confirmed' },
  { text: '已完成', value: 'completed' },
  { text: '已取消', value: 'cancelled' },
  { text: '已关闭', value: 'closed' },
];

Page({
  data: {
    loading: false,
    status: 'pending',
    statusOptions: STATUS_OPTIONS,
    searchInput: '',
    keyword: '',
    startDate: '',
    endDate: '',
    list: [] as ApptItem[],
    page: 1,
    hasMore: true,
    actioningId: '',
    isReadOnly: false,
  },

  _inited: false,
  _loadToken: 0,

  onLoad(options: Record<string, string>) {
    this.setData({ isReadOnly: isManagementMode() });
    if (options.tab) {
      this.setData({ status: options.tab });
    }
  },

  onShow() {
    this.setData({ isReadOnly: isManagementMode() });
    this.resetAndLoad();
  },

  onPullDownRefresh() {
    this.resetAndLoad().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  onStatusChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ status: e.detail as unknown as string });
    this.resetAndLoad();
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchInput: e.detail as unknown as string });
  },

  onSearch() {
    this.setData({ keyword: this.data.searchInput.trim() });
    this.resetAndLoad();
  },

  onSearchClear() {
    this.setData({ searchInput: '', keyword: '' });
    this.resetAndLoad();
  },

  onStartDateChange(e: WechatMiniprogram.PickerChange) {
    const startDate = e.detail.value as string;
    if (this.data.endDate && startDate > this.data.endDate) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    this.setData({ startDate });
    this.resetAndLoad();
  },

  onEndDateChange(e: WechatMiniprogram.PickerChange) {
    const endDate = e.detail.value as string;
    if (this.data.startDate && endDate < this.data.startDate) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' });
      return;
    }
    this.setData({ endDate });
    this.resetAndLoad();
  },

  clearDates() {
    this.setData({ startDate: '', endDate: '' });
    this.resetAndLoad();
  },

  resetAndLoad(): Promise<void> {
    this._loadToken += 1;
    this.setData({ list: [], page: 1, hasMore: true, loading: false });
    return this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    const loadToken = this._loadToken;
    this.setData({ loading: true });
    try {
      const rawList = await callStaffApi<any[]>('appointment.list', {
        status: this.data.status === 'all' ? undefined : this.data.status,
        keyword: this.data.keyword || undefined,
        startDate: this.data.startDate || undefined,
        endDate: this.data.endDate || undefined,
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
        checkinAt: r.checkinAt || null,
      }));
      if (loadToken !== this._loadToken) return;
      this.setData({
        list: [...this.data.list, ...mapped],
        hasMore: mapped.length === 20,
        page: this.data.page + 1,
      });
    } catch (err: unknown) {
      if (loadToken !== this._loadToken) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      if (loadToken === this._loadToken) this.setData({ loading: false });
    }
  },

  onReachBottom() {
    this.loadList();
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/packageService/appointment-detail/appointment-detail?id=${id}` });
  },

  async onConfirmAppt(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.actioningId) return;
    this.setData({ actioningId: id });
    try {
      await callStaffApi('appointment.confirm', { appointmentId: id });
      wx.showToast({ title: '已确认预约', icon: 'success' });
      this.resetAndLoad();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ actioningId: '' });
    }
  },

  async onCheckin(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.actioningId) return;
    this.setData({ actioningId: id });
    try {
      await callStaffApi('appointment.checkin', { appointmentId: id });
      wx.showToast({ title: '顾客到店已记录', icon: 'success' });
      this.resetAndLoad();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ actioningId: '' });
    }
  },

  onCreateService(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageService/service-create/service-create?appointmentId=${id}` });
  },

  _isReadOnly() {
    return isManagementMode();
  },
});
