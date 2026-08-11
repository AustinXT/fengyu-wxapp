// pages/workbench/workbench.ts — 工作台
import { callStaffApi } from '../../utils/cloud';
import { isManagementMode, isManager, requireManager } from '../../utils/role';
import { emit, on, EVENT_STORE_CHANGED } from '../../utils/event-bus';

const app = getApp<IAppOption>();

Page({
  data: {
    loading: false,
    storeName: '',
    staffName: '',
    position: '',
    isManager: false,
    currentStoreId: '',
    scopedStores: [] as ScopedStore[],
    hasMultiStore: false,
    storePickerVisible: false,
    storePickerActions: [] as Array<{ name: string; storeId: string; color?: string }>,
    today: '',
    // 今日分成
    todayCommission: '0.00',
    todayOrderCount: 0,
    todayServiceCount: 0,
    storeTodayRevenue: '0.00',
    // 本月累计（首卡：个人分成口径）
    monthlyCommission: '0.00',
    monthlyOrderCount: 0,
    monthlyServiceCount: 0,
    // 上月累计
    lastMonthCommission: '0.00',
    lastMonthOrderCount: 0,
    lastMonthServiceCount: 0,
    // 代办事项计数
    pendingAppointmentCount: 0,
    pendingServiceCount: 0,
    pendingOfflineOrderCount: 0,
    pendingCreateOrderCount: 0,
    pendingOrderCount: 0, // 订单管理磁贴红点：线下收款 + 确认订单 之和
    pendingUnbindCount: 0,
    pendingAllocationCount: 0,
    pendingRefundCount: 0,
    statusBarHeight: 0,
    navBarHeight: 0,
    contentHeight: 0,
    logoHeight: 0,
  },

  onLoad() {
    if (isManagementMode()) {
      wx.reLaunch({ url: '/pages/mgmt-dashboard/mgmt-dashboard' });
      return;
    }
    this.initNavBar();
    this.setTodayDate();
  },

  // 折叠屏展开/折叠、屏幕旋转时重算自定义导航栏高度（onLoad 只算一次，尺寸变化后 logo 会错位/掉下来）
  // nextTick：避开 getMenuButtonBoundingClientRect 同步返回 resize 前（折叠态）旧值的坑
  onResize() {
    wx.nextTick(() => this.initNavBar());
  },

  // 计算自定义导航栏高度（状态栏 + 胶囊按钮区），供顶部 logo 导航栏使用
  initNavBar() {
    try {
      const menu = wx.getMenuButtonBoundingClientRect();
      const { statusBarHeight = 44 } = wx.getWindowInfo(); // 解构默认值（仅 undefined 替换）等价 ??；折叠态 statusBarHeight 合法为 0，勿用 || 44
      const contentHeight = menu.height + (menu.top - statusBarHeight) * 2; // 对齐微信原生导航栏内容高度（胶囊垂直居中），与其他 Tab 顶栏一致
      this.setData({
        statusBarHeight,
        contentHeight,
        navBarHeight: statusBarHeight + contentHeight,
        logoHeight: Math.round(menu.height * 0.8), // logo 跟胶囊高度，多端一致（rpx 在 iPad/折叠屏宽屏会放大，改 px 按胶囊比例）
      });
    } catch (e) {
      console.warn('[workbench] initNavBar 失败，使用兜底高度', e);
      this.setData({ statusBarHeight: 44, contentHeight: 44, navBarHeight: 88, logoHeight: 26 });
    }
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    if (isManagementMode()) {
      wx.reLaunch({ url: '/pages/mgmt-dashboard/mgmt-dashboard' });
      return;
    }
    this.syncStoreContext();
    this.loadWorkbench();
  },

  onReady() {
    // 订阅门店切换事件（其他 tab 切换门店时刷新）
    this._unsubscribeStoreChange = on(EVENT_STORE_CHANGED, () => {
      this.syncStoreContext();
      this.loadWorkbench();
    });
  },

  onUnload() {
    if (this._unsubscribeStoreChange) this._unsubscribeStoreChange();
  },

  _unsubscribeStoreChange: null as (() => void) | null,

  syncStoreContext() {
    const { staffName, position, scopedStores, currentStoreId, boundStoreName } = app.globalData;
    const current = scopedStores.find((s) => s.storeId === currentStoreId);
    const displayName = current?.storeName || boundStoreName;
    this.setData({
      storeName: displayName || '',
      staffName: staffName || '',
      position: position || '',
      isManager: isManager(),
      currentStoreId: currentStoreId || '',
      scopedStores: scopedStores || [],
      hasMultiStore: (scopedStores || []).length > 1,
    });
  },

  openStorePicker() {
    if (!this.data.hasMultiStore) return;
    const actions = (this.data.scopedStores || []).map((s) => ({
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
    this.loadWorkbench();
  },

  onPullDownRefresh() {
    this.loadWorkbench().finally(() => wx.stopPullDownRefresh());
  },

  setTodayDate() {
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    this.setData({ today: `${m}月${d}日` });
  },

  async loadWorkbench() {
    if (isManagementMode()) return;
    this.setData({ loading: true });
    // 超时保护：10 秒后自动关闭 loading
    const timer = setTimeout(() => {
      if (this.data.loading) {
        this.setData({ loading: false });
        console.warn('[workbench] loading timeout, force reset');
      }
    }, 10000);
    try {
      await Promise.all([
        this.loadTodayCommission(),
        this.loadTodoSummary(),
      ]);
    } catch (err) {
      console.error('[workbench] error:', err);
      wx.showToast({ title: '加载失败，请下拉刷新', icon: 'none' });
    } finally {
      clearTimeout(timer);
      this.setData({ loading: false });
    }
  },

  async loadTodayCommission() {
    try {
      const data = await callStaffApi<{
        todayAmount: string;
        orderCount: number;
        serviceCount: number;
        storeTodayRevenue?: string;
        thisMonthAmount?: string;
        thisMonthOrderCount?: number;
        thisMonthServiceCount?: number;
        lastMonthAmount?: string;
        lastMonthOrderCount?: number;
        lastMonthServiceCount?: number;
      }>('staff.todayCommission');
      this.setData({
        todayCommission: data.todayAmount || '0.00',
        todayOrderCount: data.orderCount || 0,
        todayServiceCount: data.serviceCount || 0,
        storeTodayRevenue: data.storeTodayRevenue || '0.00',
        monthlyCommission: data.thisMonthAmount || '0.00',
        monthlyOrderCount: data.thisMonthOrderCount || 0,
        monthlyServiceCount: data.thisMonthServiceCount || 0,
        lastMonthCommission: data.lastMonthAmount || '0.00',
        lastMonthOrderCount: data.lastMonthOrderCount || 0,
        lastMonthServiceCount: data.lastMonthServiceCount || 0,
      });
    } catch (_) {}
  },

  async loadTodoSummary() {
    try {
      const data = await callStaffApi<{
        pendingAppointmentCount: number;
        pendingServiceCount: number;
        pendingOfflineOrderCount?: number;
        pendingCreateOrderCount?: number;
        pendingUnbindCount?: number;
        pendingAllocationCount?: number;
        pendingRefundCount?: number;
      }>('staff.todoList');
      this.setData({
        pendingAppointmentCount: data.pendingAppointmentCount || 0,
        pendingServiceCount: data.pendingServiceCount || 0,
        pendingOfflineOrderCount: data.pendingOfflineOrderCount || 0,
        pendingCreateOrderCount: data.pendingCreateOrderCount || 0,
        pendingOrderCount: (data.pendingOfflineOrderCount || 0) + (data.pendingCreateOrderCount || 0),
        pendingUnbindCount: data.pendingUnbindCount || 0,
        pendingAllocationCount: data.pendingAllocationCount || 0,
        pendingRefundCount: data.pendingRefundCount || 0,
      });
    } catch (_) {}
  },

  onRefresh() {
    this.loadWorkbench();
  },

  goAppointments() {
    wx.navigateTo({ url: '/packageService/appointment/appointment?tab=pending' });
  },

  goServiceList() {
    wx.switchTab({ url: '/pages/service/service' });
  },

  // ===== 常用功能入口 =====
  goOrders() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list' });
  },

  goAppointmentList() {
    wx.navigateTo({ url: '/packageService/appointment/appointment' });
  },

  goInventory() {
    if (!requireManager()) return;
    wx.navigateTo({ url: '/packageMy/inventory/inventory' });
  },

  goPickup() {
    if (!requireManager()) return;
    wx.navigateTo({ url: '/packageMy/pickup/pickup-by-customer' });
  },

  goOrderListOffline() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list?status=pendingOffline' });
  },

  goOrderListCreate() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list?status=pendingCreate' });
  },

  goUnbindRequests() {
    if (!requireManager()) return;
    wx.navigateTo({ url: '/packageService/unbind-requests/unbind-requests' });
  },

  goAllocationList() {
    if (!requireManager()) return;
    wx.navigateTo({ url: '/packageOrder/allocation-list/allocation-list' });
  },

  goRefundList() {
    if (!requireManager()) return;
    wx.navigateTo({ url: '/packageOrder/refund-list/refund-list' });
  },

  goPerformance(e: WechatMiniprogram.TouchEvent) {
    const range = e.currentTarget.dataset.range || 'today';
    wx.navigateTo({ url: `/packageOrder/staff-performance/staff-performance?range=${range}` });
  },
});
