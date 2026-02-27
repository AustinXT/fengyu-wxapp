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
    role: '' as 'manager' | 'beautician' | '',
    today: '',
    todayCommission: '0.00',
    todayOrderCount: 0,
    todayServiceCount: 0,
    // 月度业绩日历
    currentMonth: '',
    monthLabel: '',
    monthlyTotal: '0.00',
    calendarDays: [] as CalendarDay[],
    // 代办事项
    todoList: [] as Array<{
      id: string;
      type: 'appointment' | 'service';
      title: string;
      desc: string;
      targetPage: string;
      params: string;
    }>,
    // 顾客搜索
    searchKeyword: '',
    recentCustomers: [] as Array<{
      id: string;
      name: string;
      phone: string;
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
    const { userId, staffWfId, staffName, role, boundStoreName } = app.globalData;
    this.setData({
      storeName: boundStoreName,
      staffName,
      role,
    });
    if (userId && staffWfId) {
      this.loadWorkbench();
    }
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
        this.loadTodoList(),
      ]);
    } catch (err) {
      console.error('[workbench] loadWorkbench error:', err);
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
      }>('staff.todayCommission');
      this.setData({
        todayCommission: data.todayAmount || '0.00',
        todayOrderCount: data.orderCount || 0,
        todayServiceCount: data.serviceCount || 0,
      });
    } catch (_) {
      // 接口未实现时静默
    }
  },

  async loadMonthlyCalendar() {
    try {
      const data = await callStaffApi<{
        dailyData: Array<{ date: string; amount: number }>;
        totalAmount: number;
      }>('staff.monthlyCalendar', { yearMonth: this.data.currentMonth });
      const days = this.buildCalendarDays(this.data.currentMonth, data.dailyData || []);
      const total = data.totalAmount > 0
        ? (data.totalAmount / 100).toFixed(2)
        : '0.00';
      this.setData({ calendarDays: days, monthlyTotal: total });
    } catch (_) {
      // API 未实现时显示空日历
      const days = this.buildCalendarDays(this.data.currentMonth, []);
      this.setData({ calendarDays: days });
    }
  },

  buildCalendarDays(yearMonth: string, dailyData: Array<{ date: string; amount: number }>): CalendarDay[] {
    const [y, m] = yearMonth.split('-').map(Number);
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const firstDow = new Date(y, m - 1, 1).getDay(); // 0=周日
    const daysInMonth = new Date(y, m, 0).getDate();
    const dataMap: Record<string, number> = {};
    dailyData.forEach(d => { dataMap[d.date] = d.amount; });

    const days: CalendarDay[] = [];
    // 空格填充（月初前的空白）
    for (let i = 0; i < firstDow; i++) {
      days.push({ isEmpty: true, day: 0, date: '', hasData: false, amountLabel: '', isToday: false });
    }
    // 实际日期
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
    if (y > curY || (y === curY && m >= curM)) return; // 不超过当月
    let ny = y, nm = m + 1;
    if (nm > 12) { ny += 1; nm = 1; }
    const ym = `${ny}-${String(nm).padStart(2, '0')}`;
    this.setData({ currentMonth: ym, monthLabel: this.formatMonthLabel(ym) });
    this.loadMonthlyCalendar();
  },

  async loadTodoList() {
    try {
      const data = await callStaffApi<{
        pendingAppointments: Array<{ id: string; customerName: string; appointmentTime: string }>;
        pendingServices: Array<{ id: string; customerName: string; serviceNo: string }>;
      }>('staff.todoList');

      const todoList: typeof this.data.todoList = [];

      (data.pendingAppointments || []).forEach(a => {
        todoList.push({
          id: `appt-${a.id}`,
          type: 'appointment',
          title: `待确认预约：${a.customerName}`,
          desc: a.appointmentTime,
          targetPage: '/pages/appointment-detail/appointment-detail',
          params: `id=${a.id}`,
        });
      });

      (data.pendingServices || []).forEach(s => {
        todoList.push({
          id: `svc-${s.id}`,
          type: 'service',
          title: `待服务：${s.customerName}`,
          desc: s.serviceNo,
          targetPage: '/pages/service-detail/service-detail',
          params: `id=${s.id}`,
        });
      });

      this.setData({ todoList });
    } catch (_) {}
  },

  onTodoTap(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.item as typeof this.data.todoList[0];
    wx.navigateTo({ url: `${item.targetPage}?${item.params}` });
  },

  onViewCustomerList() {
    wx.navigateTo({ url: '/pages/customer-list/customer-list' });
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchKeyword: e.detail });
  },

  async onCustomerSearch() {
    const phone = this.data.searchKeyword.trim();
    if (!phone) return;
    try {
      const data = await callStaffApi<Array<{ id: string; name: string; phone: string }>>(
        'customer.search',
        { phone }
      );
      this.setData({ recentCustomers: data || [] });
      if (!data || data.length === 0) {
        wx.showToast({ title: '未找到该顾客', icon: 'none' });
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
    }
  },

  onCustomerTap(e: WechatMiniprogram.TouchEvent) {
    const { id, phone } = e.currentTarget.dataset as { id: string; phone: string };
    wx.navigateTo({ url: `/pages/customer-detail/customer-detail?id=${id}&phone=${phone}` });
  },
});
