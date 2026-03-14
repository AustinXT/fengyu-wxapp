// pages/profile/profile.ts — 我的
import { callStaffApi } from '../../utils/cloud';
import { bindPhone } from '../../utils/auth';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

Page({
  data: {
    staffName: '',
    position: '',
    staffWfId: '',
    phone: '',
    boundStoreName: '',
    isManager: false,
    // 门店绑定
    showStorePicker: false,
    storeList: [] as Array<{ storeId: string; storeName: string }>,
    storeColumns: [] as string[],
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const { staffName, position, staffWfId, phone, boundStoreName } = app.globalData;
    this.setData({ staffName, position, staffWfId, phone, boundStoreName, isManager: isManager() });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent) {
    if (!e.detail.cloudID) return
    try {
      await bindPhone(e.detail.cloudID)
      const { phone, staffWfId, staffName, position, boundStoreName } = app.globalData
      this.setData({ phone, staffWfId, staffName, position, boundStoreName, isManager: isManager() })
      wx.showToast({ title: '绑定成功', icon: 'success' })
    } catch (err: any) {
      wx.showToast({ title: err.message || '绑定失败', icon: 'none' })
    }
  },

  async onBindStore() {
    if (!this.data.storeList.length) {
      try {
        const data = await callStaffApi<Array<{ storeId: string; storeName: string }>>('store.list');
        this.setData({
          storeList: data || [],
          storeColumns: (data || []).map(s => s.storeName),
        });
      } catch (err: any) {
        wx.showToast({ title: '获取门店列表失败', icon: 'none' });
        return;
      }
    }
    this.setData({ showStorePicker: true });
  },

  onStorePickerClose() {
    this.setData({ showStorePicker: false });
  },

  async onStoreConfirm(e: WechatMiniprogram.CustomEvent) {
    const pickedName = e.detail.value as string;
    const store = this.data.storeList.find(s => s.storeName === pickedName);
    if (!store) return;
    this.setData({ showStorePicker: false });
    try {
      await callStaffApi('staff.bindStore', { storeId: store.storeId });
      app.setStaffInfo({ boundStoreName: store.storeName, boundStoreId: store.storeId });
      this.setData({ boundStoreName: store.storeName });
      wx.showToast({ title: '门店已切换', icon: 'success' });
    } catch (err: any) {
      wx.showToast({ title: err.message || '切换失败', icon: 'none' });
    }
  },

  onNavOrders() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list' });
  },

  onNavServices() {
    wx.switchTab({ url: '/pages/service/service' });
  },

  onNavCustomers() {
    wx.switchTab({ url: '/pages/customer-list/customer-list' });
  },

  onNavDashboard() {
    wx.navigateTo({ url: '/packageOrder/dashboard/dashboard' });
  },

  onNavPerformance() {
    wx.navigateTo({ url: '/packageOrder/staff-performance/staff-performance' });
  },

  onNavAppointments() {
    wx.navigateTo({ url: '/packageService/appointment/appointment' });
  },

  onNavAllocationList() {
    wx.navigateTo({ url: '/packageOrder/allocation-list/allocation-list' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: (res) => {
        if (res.confirm) {
          app.resetStaffInfo();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  },
});
