
import { callStaffApi } from '../../utils/cloud';

interface AppointmentDetail {
  id: string;
  status: string;
  customerName: string;
  customerPhone: string;
  appointmentTime: string;
  serviceItemName: string;
  employeeName: string;
  storeName: string;
  checkinAt: string | null;
  serviceOrderId: string | null;
  clientUserId: string | null;
}

const STATUS_MAP: Record<string, { text: string; cls: string }> = {
  pending:   { text: '待确认', cls: 'pending' },
  confirmed: { text: '已确认', cls: 'success' },
  completed: { text: '已完成', cls: 'done' },
  cancelled: { text: '已取消', cls: 'done' },
  closed:    { text: '已关闭', cls: 'done' },
};

Page({
  data: {
    loading: false,
    submitting: false,
    appt: null as AppointmentDetail | null,
    statusText: '',
    statusCls: '',
  },

  onLoad(options: Record<string, string>) {
    if (options.id) {
      this.loadDetail(options.id);
    }
  },

  onShow() {
    if (this.data.appt?.id) {
      this.loadDetail(this.data.appt.id);
    }
  },

  async loadDetail(id: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<AppointmentDetail>('appointment.detail', { id });
      const sm = STATUS_MAP[data.status] || { text: data.status, cls: 'pending' };
      this.setData({ appt: data, statusText: sm.text, statusCls: sm.cls });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onConfirm() {
    const id = this.data.appt?.id;
    if (!id || this.data.submitting) return;
    wx.showModal({
      title: '确认预约',
      content: '确认该顾客的预约请求？',
      confirmText: '确认',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('appointment.confirm', { appointmentId: id });
          wx.showToast({ title: '已确认预约', icon: 'success' });
          this.loadDetail(id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  async onCheckin() {
    const id = this.data.appt?.id;
    if (!id || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await callStaffApi('appointment.checkin', { appointmentId: id });
      wx.showToast({ title: '顾客到店已记录', icon: 'success' });
      this.loadDetail(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onCreateService() {
    const id = this.data.appt?.id;
    wx.navigateTo({ url: `/packageService/service-create/service-create?appointmentId=${id}` });
  },

  onBackToWorkbench() {
    wx.switchTab({ url: '/pages/workbench/workbench' });
  },

  onViewServiceOrder() {
    const svcId = this.data.appt?.serviceOrderId;
    if (svcId) {
      wx.navigateTo({ url: `/packageService/service-detail/service-detail?id=${svcId}` });
    }
  },
});
