
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTime } from '../../utils/formatters';

interface ServiceDetail {
  id: string;
  serviceOrderId: string;
  customerName: string;
  customerPhone: string;
  staffName: string;
  status: '待服务' | '服务中' | '待客户确认' | '已完成' | '已取消';
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
    paidSessions: number | null;
  }>;
  
  review?: { rating: number; comment: string; createdAt: string } | null;
}

Page({
  data: {
    loading: true,
    submitting: false,
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
      
      if (data.startTime) data.startTime = formatDateTime(data.startTime);
      if (data.completedTime) data.completedTime = formatDateTime(data.completedTime);
      if (data.review?.createdAt) data.review.createdAt = formatDateTime(data.review.createdAt);
      this.setData({ detail: data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onStartService() {
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await callStaffApi('service.start', { serviceOrderId: detail.id });
      wx.showToast({ title: '服务已开始', icon: 'success' });
      this.loadDetail(detail.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onCompleteService() {
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '标记完成服务',
      content: '标记完成后将通知顾客确认，顾客确认后才扣减疗程次数。',
      confirmText: '标记完成',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('service.complete', { serviceOrderId: detail.id });
          wx.showToast({ title: '已完成，待顾客确认', icon: 'none' });
          this.loadDetail(detail.id);
          setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 3000);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      }
    });
  },

  
  onConfirmService() {
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '代客户确认',
      content: '确认后将扣减疗程次数并完成服务单，仅在顾客不便自行确认时使用。',
      confirmText: '确认完成',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('service.confirm', { serviceOrderId: detail.id });
          wx.showToast({ title: '服务已确认完成', icon: 'success' });
          this.loadDetail(detail.id);
          setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 3000);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      }
    });
  },

  onCancelService() {
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '取消服务单',
      content: '确认取消该服务单？不会扣减疗程次数。',
      confirmText: '确认取消',
      confirmColor: '#E53935',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('service.cancel', { serviceOrderId: detail.id });
          wx.showToast({ title: '服务单已取消', icon: 'success' });
          this.loadDetail(detail.id);
          setTimeout(() => wx.switchTab({ url: '/pages/workbench/workbench' }), 3000);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
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
