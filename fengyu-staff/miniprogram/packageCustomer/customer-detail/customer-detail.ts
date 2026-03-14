// packageCustomer/customer-detail/customer-detail.ts — 6-Tab 顾客详情
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

interface TreatmentCard {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  saleOrderId: string;
  paidAt: string;
  selected: boolean;
  sessionCount: number;
}

Page({
  data: {
    loading: false,
    customer: null as any,
    isManager: false,
    activeTab: 0,
    // Tab 0: 详情（客户信息）
    // Tab 1: 日历
    calendarYear: 0,
    calendarMonth: 0,
    calendarDays: [] as any[],
    calendarSummary: [] as any[],
    calendarOrders: [] as any[],
    selectedDate: '',
    calendarLoaded: false,
    // Tab 2: 购买记录
    purchaseOrders: [] as any[],
    purchaseLoaded: false,
    // Tab 3: 持卡汇总
    treatmentCards: [] as TreatmentCard[],
    cardsLoaded: false,
    selectedCount: 0,
    // Tab 4: 赠送记录
    giftData: null as any,
    giftLoaded: false,
    // Tab 5: 退换记录
    refundRecords: [] as any[],
    refundLoaded: false,
  },

  _query: null as any,
  _loaded: false,

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    const now = new Date();
    this.setData({
      calendarYear: now.getFullYear(),
      calendarMonth: now.getMonth() + 1,
    });

    if (options.id) {
      this._query = { id: options.id };
    } else if (options.clientUserId) {
      this._query = { clientUserId: options.clientUserId };
    }
    this.loadCustomer();
    this._loaded = true;
  },

  onShow() {
    if (this._loaded && this._query) {
      this.loadCustomer();
      // 刷新已加载的 tab 数据（疗程卡次数可能因服务单完成而变化）
      if (this.data.cardsLoaded) {
        this.setData({ cardsLoaded: false });
        this.loadTreatmentCards();
      }
    }
  },

  async loadCustomer() {
    if (!this._query) return;
    this.setData({ loading: true });
    try {
      const customer = await callStaffApi<any>('customer.detail', this._query);
      this.setData({ customer });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeTab: index });
    if (index === 1 && !this.data.calendarLoaded) {
      this.loadCalendar();
    } else if (index === 2 && !this.data.purchaseLoaded) {
      this.loadPurchaseHistory();
    } else if (index === 3 && !this.data.cardsLoaded) {
      this.loadTreatmentCards();
    } else if (index === 4 && !this.data.giftLoaded) {
      this.loadGiftHistory();
    } else if (index === 5 && !this.data.refundLoaded) {
      this.loadRefundHistory();
    }
  },

  // ===== Tab 1: 日历 =====
  async loadCalendar() {
    const { customer, calendarYear, calendarMonth } = this.data;
    if (!customer) return;
    try {
      const params: any = { year: calendarYear, month: calendarMonth };
      if (customer.clientUserId) params.clientUserId = customer.clientUserId;
      else params.clientPhone = customer.phone;
      const data = await callStaffApi<any>('customer.calendar', params);
      const days = this.buildCalendarDays(calendarYear, calendarMonth, data.dailySummary || []);
      this.setData({
        calendarDays: days,
        calendarSummary: data.dailySummary || [],
        calendarOrders: data.orders || [],
        calendarLoaded: true,
      });
    } catch (_) {}
  },

  buildCalendarDays(year: number, month: number, summary: any[]) {
    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const summaryMap: Record<string, any> = {};
    for (const s of summary) {
      const d = String(s.date).slice(0, 10);
      summaryMap[d] = s;
    }
    const days: any[] = [];
    for (let i = 0; i < firstDay; i++) days.push({ day: 0 });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const s = summaryMap[dateStr];
      const amount = s ? s.totalReceived : 0;
      days.push({
        day: d,
        date: dateStr,
        amount,
        amountLabel: amount >= 1000 ? (amount / 1000).toFixed(1) + 'k' : String(amount),
        hasData: !!s,
      });
    }
    return days;
  },

  onCalendarPrev() {
    let { calendarYear, calendarMonth } = this.data;
    calendarMonth--;
    if (calendarMonth < 1) { calendarMonth = 12; calendarYear--; }
    this.setData({ calendarYear, calendarMonth, calendarLoaded: false, selectedDate: '' });
    this.loadCalendar();
  },

  onCalendarNext() {
    let { calendarYear, calendarMonth } = this.data;
    const now = new Date();
    if (calendarYear === now.getFullYear() && calendarMonth >= now.getMonth() + 1) return;
    calendarMonth++;
    if (calendarMonth > 12) { calendarMonth = 1; calendarYear++; }
    this.setData({ calendarYear, calendarMonth, calendarLoaded: false, selectedDate: '' });
    this.loadCalendar();
  },

  onCalendarDateTap(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    if (!date) return;
    this.setData({ selectedDate: this.data.selectedDate === date ? '' : date });
  },

  // ===== Tab 2: 购买记录 =====
  async loadPurchaseHistory() {
    const { customer } = this.data;
    if (!customer) return;
    try {
      const params: any = {};
      if (customer.clientUserId) params.clientUserId = customer.clientUserId;
      else params.clientPhone = customer.phone;
      const orders = await callStaffApi<any[]>('customer.paidOrders', params) || [];
      this.setData({ purchaseOrders: orders, purchaseLoaded: true });
    } catch (_) {}
  },

  onPurchaseOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== Tab 3: 持卡汇总 =====
  async loadTreatmentCards() {
    const { customer } = this.data;
    if (!customer) return;
    try {
      const params: any = {};
      if (customer.clientUserId) params.clientUserId = customer.clientUserId;
      else params.clientPhone = customer.phone;
      const orders = await callStaffApi<any[]>('customer.paidOrders', params) || [];
      const cards: TreatmentCard[] = [];
      for (const order of orders) {
        for (const item of order.items) {
          if (item.remainingSessions > 0) {
            cards.push({
              saleItemId: item.saleItemId,
              itemName: item.itemName,
              spec: item.spec,
              remainingSessions: item.remainingSessions,
              totalSessions: item.totalSessions,
              saleOrderId: order.saleOrderId,
              paidAt: order.paidAt,
              selected: false,
              sessionCount: 1,
            });
          }
        }
      }
      this.setData({ treatmentCards: cards, cardsLoaded: true, selectedCount: 0 });
    } catch (_) {}
  },

  onToggleCard(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    const card = this.data.treatmentCards[index];
    const newSelected = !card.selected;
    const update: Record<string, any> = {
      [`treatmentCards[${index}].selected`]: newSelected,
    };
    if (!newSelected) {
      update[`treatmentCards[${index}].sessionCount`] = 1;
    }
    update.selectedCount = this.data.selectedCount + (newSelected ? 1 : -1);
    this.setData(update);
  },

  onStepperChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.currentTarget.dataset.index as number;
    this.setData({ [`treatmentCards[${index}].sessionCount`]: e.detail });
  },

  preventBubble() {},

  onCreateService() {
    const { customer, treatmentCards } = this.data;
    if (!customer) return;
    const selected = treatmentCards.filter(c => c.selected);
    if (selected.length === 0) return;
    app.globalData._serviceCreatePreload = {
      customer: {
        id: customer.clientUserId || customer.id,
        name: customer.name,
        phone: customer.phone,
        clientUserId: customer.clientUserId,
      },
      items: selected.map(c => ({
        saleItemId: c.saleItemId,
        itemName: c.itemName,
        spec: c.spec,
        saleOrderId: c.saleOrderId,
        sessionCount: c.sessionCount,
        remainingSessions: c.remainingSessions,
      })),
    };
    wx.navigateTo({ url: '/packageService/service-create/service-create?preloaded=1' });
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== Tab 4: 赠送记录 =====
  async loadGiftHistory() {
    const { customer } = this.data;
    if (!customer) return;
    try {
      const params: any = {};
      if (customer.clientUserId) params.clientUserId = customer.clientUserId;
      else params.clientPhone = customer.phone;
      const data = await callStaffApi<any>('customer.giftHistory', params);
      this.setData({ giftData: data, giftLoaded: true });
    } catch (_) {
      this.setData({ giftData: { promoOrders: [], giftItems: [] }, giftLoaded: true });
    }
  },

  // ===== Tab 5: 退换记录 =====
  async loadRefundHistory() {
    const { customer } = this.data;
    if (!customer) return;
    try {
      const params: any = {};
      if (customer.clientUserId) params.clientUserId = customer.clientUserId;
      else params.clientPhone = customer.phone;
      const records = await callStaffApi<any[]>('customer.refundHistory', params) || [];
      this.setData({ refundRecords: records, refundLoaded: true });
    } catch (_) {
      this.setData({ refundRecords: [], refundLoaded: true });
    }
  },

  onRefundOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },
});
