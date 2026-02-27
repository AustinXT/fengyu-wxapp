// app.ts — 凤御员工端小程序
App<IAppOption>({
  globalData: {
    userId: '' as string,
    staffWfId: '' as string,
    staffName: '' as string,
    role: '' as 'manager' | 'beautician' | '',
    boundStoreName: '' as string,
    boundStoreId: '' as string,
    phone: '' as string,
  },

  onLaunch() {
    wx.cloud.init({ traceUser: true });
    this.restoreFromCache();
    this.syncLoginState();
  },

  restoreFromCache() {
    const userId = wx.getStorageSync('userId');
    const staffWfId = wx.getStorageSync('staffWfId');
    const staffName = wx.getStorageSync('staffName');
    const role = wx.getStorageSync('role');
    const phone = wx.getStorageSync('phone');
    const boundStoreName = wx.getStorageSync('boundStoreName');
    const boundStoreId = wx.getStorageSync('boundStoreId');
    if (userId) this.globalData.userId = userId;
    if (staffWfId) this.globalData.staffWfId = staffWfId;
    if (staffName) this.globalData.staffName = staffName;
    if (role) this.globalData.role = role;
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
        const { userId, staffWfId, staffName, role, phone, boundStoreName, boundStoreId } = res.result.data;
        this.setStaffInfo({ userId, staffWfId, staffName, role, phone, boundStoreName, boundStoreId });
      }
    } catch (err) {
      console.error('[syncLoginState] failed:', err);
    }
  },

  setStaffInfo(info: {
    userId?: string;
    staffWfId?: string;
    staffName?: string;
    role?: 'manager' | 'beautician' | '';
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
  }) {
    if (info.userId) {
      this.globalData.userId = info.userId;
      wx.setStorageSync('userId', info.userId);
    }
    if (info.staffWfId) {
      this.globalData.staffWfId = info.staffWfId;
      wx.setStorageSync('staffWfId', info.staffWfId);
    }
    if (info.staffName) {
      this.globalData.staffName = info.staffName;
      wx.setStorageSync('staffName', info.staffName);
    }
    if (info.role) {
      this.globalData.role = info.role;
      wx.setStorageSync('role', info.role);
    }
    if (info.phone) {
      this.globalData.phone = info.phone;
      wx.setStorageSync('phone', info.phone);
    }
    if (info.boundStoreName) {
      this.globalData.boundStoreName = info.boundStoreName;
      wx.setStorageSync('boundStoreName', info.boundStoreName);
    }
    if (info.boundStoreId) {
      this.globalData.boundStoreId = info.boundStoreId;
      wx.setStorageSync('boundStoreId', info.boundStoreId);
    }
  },
});
