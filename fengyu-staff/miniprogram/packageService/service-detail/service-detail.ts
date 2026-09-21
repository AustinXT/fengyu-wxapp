// pages/service-detail/service-detail.ts — 服务单详情
import { callStaffApi } from '../../utils/cloud';
import { isManager, isManagementMode } from '../../utils/role';
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
  // 跨店支援单（#224）：单属于别的门店、指派给本人。取消仍归开单门店，故支援单不显示取消按钮
  storeId: string | null;
  storeName: string;
  isSupport: boolean;
  items: Array<{
    saleItemId: string;
    itemName: string;
    spec: string;
    sessionCount: number;
    remainingSessions: number;
    totalSessions: number;
    paidSessions: number | null;
    unit: string;
  }>;
  // 顾客评价（仅店长可见；后端按 manager 角色下发）
  review?: { rating: number; comment: string; createdAt: string } | null;
}

Page({
  data: {
    loading: true,
    submitting: false,
    detail: null as ServiceDetail | null,
    isManager: false,
    isReadOnly: false,
  },

  onLoad(options) {
    this.setData({ isManager: isManager(), isReadOnly: isManagementMode() });
    if (options.id) {
      this.loadDetail(options.id);
    }
  },

  onShow() {
    this.setData({ isManager: isManager(), isReadOnly: isManagementMode() });
    const { detail } = this.data;
    if (detail?.id) {
      this.loadDetail(detail.id);
    }
  },

  _isReadOnly() {
    return isManagementMode();
  },

  async loadDetail(id: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<ServiceDetail>('service.detail', { id });
      // 后端返回 started_at/completed_at 为原始 timestamp，统一格式化为 YYYY-MM-DD HH:mm:ss
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
    if (this._isReadOnly()) return;
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
    if (this._isReadOnly()) return;
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '标记完成服务',
      content: '标记完成后将通知顾客确认，顾客确认后才扣减服务额度。',
      confirmText: '标记完成',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
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

  // 店长代客户确认（待客户确认 → 已完成，扣次数+计提成）
  onConfirmService() {
    if (this._isReadOnly()) return;
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '代客户确认',
      content: '确认后将扣减服务额度并完成服务单，仅在顾客不便自行确认时使用。',
      confirmText: '确认完成',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
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
    if (this._isReadOnly()) return;
    const { detail } = this.data;
    if (!detail || this.data.submitting) return;
    wx.showModal({
      title: '取消服务单',
      content: '确认取消该服务单？不会扣减服务额度。',
      confirmText: '确认取消',
      confirmColor: '#E53935',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
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
