
import Toast from '@vant/weapp/toast/toast';
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
      const data: any = await callClientApi('staff.detail', { employeeId });
      
      const now = Date.now();
      const ls = data?.leaveStart ? new Date(data.leaveStart).getTime() : NaN;
      const le = data?.leaveEnd ? new Date(data.leaveEnd).getTime() : NaN;
      const onLeave = !isNaN(ls) && !isNaN(le) && now >= ls && now <= le;
      this.setData({ staff: { ...data, onLeave } });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
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
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: staff ? `凤御美容 — ${staff.name}` : '凤御美容',
      path: `/pages/home/home${invSuffix}`
    };
  },
});
