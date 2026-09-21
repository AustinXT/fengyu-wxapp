// pages/service/service.ts — 服务 Tab
import { callStaffApi } from '../../utils/cloud';
import { isManagementMode, isManager } from '../../utils/role';
import { getElapsedTime as _getElapsedTime, formatTime as _formatTime, formatDateTime } from '../../utils/formatters';

const app = getApp<IAppOption>();

interface ServiceItem {
  id: string;
  serviceOrderId: string;
  customerName: string;
  customerPhone: string;
  staffName: string;
  status: '待服务' | '服务中' | '待客户确认' | '已完成' | '已取消';
  serviceTime: string;
  startTime: string | null;
  completedTime: string | null;
  // #224 跨店支援单。inCurrentStore 由云函数下发，与 cancel/confirm 的门店门同源——
  // 前端据它决定是否渲染「取消 / 代客户确认」，自行推导会与后端判据错位造出点了必报错的按钮。
  storeName: string;
  inCurrentStore: boolean;
  items: Array<{
    serviceItemId: string;   // wxml 的 wx:key，后端 list 下发
    itemName: string;
    spec: string;
    remainingSessions: number;
    totalSessions: number;
    paidSessions: number | null;
    unit: string;
  }>;
}

const createStatusOptions = (pending = 0, processing = 0) => [
  { text: '全部状态', value: '' },
  { text: `待服务${pending > 0 ? ` (${pending})` : ''}`, value: '待服务' },
  { text: `服务中${processing > 0 ? ` (${processing})` : ''}`, value: '服务中' },
  { text: '待客户确认', value: '待客户确认' },
  { text: '已完成', value: '已完成' },
  { text: '已取消', value: '已取消' },
];

Page({
  data: {
    loading: false,
    status: '待服务',
    statusOptions: createStatusOptions(),
    searchInput: '',
    keyword: '',
    startDate: '',
    endDate: '',
    list: [] as ServiceItem[],
    page: 1,
    hasMore: true,
    isManager: false,
    isReadOnly: false,
    actioningId: '',
  },

  _loadToken: 0,

  onLoad() {
    if (isManagementMode()) {
      this.setData({ isReadOnly: true });
      wx.reLaunch({ url: '/pages/mgmt-dashboard/mgmt-dashboard' });
    }
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    if (isManagementMode()) {
      wx.reLaunch({ url: '/pages/mgmt-dashboard/mgmt-dashboard' });
      return;
    }
    this.setData({ isManager: isManager(), isReadOnly: false });
    this.resetAndLoad();
    this.loadTabCounts();
  },

  onPullDownRefresh() {
    this.resetAndLoad().finally(() => wx.stopPullDownRefresh());
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

  onReachBottom() {
    this.loadList();
  },

  resetAndLoad() {
    this._loadToken += 1;
    this.setData({ list: [], page: 1, hasMore: true, loading: false });
    return this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    const loadToken = this._loadToken;
    this.setData({ loading: true });
    try {
      const list = await callStaffApi<ServiceItem[]>('service.list', {
        status: this.data.status || undefined,
        keyword: this.data.keyword || undefined,
        startDate: this.data.startDate || undefined,
        endDate: this.data.endDate || undefined,
        page: this.data.page,
        pageSize: 20,
      });
      // 后端返回 started_at/completed_at 为原始 timestamp，统一格式化为 YYYY-MM-DD HH:mm:ss
      const formatted = (list || []).map((it) => ({
        ...it,
        startTime: it.startTime ? formatDateTime(it.startTime) : it.startTime,
        completedTime: it.completedTime ? formatDateTime(it.completedTime) : it.completedTime,
      }));
      if (loadToken !== this._loadToken) return;
      this.setData({
        list: [...this.data.list, ...formatted],
        hasMore: formatted.length === 20,
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

  getElapsedTime(startTime: string | null): string {
    return _getElapsedTime(startTime);
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageService/service-detail/service-detail?id=${id}` });
  },

  async onStartService(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.actioningId) return;
    this.setData({ actioningId: id });
    try {
      await callStaffApi('service.start', { serviceOrderId: id });
      wx.showToast({ title: '服务已开始', icon: 'success' });
      this.resetAndLoad();
      this.loadTabCounts(); // 待服务 → 服务中，两枚角标都要跟着动（与 onCompleteService 一致）
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ actioningId: '' });
    }
  },

  onCompleteService(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.actioningId) return;
    wx.showModal({
      title: '标记完成服务',
      content: '标记完成后将通知顾客确认，顾客确认后才扣减服务额度。',
      confirmText: '标记完成',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        this.setData({ actioningId: id });
        try {
          await callStaffApi('service.complete', { serviceOrderId: id });
          wx.showToast({ title: '已完成，待顾客确认', icon: 'none' });
          this.resetAndLoad();
          this.loadTabCounts();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ actioningId: '' });
        }
      }
    });
  },

  // 店长代客户确认（待客户确认 → 已完成，扣次数+计提成）
  onConfirmService(e: WechatMiniprogram.TouchEvent) {
    if (this._isReadOnly()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.actioningId) return;
    wx.showModal({
      title: '代客户确认',
      content: '确认后将扣减服务额度并完成服务单，仅在顾客不便自行确认时使用。',
      confirmText: '确认完成',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        this.setData({ actioningId: id });
        try {
          await callStaffApi('service.confirm', { serviceOrderId: id });
          wx.showToast({ title: '服务已确认完成', icon: 'success' });
          this.resetAndLoad();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ actioningId: '' });
        }
      }
    });
  },

  async loadTabCounts() {
    try {
      const data = await callStaffApi<{ pending: number; processing: number }>('service.counts');
      this.setData({
        statusOptions: createStatusOptions(data.pending || 0, data.processing || 0),
      });
    } catch (_) {}
  },

  onNewService() {
    if (this._isReadOnly()) return;
    wx.navigateTo({ url: '/packageService/service-create/service-create' });
  },

  _isReadOnly() {
    return isManagementMode();
  },

  noop() {},

  formatTime(timeStr: string | null): string {
    return _formatTime(timeStr);
  },
});
