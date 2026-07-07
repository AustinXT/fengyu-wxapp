
import { callClientApi } from './utils/cloud';
import { getCloudEnv } from './utils/cloud-env';

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
    logoHeight: 26,
    
    continuePayEnabled: true,
    
    pendingInviter: undefined,
  },

  onLaunch(options: WechatMiniprogram.App.LaunchShowOption) {
    wx.cloud.init({ env: getCloudEnv(), traceUser: true });
    
    this.capturePendingInviter(options);
    
    this.initNavBarInfo();
    
    this.restoreFromCache();
    
    this.syncLoginState();
  },

  onShow(options: WechatMiniprogram.App.LaunchShowOption) {
    
    this.capturePendingInviter(options);
  },

  
  capturePendingInviter(options: WechatMiniprogram.App.LaunchShowOption) {
    const raw = options?.query?.inv;
    if (typeof raw !== 'string') return;
    if (!raw.startsWith('FYGK-')) return;
    if (this.globalData.pendingInviter) return;
    this.globalData.pendingInviter = raw;
    wx.setStorageSync('pendingInviter', raw);
  },

  initNavBarInfo() {
    const windowInfo = wx.getWindowInfo();
    const menuButton = wx.getMenuButtonBoundingClientRect();
    const statusBarHeight = windowInfo.statusBarHeight ?? 44; 
    
    const contentHeight = menuButton.height + (menuButton.top - statusBarHeight) * 2;
    this.globalData.statusBarHeight = statusBarHeight;
    this.globalData.navBarContentHeight = contentHeight;
    this.globalData.navBarHeight = statusBarHeight + contentHeight;
    this.globalData.logoHeight = Math.round(menuButton.height * 0.8); 
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
    const cachedInviter = wx.getStorageSync('pendingInviter');
    if (!this.globalData.pendingInviter && cachedInviter) {
      this.globalData.pendingInviter = cachedInviter as string;
    }
  },

  async syncLoginState() {
    try {
      const data = await callClientApi<{
        userId: string; phone: string; name: string; avatarUrl: string;
        memberLevel: string; customerType?: string; isMember?: boolean;
        boundStoreId: string; boundStoreName: string; boundMarketName: string;
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
      
      
      this.setMemberFlag(data);
      
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

  
  setMemberFlag(profile: { isMember?: boolean; customerType?: string | null; memberLevel?: string | null }) {
    const customerType = profile.customerType || '';
    const memberLevel = profile.memberLevel || '';
    const isMember = typeof profile.isMember === 'boolean'
      ? profile.isMember
      : customerType === '会员客' || memberLevel !== '';
    wx.setStorageSync('isMember', isMember);
    wx.setStorageSync('customerType', customerType);
    wx.setStorageSync('memberLevel', memberLevel);
  },

  
  clearMemberFlag() {
    wx.removeStorageSync('isMember');
    wx.removeStorageSync('customerType');
    wx.removeStorageSync('memberLevel');
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
