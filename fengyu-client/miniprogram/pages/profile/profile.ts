// pages/profile/profile.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

Page({
  data: {
    maskedPhone: '',
    boundStoreName: '',
  },

  onLoad() {
    this.refreshData();
  },

  onShow() {
    this.refreshData();
  },

  refreshData() {
    const phone = wx.getStorageSync('phone') as string || '';
    this.setData({
      maskedPhone: maskPhone(phone),
      boundStoreName: app.globalData.boundStoreName,
    });
  },

  onOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  onAppointments() {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  onBindPhone() {
    // 微信手机号授权组件，实现在页面内通过 button open-type="getPhoneNumber"
    wx.showToast({ title: '功能开发中', icon: 'none' });
  },

  onSwitchStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  onShareAppMessage() {
    return { title: '凤御美容', path: '/pages/home/home' };
  },
});
