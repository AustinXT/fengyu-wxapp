// pagesShop/staff-detail/staff-detail.ts
import { callClientApi } from '../../utils/cloud';

Page({
  data: {
    staff: null as any,
    isLoading: true,
  },

  onLoad(options: { employeeId?: string }) {
    const employeeId = options.employeeId;
    if (!employeeId) return;
    this.loadDetail(employeeId);
  },

  async loadDetail(employeeId: string) {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('staff.detail', { employeeId });
      this.setData({ staff: data });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onBookAppointment() {
    const { staff } = this.data;
    if (!staff) return;
    wx.navigateTo({
      url: `/pagesAppointment/appointment-create/appointment-create?employeeId=${staff.employeeId}&employeeName=${encodeURIComponent(staff.name)}`
    });
  },

  onShareAppMessage() {
    const { staff } = this.data;
    return {
      title: staff ? `凤御美容 — ${staff.name}` : '凤御美容',
      path: staff ? `/pagesShop/staff-detail/staff-detail?employeeId=${staff.employeeId}` : '/pages/home/home'
    };
  },
});

export {};
