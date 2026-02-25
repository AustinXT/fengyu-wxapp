// app.ts — 凤御客户端小程序
App<IAppOption>({
  globalData: {
    userInfo: null as WechatMiniprogram.UserInfo | null,
    userId: '' as string,
    boundStoreName: '' as string,
    boundStoreId: '' as string,
  },

  onLaunch() {
    wx.cloud.init({ traceUser: true });
    // 先从本地缓存恢复（快速展示）
    this.restoreFromCache();
    // 再从服务器同步最新数据（含 boundStoreName）
    this.syncLoginState();
  },

  restoreFromCache() {
    const userId = wx.getStorageSync('userId');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    if (userId) {
      this.globalData.userId = userId;
    }
    if (boundStoreName) {
      this.globalData.boundStoreName = boundStoreName;
    }
  },

  async syncLoginState() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: { action: 'auth.login', payload: {} }
      }) as any;
      if (res.result?.code === 0 && res.result.data) {
        const { userId, phone, boundStoreName } = res.result.data;
        if (userId) {
          this.globalData.userId = userId;
          wx.setStorageSync('userId', userId);
        }
        if (phone) {
          wx.setStorageSync('phone', phone);
        }
        // 同步服务器端绑定的门店（核心：即使本地缓存被清除也能恢复）
        if (boundStoreName) {
          this.globalData.boundStoreName = boundStoreName;
          wx.setStorageSync('boundStoreName', boundStoreName);
        }
      }
    } catch (err) {
      console.error('[syncLoginState] failed:', err);
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
