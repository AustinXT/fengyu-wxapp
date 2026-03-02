// pages/workbench/workbench.ts — 工作台
import { callStaffApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface CalendarDay {
  day: number;
  date: string;
  hasData: boolean;
  amountLabel: string;
  isToday: boolean;
  isEmpty: boolean;
}

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
    // 顾客搜索
    searchKeyword: '',
    customerResults: [] as Array<{
      id: string;
      name: string;
      phone: string;
      phoneMasked: string;
    }>,
  },

  onLoad() {
    this.setTodayDate();
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.setData({
      currentMonth: ym,
      monthLabel: this.formatMonthLabel(ym),
    });
  },

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const { staffName, position, boundStoreName } = app.globalData;
    const isManager = position === '门店经理';
    this.setData({
      storeName: boundStoreName,
      staffName,
      position,
      isManager,
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

  formatMonthLabel(ym: string): string {
    const [y, m] = ym.split('-');
    return `${y}年${parseInt(m)}月`;
  },

  async loadWorkbench() {
    this.setData({ loading: true });
    try {
      await Promise.all([
        this.loadTodayCommission(),
        this.loadMonthlyCalendar(),
        this.loadTodoSummary(),
      ]);
    } catch (err) {
      console.error('[workbench] error:', err);
    } finally {
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
      }>('staff.todayCommission');
      this.setData({
        todayCommission: data.todayAmount || '0.00',
        todayOrderCount: data.orderCount || 0,
        todayServiceCount: data.serviceCount || 0,
        storeTodayRevenue: data.storeTodayRevenue || '0.00',
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
      const days = this.buildCalendarDays(this.data.currentMonth, data.dailyData || []);
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
      const days = this.buildCalendarDays(this.data.currentMonth, []);
      this.setData({ calendarDays: days });
    }
  },

  buildCalendarDays(yearMonth: string, dailyData: Array<{ date: string; amount: number }>): CalendarDay[] {
    const [y, m] = yearMonth.split('-').map(Number);
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const firstDow = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const dataMap: Record<string, number> = {};
    dailyData.forEach(d => { dataMap[d.date] = d.amount; });

    const days: CalendarDay[] = [];
    for (let i = 0; i < firstDow; i++) {
      days.push({ isEmpty: true, day: 0, date: '', hasData: false, amountLabel: '', isToday: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const amount = dataMap[dateStr] || 0;
      let amountLabel = '';
      if (amount > 0) {
        amountLabel = amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : String(amount);
      }
      days.push({
        isEmpty: false,
        day: d,
        date: dateStr,
        hasData: amount > 0,
        amountLabel,
        isToday: dateStr === todayStr,
      });
    }
    return days;
  },

  onPrevMonth() {
    const [y, m] = this.data.currentMonth.split('-').map(Number);
    let ny = y, nm = m - 1;
    if (nm < 1) { ny -= 1; nm = 12; }
    const ym = `${ny}-${String(nm).padStart(2, '0')}`;
    this.setData({ currentMonth: ym, monthLabel: this.formatMonthLabel(ym) });
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
    this.setData({ currentMonth: ym, monthLabel: this.formatMonthLabel(ym) });
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
      }>('staff.todoList');
      this.setData({
        pendingAppointmentCount: data.pendingAppointmentCount || 0,
        pendingServiceCount: data.pendingServiceCount || 0,
        pendingOfflineOrderCount: data.pendingOfflineOrderCount || 0,
        pendingCreateOrderCount: data.pendingCreateOrderCount || 0,
        pendingUnbindCount: data.pendingUnbindCount || 0,
      });
    } catch (_) {}
  },

  onRefresh() {
    this.loadWorkbench();
  },

  goAppointments() {
    wx.navigateTo({ url: '/pages/appointment/appointment?tab=pending' });
  },

  goServiceList() {
    wx.switchTab({ url: '/pages/service/service' });
  },

  goOrderListOffline() {
    wx.navigateTo({ url: '/pages/order-list/order-list?status=pendingOffline' });
  },

  goOrderListCreate() {
    wx.navigateTo({ url: '/pages/order-list/order-list?status=pendingCreate' });
  },

  goUnbindRequests() {
    wx.navigateTo({ url: '/pages/unbind-requests/unbind-requests' });
  },

  onViewCustomerList() {
    wx.navigateTo({ url: '/pages/customer-list/customer-list' });
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchKeyword: e.detail });
  },

  async onCustomerSearch() {
    const keyword = this.data.searchKeyword.trim();
    if (!keyword) return;
    try {
      const data = await callStaffApi<any[]>('customer.search', { keyword });
      this.setData({ customerResults: data || [] });
      if (!data || data.length === 0) {
        wx.showToast({ title: '未找到该顾客', icon: 'none' });
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
    }
  },

  onCustomerTap(e: WechatMiniprogram.TouchEvent) {
    const { id, clientUserId } = e.currentTarget.dataset;
    const params = id ? `id=${id}` : `clientUserId=${clientUserId}`;
    wx.navigateTo({ url: `/pages/customer-detail/customer-detail?${params}` });
  },
});
