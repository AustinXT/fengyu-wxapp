// app.ts — 凤御客户端小程序
App<IAppOption>({
  globalData: {
    userInfo: null as WechatMiniprogram.UserInfo | null,
    userId: '' as string,
    boundStoreName: '' as string,
    boundStoreId: '' as string,
    boundMarketName: '' as string,
    statusBarHeight: 44,
    navBarContentHeight: 44,
    navBarHeight: 88,
  },

  onLaunch() {
    wx.cloud.init({ traceUser: true });
    // 计算导航栏高度（需在 UI 渲染前完成）
    this.initNavBarInfo();
    // 先从本地缓存恢复（快速展示）
    this.restoreFromCache();
    // 再从服务器同步最新数据（含 boundStoreName）
    this.syncLoginState();
  },

  initNavBarInfo() {
    const systemInfo = wx.getSystemInfoSync();
    const menuButton = wx.getMenuButtonBoundingClientRect();
    const statusBarHeight = systemInfo.statusBarHeight || 44;
    // 标题行高度 = 胶囊上下对称留白 * 2 + 胶囊高度
    const contentHeight = menuButton.height + (menuButton.top - statusBarHeight) * 2;
    this.globalData.statusBarHeight = statusBarHeight;
    this.globalData.navBarContentHeight = contentHeight;
    this.globalData.navBarHeight = statusBarHeight + contentHeight;
  },

  restoreFromCache() {
    const userId = wx.getStorageSync('userId');
    const boundStoreId = wx.getStorageSync('boundStoreId');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    const boundMarketName = wx.getStorageSync('boundMarketName');
    if (userId) {
      this.globalData.userId = userId;
    }
    if (boundStoreId) {
      this.globalData.boundStoreId = boundStoreId;
    }
    if (boundStoreName) {
      this.globalData.boundStoreName = boundStoreName;
    }
    if (boundMarketName) {
      this.globalData.boundMarketName = boundMarketName;
    }
  },

  async syncLoginState() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: { action: 'auth.login', payload: {} }
      }) as any;
      if (res.result?.code === 0 && res.result.data) {
        const { userId, phone, boundStoreId, boundStoreName, boundMarketName } = res.result.data;
        if (userId) {
          this.globalData.userId = userId;
          wx.setStorageSync('userId', userId);
        }
        if (phone) {
          wx.setStorageSync('phone', phone);
        }
        // 同步服务器端绑定的门店（核心：即使本地缓存被清除也能恢复）
        if (boundStoreId) {
          this.globalData.boundStoreId = boundStoreId;
          wx.setStorageSync('boundStoreId', boundStoreId);
        }
        if (boundStoreName) {
          this.globalData.boundStoreName = boundStoreName;
          wx.setStorageSync('boundStoreName', boundStoreName);
        }
        // 同步市场名
        if (boundMarketName) {
          this.globalData.boundMarketName = boundMarketName;
          wx.setStorageSync('boundMarketName', boundMarketName);
        }
      }
    } catch (err) {
      console.error('[syncLoginState] failed:', err);
    }
  },

  setUserInfo(info: { userId: string; boundStoreId?: string; boundStoreName?: string }) {
    this.globalData.userId = info.userId;
    wx.setStorageSync('userId', info.userId);
    if (info.boundStoreId) {
      this.globalData.boundStoreId = info.boundStoreId;
      wx.setStorageSync('boundStoreId', info.boundStoreId);
    }
    if (info.boundStoreName) {
      this.globalData.boundStoreName = info.boundStoreName;
      wx.setStorageSync('boundStoreName', info.boundStoreName);
    }
  },

  setStore(storeId: string, storeName: string, marketName?: string) {
    this.globalData.boundStoreId = storeId;
    wx.setStorageSync('boundStoreId', storeId);
    this.globalData.boundStoreName = storeName;
    wx.setStorageSync('boundStoreName', storeName);
    if (marketName !== undefined) {
      this.globalData.boundMarketName = marketName;
      wx.setStorageSync('boundMarketName', marketName);
    }
  },
});
