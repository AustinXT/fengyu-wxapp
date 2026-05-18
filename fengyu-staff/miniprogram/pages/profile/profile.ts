// pages/profile/profile.ts — 我的
import { callStaffApi, toHttpUrl } from '../../utils/cloud';
import { bindPhone } from '../../utils/auth';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

Page({
  data: {
    staffName: '',
    position: '',
    staffWfId: '',
    phone: '',
    avatarUrl: '',
    avatarHttpUrl: '',
    boundStoreName: '',
    isManager: false,
    canSeeInventory: false,
    // 门店绑定
    showStorePicker: false,
    storeList: [] as Array<{ storeId: string; storeName: string }>,
    storeColumns: [] as string[],
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const { staffName, position, staffWfId, phone, boundStoreName, avatarUrl } = app.globalData;
    const roles = app.globalData.roles ?? [];
    const canSeeInventory = ['manager', 'admin', 'finance'].some(r => roles.includes(r));
    this.setData({
      staffName, position, staffWfId, phone, boundStoreName,
      avatarUrl: avatarUrl || '',
      avatarHttpUrl: avatarUrl ? toHttpUrl(avatarUrl) : '',
      isManager: isManager(),
      canSeeInventory,
    });
  },

  /**
   * 选图 + 调云函数上传（跨 env 写入 client env COS）
   * 复刻自 client `pagesProfile/profile-edit/profile-edit.ts` 同款套路
   */
  async onChooseAvatar() {
    if (!app.globalData.staffWfId) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
      const tempFilePath = res.tempFiles[0].tempFilePath;
      if (!tempFilePath) return;

      wx.showLoading({ title: '上传中...', mask: true });
      const ext = (tempFilePath.split('.').pop() || 'jpg').toLowerCase();

      // 小程序端直传 COS 默认被存储安全规则拦截，统一走云函数代理上传
      const base64 = await new Promise<string>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: tempFilePath,
          encoding: 'base64',
          success: (r) => resolve(r.data as string),
          fail: reject,
        });
      });

      const data = await callStaffApi<{ fileID: string; avatarUrl: string }>(
        'staff.uploadAvatar',
        { base64, ext },
      );
      const fileID = data?.fileID || '';
      // 同步 globalData + 当前 setData（HTTPS 用于渲染，cloud:// 持久化保留 protocol）
      app.setStaffInfo({ avatarUrl: fileID });
      this.setData({
        avatarUrl: fileID,
        avatarHttpUrl: fileID ? toHttpUrl(fileID) : '',
      });
      wx.hideLoading();
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('chooseMedia:fail cancel')) return;
      wx.showToast({ title: msg || '上传失败', icon: 'none' });
    }
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent) {
    if (!e.detail.cloudID) return
    try {
      await bindPhone(e.detail.cloudID)
      const { phone, staffWfId, staffName, position, boundStoreName, avatarUrl } = app.globalData
      this.setData({
        phone, staffWfId, staffName, position, boundStoreName,
        avatarUrl: avatarUrl || '',
        avatarHttpUrl: avatarUrl ? toHttpUrl(avatarUrl) : '',
        isManager: isManager(),
      })
      wx.showToast({ title: '绑定成功', icon: 'success' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '绑定失败';
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async onBindStore() {
    if (!this.data.storeList.length) {
      try {
        const data = await callStaffApi<Array<{ storeId: string; storeName: string }>>('store.list');
        this.setData({
          storeList: data || [],
          storeColumns: (data || []).map(s => s.storeName),
        });
      } catch (err: unknown) {
        wx.showToast({ title: '获取门店列表失败', icon: 'none' });
        return;
      }
    }
    this.setData({ showStorePicker: true });
  },

  onStorePickerClose() {
    this.setData({ showStorePicker: false });
  },

  async onStoreConfirm(e: WechatMiniprogram.CustomEvent) {
    const pickedName = e.detail.value as string;
    const store = this.data.storeList.find(s => s.storeName === pickedName);
    if (!store) return;
    this.setData({ showStorePicker: false });
    try {
      await callStaffApi('staff.bindStore', { storeId: store.storeId });
      app.setStaffInfo({ boundStoreName: store.storeName, boundStoreId: store.storeId });
      this.setData({ boundStoreName: store.storeName });
      wx.showToast({ title: '门店已切换', icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '切换失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  onNavOrders() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list' });
  },

  onNavServices() {
    wx.switchTab({ url: '/pages/service/service' });
  },

  onNavCustomers() {
    wx.switchTab({ url: '/pages/customer-list/customer-list' });
  },

  onNavDashboard() {
    wx.navigateTo({ url: '/packageOrder/dashboard/dashboard' });
  },

  onNavPerformance() {
    wx.navigateTo({ url: '/packageOrder/staff-performance/staff-performance' });
  },

  onNavAppointments() {
    wx.navigateTo({ url: '/packageService/appointment/appointment' });
  },

  onNavAllocationList() {
    wx.navigateTo({ url: '/packageOrder/allocation-list/allocation-list' });
  },

  onNavInventory() {
    wx.navigateTo({ url: '/packageMy/inventory/inventory' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      success: (res) => {
        if (res.confirm) {
          app.resetStaffInfo();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  },
});
