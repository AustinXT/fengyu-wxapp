// pages/workbench/workbench.ts — 工作台
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { buildCalendarDays, formatMonthLabel } from '../../utils/calendar';
import type { CalendarDay } from '../../utils/calendar';

const app = getApp<IAppOption>();

Page({
  data: {
    loading: false,
    storeName: '',
    staffName: '',
    position: '',
    isManager: false,
    today: '',
    // 今日分成
    todayCommission: '0.00',
    todayOrderCount: 0,
    todayServiceCount: 0,
    storeTodayRevenue: '0.00',
    // 本月累计
    monthlyCommission: '0.00',
    monthlyOrderCount: 0,
    monthlyServiceCount: 0,
    // 上月累计
    lastMonthCommission: '0.00',
    lastMonthOrderCount: 0,
    lastMonthServiceCount: 0,
    // 月度业绩日历
    currentMonth: '',
    monthLabel: '',
    calendarDays: [] as CalendarDay[],
    // 代办事项计数
    pendingAppointmentCount: 0,
    pendingServiceCount: 0,
    pendingOfflineOrderCount: 0,
    pendingCreateOrderCount: 0,
    pendingUnbindCount: 0,
    pendingAllocationCount: 0,
  },

  onLoad() {
    this.setTodayDate();
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.setData({
      currentMonth: ym,
      monthLabel: formatMonthLabel(ym),
    });
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const { staffName, position, boundStoreName } = app.globalData;
    this.setData({
      storeName: boundStoreName,
      staffName,
      position,
      isManager: isManager(),
    });
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
        this.loadMonthlyCalendar(),
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
        lastMonthAmount?: string;
        lastMonthOrderCount?: number;
        lastMonthServiceCount?: number;
      }>('staff.todayCommission');
      this.setData({
        todayCommission: data.todayAmount || '0.00',
        todayOrderCount: data.orderCount || 0,
        todayServiceCount: data.serviceCount || 0,
        storeTodayRevenue: data.storeTodayRevenue || '0.00',
        lastMonthCommission: data.lastMonthAmount || '0.00',
        lastMonthOrderCount: data.lastMonthOrderCount || 0,
        lastMonthServiceCount: data.lastMonthServiceCount || 0,
      });
    } catch (_) {}
  },

  async loadMonthlyCalendar() {
    try {
      const data = await callStaffApi<{
        dailyData: Array<{ date: string; amount: number }>;
        totalAmount: number;
        totalOrderCount?: number;
        totalServiceCount?: number;
      }>('staff.monthlyCalendar', { yearMonth: this.data.currentMonth });
      const days = buildCalendarDays(this.data.currentMonth, data.dailyData || []);
      const monthlyCommission = data.totalAmount > 0
        ? data.totalAmount.toFixed(2)
        : '0.00';
      this.setData({
        calendarDays: days,
        monthlyCommission,
        monthlyOrderCount: data.totalOrderCount || 0,
        monthlyServiceCount: data.totalServiceCount || 0,
      });
    } catch (_) {
      const days = buildCalendarDays(this.data.currentMonth, []);
      this.setData({ calendarDays: days });
    }
  },

  onPrevMonth() {
    const [y, m] = this.data.currentMonth.split('-').map(Number);
    let ny = y, nm = m - 1;
    if (nm < 1) { ny -= 1; nm = 12; }
    const ym = `${ny}-${String(nm).padStart(2, '0')}`;
    this.setData({ currentMonth: ym, monthLabel: formatMonthLabel(ym) });
    this.loadMonthlyCalendar();
  },

  onNextMonth() {
    const [y, m] = this.data.currentMonth.split('-').map(Number);
    const now = new Date();
    const curY = now.getFullYear(), curM = now.getMonth() + 1;
    if (y > curY || (y === curY && m >= curM)) return;
    let ny = y, nm = m + 1;
    if (nm > 12) { ny += 1; nm = 1; }
    const ym = `${ny}-${String(nm).padStart(2, '0')}`;
    this.setData({ currentMonth: ym, monthLabel: formatMonthLabel(ym) });
    this.loadMonthlyCalendar();
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
      }>('staff.todoList');
      this.setData({
        pendingAppointmentCount: data.pendingAppointmentCount || 0,
        pendingServiceCount: data.pendingServiceCount || 0,
        pendingOfflineOrderCount: data.pendingOfflineOrderCount || 0,
        pendingCreateOrderCount: data.pendingCreateOrderCount || 0,
        pendingUnbindCount: data.pendingUnbindCount || 0,
        pendingAllocationCount: data.pendingAllocationCount || 0,
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

  goOrderListOffline() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list?status=pendingOffline' });
  },

  goOrderListCreate() {
    wx.navigateTo({ url: '/packageOrder/order-list/order-list?status=pendingCreate' });
  },

  goUnbindRequests() {
    wx.navigateTo({ url: '/packageService/unbind-requests/unbind-requests' });
  },

  goAllocationList() {
    wx.navigateTo({ url: '/packageOrder/allocation-list/allocation-list' });
  },

  goPerformance(e: WechatMiniprogram.TouchEvent) {
    const range = e.currentTarget.dataset.range || 'today';
    wx.navigateTo({ url: `/packageOrder/staff-performance/staff-performance?range=${range}` });
  },

  goCustomerList() {
    wx.switchTab({ url: '/pages/customer-list/customer-list' });
  },
});
