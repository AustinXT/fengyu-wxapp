// app.ts — 凤御客户端小程序
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
    // Ticket 2026-04-24 PR-C：多次回款"继续支付"灰度开关（默认开启；如需灰度下发可改为从 config 读）
    continuePayEnabled: true,
    // Ticket 2026-04-24 分享礼：从分享链接 query 捕获的邀请人 userId，绑定门店时一次性写入并清空
    pendingInviter: undefined,
  },

  onLaunch(options: WechatMiniprogram.App.LaunchShowOption) {
    wx.cloud.init({ env: getCloudEnv(), traceUser: true });
    // 解析分享礼 inv 参数（邀请人 userId）
    this.capturePendingInviter(options);
    // 计算导航栏高度（需在 UI 渲染前完成）
    this.initNavBarInfo();
    // 先从本地缓存恢复（快速展示）
    this.restoreFromCache();
    // 再从服务器同步最新数据（含 boundStoreName）
    this.syncLoginState();
  },

  onShow(options: WechatMiniprogram.App.LaunchShowOption) {
    // 用户后台返回或再次扫码分享链接时，重新捕获 inv
    this.capturePendingInviter(options);
  },

  /**
   * 从启动/显示参数解析分享礼邀请人 userId
   * - 仅接受字符串且以 'FYGK-' 开头（客户 userId 前缀）
   * - 已有值时不覆盖（保护第一次捕获的邀请人）
   */
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
    const statusBarHeight = windowInfo.statusBarHeight || 44;
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
      // 会员价分流缓存：统一经 setMemberFlag 写入（与后端 member-pricing isMember 同口径），
      // memberLevel/customerType 一并刷新（降级/退会时写空，清掉旧值）。任何拿到最新会员资料处复用本 helper。
      this.setMemberFlag(data);
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

  /**
   * 写入会员价分流标记 storage('isMember') + 顾客类型/等级缓存。
   * 会员判定口径须与后端 clientApi/utils/member-pricing.js isMember() 一致：
   * customerType === '会员客' 或 memberLevel 非空，任一满足即会员
   * （后端 auth.login 已返回权威 isMember，优先用之，缺省时按同口径回退计算）。
   * memberLevel/customerType 一并刷新（降级/退会时写空，清掉旧值）。
   * 任何拿到最新会员资料处都应调用本 helper：onLaunch.syncLoginState / 绑定门店后 / 个人中心 onShow。
   */
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

  /** 退出登录 / 账号失效时清除会员价分流标记，防止下一个账号沿用上一个账号的会员价划线。 */
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
