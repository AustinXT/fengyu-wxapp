// pages/service/service.ts — 护理 Tab
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { getElapsedTime as _getElapsedTime, formatTime as _formatTime } from '../../utils/formatters';

const app = getApp<IAppOption>();

interface ServiceItem {
  id: string;
  serviceOrderId: string;
  customerName: string;
  customerPhone: string;
  staffName: string;
  status: '待服务' | '服务中' | '已完成';
  serviceTime: string;
  startTime: string | null;
  completedTime: string | null;
  items: Array<{
    itemName: string;
    spec: string;
    remainingSessions: number;
    totalSessions: number;
  }>;
}

Page({
  data: {
    loading: false,
    tabActive: 'pending',
    tabs: [
      { name: 'pending', label: '待服务', badge: 0 },
      { name: 'processing', label: '服务中', badge: 0 },
      { name: 'completed', label: '已完成', badge: 0 },
    ],
    list: [] as ServiceItem[],
    isManager: false,
  },

  onLoad() {},

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isManager: isManager() });
    this.loadList();
    this.loadTabCounts();
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const name = e.detail.name as string;
    this.setData({ tabActive: name });
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      const statusMap: Record<string, string> = {
        pending: '待服务',
        processing: '服务中',
        completed: '已完成',
      };
      const status = statusMap[this.data.tabActive] || this.data.tabActive;
      const list = await callStaffApi<ServiceItem[]>('service.list', {
        status,
      });
      this.setData({ list: list || [] });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
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
    const id = e.currentTarget.dataset.id as string;
    try {
      await callStaffApi('service.start', { serviceOrderId: id });
      wx.showToast({ title: '服务已开始', icon: 'success' });
      this.loadList();
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onCompleteService(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.showModal({
      title: '确认完成服务',
      content: '确认完成后将扣减1次疗程次数，操作不可撤销',
      confirmText: '确认完成',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('service.complete', { serviceOrderId: id });
          wx.showToast({ title: '服务已完成', icon: 'success' });
          this.loadList();
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  async loadTabCounts() {
    try {
      const data = await callStaffApi<{ pending: number; processing: number }>('service.counts');
      this.setData({
        'tabs[0].badge': data.pending || 0,
        'tabs[1].badge': data.processing || 0,
      });
    } catch (_) {}
  },

  onNewService() {
    wx.navigateTo({ url: '/packageService/service-create/service-create' });
  },

  noop() {},

  formatTime(timeStr: string | null): string {
    return _formatTime(timeStr);
  },
});
