// pages/service-detail/service-detail.ts — 服务单详情
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

interface ServiceDetail {
  id: string;
  serviceOrderId: string;
  customerName: string;
  customerPhone: string;
  staffName: string;
  status: '待服务' | '服务中' | '已完成' | '已取消';
  serviceTime: string;
  startTime: string | null;
  completedTime: string | null;
  appointmentId: string | null;
  remark: string;
  items: Array<{
    saleItemId: string;
    itemName: string;
    spec: string;
    sessionCount: number;
    remainingSessions: number;
    totalSessions: number;
  }>;
}

Page({
  data: {
    loading: true,
    detail: null as ServiceDetail | null,
    isManager: false,
  },

  onLoad(options) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.loadDetail(options.id);
    }
  },

  onShow() {
    const { detail } = this.data;
    if (detail?.id) {
      this.loadDetail(detail.id);
    }
  },

  async loadDetail(id: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<ServiceDetail>('service.detail', { id });
      this.setData({ detail: data });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onStartService() {
    const { detail } = this.data;
    if (!detail) return;
    try {
      await callStaffApi('service.start', { serviceOrderId: detail.id });
      wx.showToast({ title: '服务已开始', icon: 'success' });
      this.loadDetail(detail.id);
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onCompleteService() {
    const { detail } = this.data;
    if (!detail) return;
    wx.showModal({
      title: '确认完成服务',
      content: '确认完成后将扣减1次疗程次数，操作不可撤销',
      confirmText: '确认完成',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('service.complete', { serviceOrderId: detail.id });
          wx.showToast({ title: '服务已完成', icon: 'success' });
          this.loadDetail(detail.id);
          setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 3000);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onCancelService() {
    const { detail } = this.data;
    if (!detail) return;
    wx.showModal({
      title: '取消服务单',
      content: '确认取消该服务单？不会扣减疗程次数。',
      confirmText: '确认取消',
      confirmColor: '#E53935',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('service.cancel', { serviceOrderId: detail.id });
          wx.showToast({ title: '服务单已取消', icon: 'success' });
          this.loadDetail(detail.id);
          setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 3000);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onBackToWorkbench() {
    wx.switchTab({ url: '/pages/workbench/workbench' });
  },

  onViewAppointment() {
    const { detail } = this.data;
    if (detail?.appointmentId) {
      wx.navigateTo({
        url: `/packageService/appointment-detail/appointment-detail?id=${detail.appointmentId}`
      });
    }
  },
});
