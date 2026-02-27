// pages/appointment-detail/appointment-detail.ts
import { callStaffApi } from '../../utils/cloud';

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
    appt: null as any,
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
      const data = await callStaffApi<any>('appointment.detail', { id });
      const sm = STATUS_MAP[data.status] || { text: data.status, cls: 'pending' };
      this.setData({ appt: data, statusText: sm.text, statusCls: sm.cls });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onConfirm() {
    const id = this.data.appt?.id;
    if (!id) return;
    wx.showModal({
      title: '确认预约',
      content: '确认该顾客的预约请求？',
      confirmText: '确认',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('appointment.confirm', { appointmentId: id });
          wx.showToast({ title: '已确认预约', icon: 'success' });
          this.loadDetail(id);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  async onCheckin() {
    const id = this.data.appt?.id;
    if (!id) return;
    try {
      await callStaffApi('appointment.checkin', { appointmentId: id });
      wx.showToast({ title: '顾客到店已记录', icon: 'success' });
      this.loadDetail(id);
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onCreateService() {
    const id = this.data.appt?.id;
    wx.navigateTo({ url: `/pages/service-create/service-create?appointmentId=${id}` });
  },

  onViewServiceOrder() {
    const svcId = this.data.appt?.serviceOrderId;
    if (svcId) {
      wx.navigateTo({ url: `/pages/service-detail/service-detail?id=${svcId}` });
    }
  },
});
