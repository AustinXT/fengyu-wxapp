// pages/profile/profile.ts — 我的
import { callStaffApi, toHttpUrl } from '../../utils/cloud';
import { bindPhone } from '../../utils/auth';
import { isManager, hasRole } from '../../utils/role';
import { emit, on, EVENT_STORE_CHANGED } from '../../utils/event-bus';

type ScopedStore = { storeId: string; storeName: string };

const app = getApp<IAppOption>();

Page({
  data: {
    staffName: '',
    position: '',
    staffWfId: '',
    phone: '',
    avatarUrl: '',
    avatarHttpUrl: '',
    isManager: false,
    canSeeInventory: false,
    // scope 范围内门店切换（与 workbench 一致语义）
    currentStoreName: '',
    currentStoreId: '',
    scopedStores: [] as ScopedStore[],
    hasMultiStore: false,
    storePickerVisible: false,
    storePickerActions: [] as Array<{ name: string; storeId: string; color?: string }>,
  },

  _unsubscribeStoreChange: null as (() => void) | null,

  onLoad() {
    this._unsubscribeStoreChange = on(EVENT_STORE_CHANGED, () => {
      this.syncStoreContext();
    });
  },

  onUnload() {
    if (this._unsubscribeStoreChange) this._unsubscribeStoreChange();
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const { staffName, position, staffWfId, phone, avatarUrl } = app.globalData;
    const canSeeInventory = hasRole('manager', 'admin', 'finance');
    this.setData({
      staffName, position, staffWfId, phone,
      avatarUrl: avatarUrl || '',
      avatarHttpUrl: avatarUrl ? toHttpUrl(avatarUrl) : '',
      isManager: isManager(),
      canSeeInventory,
    });
    this.syncStoreContext();
  },

  syncStoreContext() {
    const { scopedStores, currentStoreId, boundStoreName } = app.globalData;
    const scoped = (scopedStores || []) as ScopedStore[];
    const current = scoped.find((s) => s.storeId === currentStoreId);
    const displayName = current?.storeName || boundStoreName || '';
    this.setData({
      currentStoreName: displayName,
      currentStoreId: currentStoreId || '',
      scopedStores: scoped,
      hasMultiStore: scoped.length > 1,
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
      const { phone, staffWfId, staffName, position, avatarUrl } = app.globalData
      this.setData({
        phone, staffWfId, staffName, position,
        avatarUrl: avatarUrl || '',
        avatarHttpUrl: avatarUrl ? toHttpUrl(avatarUrl) : '',
        isManager: isManager(),
      })
      this.syncStoreContext();
      wx.showToast({ title: '绑定成功', icon: 'success' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '绑定失败';
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  openStorePicker() {
    if (!this.data.hasMultiStore) return;
    const actions = this.data.scopedStores.map((s) => ({
      name: s.storeName,
      storeId: s.storeId,
      color: s.storeId === this.data.currentStoreId ? '#C0322A' : '',
    }));
    this.setData({ storePickerVisible: true, storePickerActions: actions });
  },

  onStorePickerClose() {
    this.setData({ storePickerVisible: false });
  },

  onStorePickerSelect(e: WechatMiniprogram.CustomEvent<{ storeId: string; name: string }>) {
    const { storeId } = e.detail || ({} as any);
    this.setData({ storePickerVisible: false });
    if (!storeId || storeId === this.data.currentStoreId) return;
    app.setCurrentStoreId(storeId);
    this.syncStoreContext();
    emit(EVENT_STORE_CHANGED, storeId);
    wx.showToast({ title: '已切换门店', icon: 'success' });
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

  onNavPickup() {
    wx.navigateTo({ url: '/packageMy/pickup/pickup-by-customer' });
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
