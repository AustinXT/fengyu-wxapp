// pages/home/home.ts

Page({
  data: {
    boundStoreName: '',
  },

  onLoad() {
    const app = getApp<IAppOption>();
    const storeName = app?.globalData?.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
  },

  onShow() {
    const app = getApp<IAppOption>();
    const storeName = app?.globalData?.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreName: storeName });
    }
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  onNavigateToShop() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },

  onNavigateToAppointment() {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },
});
