// app.ts — 凤御客户端小程序
App<IAppOption>({
  globalData: {
    userInfo: null as WechatMiniprogram.UserInfo | null,
    userId: '' as string,
    boundStoreName: '' as string,
    boundStoreId: '' as string,
  },

  onLaunch() {
    // 登录态检查（由云函数处理）
    wx.cloud.init({ traceUser: true });
    this.checkLogin();
  },

  checkLogin() {
    const userId = wx.getStorageSync('userId');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    if (userId) {
      this.globalData.userId = userId;
    }
    if (boundStoreName) {
      this.globalData.boundStoreName = boundStoreName;
    }
  },

  setUserInfo(info: { userId: string; boundStoreName?: string }) {
    this.globalData.userId = info.userId;
    wx.setStorageSync('userId', info.userId);
    if (info.boundStoreName) {
      this.globalData.boundStoreName = info.boundStoreName;
      wx.setStorageSync('boundStoreName', info.boundStoreName);
    }
  },

  setStore(storeName: string) {
    this.globalData.boundStoreName = storeName;
    wx.setStorageSync('boundStoreName', storeName);
  },
});
