// app.ts — 凤御员工端小程序
import { MOCK_ENABLED } from './utils/dev-config'

App<IAppOption>({
  globalData: {
    staffWfId: '' as string,
    staffName: '' as string,
    position: '' as string,
    roles: [] as string[],
    boundStoreName: '' as string,
    boundStoreId: '' as string,
    phone: '' as string,
  },

  _loginReady: undefined as unknown as Promise<void>,

  onLaunch() {
    wx.cloud.init({ traceUser: true });
    this.restoreFromCache();
    if (MOCK_ENABLED) {
      // Mock 模式：使用模拟用户数据，跳过真实 auth.login
      this.setStaffInfo({
        staffWfId: 'WF-00001',
        staffName: '王店长',
        position: '门店经理',
        roles: ['manager'],
        phone: '13800000001',
        boundStoreName: '南商市场·凤御旗舰店',
        boundStoreId: 'store-001',
      });
      console.log('[Mock] 使用模拟员工数据，跳过 auth.login');
      this._loginReady = Promise.resolve();
      return;
    }
    this._loginReady = this.syncLoginState();
  },

  restoreFromCache() {
    const staffWfId = wx.getStorageSync('staffWfId');
    const staffName = wx.getStorageSync('staffName');
    const role = wx.getStorageSync('role');
    const position = wx.getStorageSync('position');
    const roles = wx.getStorageSync('roles');
    const phone = wx.getStorageSync('phone');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    const boundStoreId = wx.getStorageSync('boundStoreId');
    if (staffWfId) this.globalData.staffWfId = staffWfId;
    if (staffName) this.globalData.staffName = staffName;
    if (role) this.globalData.position = role; // 兼容旧缓存
    if (position) this.globalData.position = position;
    if (roles) this.globalData.roles = roles;
    if (phone) this.globalData.phone = phone;
    if (boundStoreName) this.globalData.boundStoreName = boundStoreName;
    if (boundStoreId) this.globalData.boundStoreId = boundStoreId;
  },

  async syncLoginState() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'staffApi',
        data: { action: 'auth.login', payload: {} }
      }) as any;
      if (res.result?.code === 0 && res.result.data) {
        const { staffWfId, staffName, position, roles, phone, boundStoreName, boundStoreId } = res.result.data;
        this.setStaffInfo({ staffWfId, staffName, position, roles, phone, boundStoreName, boundStoreId });
      }
    } catch (err) {
      console.error('[syncLoginState] failed:', err);
    }
  },

  setStaffInfo(info: {
    staffWfId?: string;
    staffName?: string;
    position?: string;
    roles?: string[];
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
  }) {
    if (info.staffWfId) {
      this.globalData.staffWfId = info.staffWfId;
      wx.setStorageSync('staffWfId', info.staffWfId);
    }
    if (info.staffName) {
      this.globalData.staffName = info.staffName;
      wx.setStorageSync('staffName', info.staffName);
    }
    if (info.position) {
      this.globalData.position = info.position;
      wx.setStorageSync('position', info.position);
    }
    if (info.roles) {
      this.globalData.roles = info.roles;
      wx.setStorageSync('roles', info.roles);
    }
    if (info.phone) {
      this.globalData.phone = info.phone;
      wx.setStorageSync('phone', info.phone);
    }
    // 门店信息允许清空（解绑时为 null/空）
    if ('boundStoreName' in info) {
      this.globalData.boundStoreName = info.boundStoreName || '';
      wx.setStorageSync('boundStoreName', info.boundStoreName || '');
    }
    if ('boundStoreId' in info) {
      this.globalData.boundStoreId = info.boundStoreId || '';
      wx.setStorageSync('boundStoreId', info.boundStoreId || '');
    }
  },

  resetStaffInfo() {
    this.globalData.staffWfId = '';
    this.globalData.staffName = '';
    this.globalData.position = '';
    this.globalData.roles = [];
    this.globalData.phone = '';
    this.globalData.boundStoreName = '';
    this.globalData.boundStoreId = '';
    // 清除临时页面状态
    (this.globalData as any).pendingCartItem = null;
    (this.globalData as any)._serviceCreatePreload = null;
    wx.clearStorageSync();
  },
});
