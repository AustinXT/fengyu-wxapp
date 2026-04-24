// app.ts — 凤御员工端小程序
import { MOCK_ENABLED } from './utils/dev-config'

App<IAppOption>({
  globalData: {
    staffWfId: '' as string,
    staffName: '' as string,
    position: '' as string,
    roles: [] as string[],
    skills: [] as string[], // P2-14：技能标签，用于业绩分配角色推断
    boundStoreName: '' as string,
    boundStoreId: '' as string,
    phone: '' as string,
    staffLevel: null as StaffLevel,
    roleBindings: [] as RoleBinding[],
    availableLoginLevels: [] as LoginLevel[],
    scopedStores: [] as ScopedStore[],
    loginLevel: null as LoginLevel | null,
    currentStoreId: '' as string,
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
        skills: ['美容师'],
        phone: '13800000001',
        boundStoreName: '南商市场·凤御旗舰店',
        boundStoreId: 'store-001',
        staffLevel: 'store_manager',
        roleBindings: [
          { role: 'manager', scopeId: 'org-node-store-001', scopeType: '门店' },
        ],
        availableLoginLevels: ['store'],
        scopedStores: [{ storeId: 'store-001', storeName: '南商市场·凤御旗舰店' }],
      });
      this.setLoginLevel('store');
      this.setCurrentStoreId('store-001');
      console.log('[Mock] 使用模拟员工数据，跳过 auth.login');
      this._loginReady = Promise.resolve();
      return;
    }
    this._loginReady = this.syncLoginState();
  },

  restoreFromCache() {
    const staffWfId = wx.getStorageSync('staffWfId');
    const staffName = wx.getStorageSync('staffName');
    const position = wx.getStorageSync('position');
    const roles = wx.getStorageSync('roles');
    const skills = wx.getStorageSync('skills');
    const phone = wx.getStorageSync('phone');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    const boundStoreId = wx.getStorageSync('boundStoreId');
    const staffLevel = wx.getStorageSync('staffLevel');
    const roleBindings = wx.getStorageSync('roleBindings');
    const availableLoginLevels = wx.getStorageSync('availableLoginLevels');
    const scopedStores = wx.getStorageSync('scopedStores');
    const loginLevel = wx.getStorageSync('loginLevel');
    const currentStoreId = wx.getStorageSync('currentStoreId');
    if (staffWfId) this.globalData.staffWfId = staffWfId;
    if (staffName) this.globalData.staffName = staffName;
    if (position) this.globalData.position = position;
    if (roles) this.globalData.roles = roles;
    if (skills) this.globalData.skills = skills;
    if (phone) this.globalData.phone = phone;
    if (boundStoreName) this.globalData.boundStoreName = boundStoreName;
    if (boundStoreId) this.globalData.boundStoreId = boundStoreId;
    if (staffLevel) this.globalData.staffLevel = staffLevel;
    if (roleBindings) this.globalData.roleBindings = roleBindings;
    if (availableLoginLevels) this.globalData.availableLoginLevels = availableLoginLevels;
    if (scopedStores) this.globalData.scopedStores = scopedStores;
    if (loginLevel) this.globalData.loginLevel = loginLevel;
    if (currentStoreId) this.globalData.currentStoreId = currentStoreId;
  },

  async syncLoginState() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'staffApi',
        data: { action: 'auth.login', payload: {} }
      }) as any;
      if (res.result?.code === 0 && res.result.data) {
        const {
          staffWfId, staffName, position, roles, skills, phone,
          boundStoreName, boundStoreId,
          staffLevel, roleBindings, availableLoginLevels, scopedStores,
        } = res.result.data;
        this.setStaffInfo({
          staffWfId, staffName, position, roles, skills, phone,
          boundStoreName, boundStoreId,
          staffLevel, roleBindings, availableLoginLevels, scopedStores,
        });
        // loginLevel 若本地已有且在 available 内则保留，否则 fallback available[0]
        const existingLogin = this.globalData.loginLevel;
        const levels = (availableLoginLevels || []) as LoginLevel[];
        if (existingLogin && levels.includes(existingLogin)) {
          // 保留用户选择
        } else if (levels.length > 0) {
          this.setLoginLevel(levels[0]);
        }
        // currentStoreId：若本地已有且在 scope 内保留，否则取第一个
        const scoped = (scopedStores || []) as ScopedStore[];
        const cur = this.globalData.currentStoreId;
        const inScope = !!cur && scoped.some((s) => s.storeId === cur);
        if (!inScope && scoped.length > 0) {
          this.setCurrentStoreId(scoped[0].storeId);
        }
      }
    } catch (err) {
      console.error('[syncLoginState] failed:', err);
    }
  },

  setStaffInfo(info) {
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
    if (info.skills) {
      this.globalData.skills = info.skills;
      wx.setStorageSync('skills', info.skills);
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
    if ('staffLevel' in info) {
      this.globalData.staffLevel = info.staffLevel ?? null;
      wx.setStorageSync('staffLevel', info.staffLevel ?? '');
    }
    if (info.roleBindings) {
      this.globalData.roleBindings = info.roleBindings;
      wx.setStorageSync('roleBindings', info.roleBindings);
    }
    if (info.availableLoginLevels) {
      this.globalData.availableLoginLevels = info.availableLoginLevels;
      wx.setStorageSync('availableLoginLevels', info.availableLoginLevels);
    }
    if (info.scopedStores) {
      this.globalData.scopedStores = info.scopedStores;
      wx.setStorageSync('scopedStores', info.scopedStores);
    }
  },

  setLoginLevel(level) {
    this.globalData.loginLevel = level;
    wx.setStorageSync('loginLevel', level);
  },

  setCurrentStoreId(storeId) {
    this.globalData.currentStoreId = storeId || '';
    wx.setStorageSync('currentStoreId', storeId || '');
  },

  resetStaffInfo() {
    this.globalData.staffWfId = '';
    this.globalData.staffName = '';
    this.globalData.position = '';
    this.globalData.roles = [];
    this.globalData.skills = [];
    this.globalData.phone = '';
    this.globalData.boundStoreName = '';
    this.globalData.boundStoreId = '';
    this.globalData.staffLevel = null;
    this.globalData.roleBindings = [];
    this.globalData.availableLoginLevels = [];
    this.globalData.scopedStores = [];
    this.globalData.loginLevel = null;
    this.globalData.currentStoreId = '';
    // 清除临时页面状态
    (this.globalData as any).pendingCartItem = null;
    (this.globalData as any)._serviceCreatePreload = null;
    wx.clearStorageSync();
  },
});
