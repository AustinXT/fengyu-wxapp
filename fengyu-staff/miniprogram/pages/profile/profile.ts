// pages/profile/profile.ts — 我的
import { callStaffApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

Page({
  data: {
    staffName: '',
    role: '' as 'manager' | 'beautician' | '',
    staffWfId: '',
    phone: '',
    boundStoreName: '',
    // 门店绑定
    showStorePicker: false,
    storeList: [] as Array<{ storeId: string; storeName: string }>,
    storeColumns: [] as string[],
  },

  onShow() {
    const { staffName, role, staffWfId, phone, boundStoreName } = app.globalData;
    this.setData({ staffName, role, staffWfId, phone, boundStoreName });
  },

  onBindPhone() {
    wx.showToast({ title: '请通过「绑定手机号」按钮授权', icon: 'none' });
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
    wx.navigateTo({ url: '/pages/order-list/order-list' });
  },

  onNavServices() {
    wx.navigateTo({ url: '/pages/service-list/service-list' });
  },

  onNavCustomers() {
    wx.navigateTo({ url: '/pages/customer-list/customer-list' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorageSync();
          app.setStaffInfo({
            userId: '', staffWfId: '', staffName: '',
            role: '', boundStoreName: '', boundStoreId: '', phone: ''
          });
          this.setData({
            staffName: '', role: '', staffWfId: '', phone: '',
            boundStoreName: '', storeList: [], storeColumns: [],
          });
          wx.showToast({ title: '已退出', icon: 'success' });
        }
      }
    });
  },
});
