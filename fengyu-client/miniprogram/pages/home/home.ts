// pages/home/home.ts
const app = getApp<IAppOption>();

Page({
  data: {
    boundStoreName: '',
  },

  onLoad() {
    const storeName = app.globalData.boundStoreName;
    this.setData({ boundStoreName: storeName });
  },

  onShow() {
    const storeName = app.globalData.boundStoreName;
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
