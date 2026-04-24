// app.ts — 凤御客户端小程序
import { callClientApi } from './utils/cloud';

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
    // Ticket 2026-04-24 PR-C：多次回款"继续支付"灰度开关（默认开启；如需灰度下发可改为从 config 读）
    continuePayEnabled: true,
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
      const data = await callClientApi<{
        userId: string; phone: string; name: string; avatarUrl: string;
        memberLevel: string; boundStoreId: string; boundStoreName: string; boundMarketName: string;
      }>('auth.login', {});
      if (data.userId) {
        this.globalData.userId = data.userId;
        wx.setStorageSync('userId', data.userId);
      }
      if (data.phone) {
        wx.setStorageSync('phone', data.phone);
      }
      if (data.name) {
        wx.setStorageSync('userName', data.name);
      }
      if (data.avatarUrl) {
        wx.setStorageSync('avatarUrl', data.avatarUrl);
      }
      if (data.memberLevel) {
        wx.setStorageSync('memberLevel', data.memberLevel);
      }
      // 同步服务器端绑定的门店（双向同步：绑定和解绑都要同步）
      this.globalData.boundStoreId = data.boundStoreId || '';
      wx.setStorageSync('boundStoreId', data.boundStoreId || '');
      this.globalData.boundStoreName = data.boundStoreName || '';
      wx.setStorageSync('boundStoreName', data.boundStoreName || '');
      this.globalData.boundMarketName = data.boundMarketName || '';
      wx.setStorageSync('boundMarketName', data.boundMarketName || '');
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
