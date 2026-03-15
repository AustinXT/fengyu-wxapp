// packageCustomer/customer-detail/customer-detail.ts — 6-Tab 顾客详情
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

// ===== 数据接口 =====

interface CustomerDetail {
  id: string | null;
  clientUserId: string | null;
  name: string;
  gender: string | null;
  phone: string;
  phoneMasked: string;
  memberLevel: string | null;
  source: string;
  preferredStaffName: string | null;
  totalConsumption: number;
  yearConsumption: number;
  storeName: string;
  skinType: string | null;
  focusAreas: string | null;
  notes: string | null;
  lastServiceDate: string | null;
  visitFrequency: string | null;
  topProductName: string | null;
}

interface CustomerQuery {
  id?: string;
  clientUserId?: string;
}

interface ClientIdentifier {
  clientUserId?: string;
  clientPhone?: string;
}

// Tab 1: 日历
interface DailySummary {
  date: string;
  orderCount: number;
  totalReceived: number;
}

interface CalendarOrder {
  saleOrderId: string;
  saleOrderType: string;
  paymentMethod: string;
  paidAt: string;
  totalReceived: string;
  customerName: string;
}

interface CalendarResponse {
  year: number;
  month: number;
  dailySummary: DailySummary[];
  orders: CalendarOrder[];
}

interface CalendarDay {
  day: number;
  date?: string;
  amount?: number;
  amountLabel?: string;
  hasData?: boolean;
}

// Tab 2: 购买记录
interface PaidOrderItem {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  productType: string;
}

interface PaidOrder {
  saleOrderId: string;
  status: string;
  paidAt: string;
  totalReceived: string;
  items: PaidOrderItem[];
}

// Tab 3: 持卡汇总
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

// Tab 4: 赠送记录
interface GiftItem {
  saleItemId: string;
  productName: string;
  skuSpecName: string;
  quantity: number;
  sessionCount: number;
  remainingSessions: number;
}

interface PromoOrder {
  saleOrderId: string;
  status: string;
  createdAt: string;
  items: Array<{ productName: string; skuSpecName: string; quantity: number }>;
}

interface GiftData {
  promoOrders: PromoOrder[];
  giftItems: GiftItem[];
}

// Tab 5: 退换记录
interface RefundRecord {
  saleOrderId: string;
  type: string;
  status: string;
  totalAmount: string;
  handlingFee: number | null;
  refundReason: string | null;
  createdAt: string;
  items: Array<{ productName: string; skuSpecName: string; quantity: number; received: string }>;
}

// ===== 页面逻辑 =====

Page({
  data: {
    loading: false,
    customer: null as CustomerDetail | null,
    isManager: false,
    activeTab: 0,
    // Tab 0: 详情（客户信息）
    notesValue: '',
    notesDirty: false,
    notesSaving: false,
    // Tab 1: 日历
    calendarYear: 0,
    calendarMonth: 0,
    calendarDays: [] as CalendarDay[],
    calendarSummary: [] as DailySummary[],
    calendarOrders: [] as CalendarOrder[],
    selectedDate: '',
    calendarLoaded: false,
    // Tab 2: 购买记录
    purchaseOrders: [] as PaidOrder[],
    purchaseLoaded: false,
    // Tab 3: 持卡汇总
    treatmentCards: [] as TreatmentCard[],
    cardsLoaded: false,
    selectedCount: 0,
    // Tab 4: 赠送记录
    giftData: null as GiftData | null,
    giftLoaded: false,
    // Tab 5: 退换记录
    refundRecords: [] as RefundRecord[],
    refundLoaded: false,
  },

  _query: null as CustomerQuery | null,
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
      const customer = await callStaffApi<CustomerDetail>('customer.detail', this._query);
      this.setData({ customer, notesValue: customer.notes || '', notesDirty: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
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

  /** 构建客户标识参数（clientUserId 优先，否则 clientPhone） */
  _clientId(): ClientIdentifier | null {
    const { customer } = this.data;
    if (!customer) return null;
    return customer.clientUserId
      ? { clientUserId: customer.clientUserId }
      : { clientPhone: customer.phone };
  },

  // ===== Tab 1: 日历 =====
  async loadCalendar() {
    const id = this._clientId();
    if (!id) return;
    try {
      const data = await callStaffApi<CalendarResponse>('customer.calendar', {
        ...id,
        year: this.data.calendarYear,
        month: this.data.calendarMonth,
      });
      const days = this.buildCalendarDays(this.data.calendarYear, this.data.calendarMonth, data.dailySummary || []);
      this.setData({
        calendarDays: days,
        calendarSummary: data.dailySummary || [],
        calendarOrders: data.orders || [],
        calendarLoaded: true,
      });
    } catch (_) {}
  },

  buildCalendarDays(year: number, month: number, summary: DailySummary[]): CalendarDay[] {
    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const summaryMap = new Map<string, DailySummary>();
    for (const s of summary) {
      summaryMap.set(String(s.date).slice(0, 10), s);
    }
    const days: CalendarDay[] = [];
    for (let i = 0; i < firstDay; i++) days.push({ day: 0 });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const s = summaryMap.get(dateStr);
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
    const id = this._clientId();
    if (!id) return;
    try {
      const orders = await callStaffApi<PaidOrder[]>('customer.paidOrders', id) || [];
      this.setData({ purchaseOrders: orders, purchaseLoaded: true });
    } catch (_) {}
  },

  onPurchaseOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== Tab 3: 持卡汇总 =====
  async loadTreatmentCards() {
    const id = this._clientId();
    if (!id) return;
    try {
      const orders = await callStaffApi<PaidOrder[]>('customer.paidOrders', id) || [];
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
    this.setData({
      [`treatmentCards[${index}].selected`]: newSelected,
      [`treatmentCards[${index}].sessionCount`]: newSelected ? card.sessionCount : 1,
      selectedCount: this.data.selectedCount + (newSelected ? 1 : -1),
    });
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
        id: customer.clientUserId || customer.id || '',
        name: customer.name,
        phone: customer.phone,
        clientUserId: customer.clientUserId || undefined,
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
    const id = this._clientId();
    if (!id) return;
    try {
      const data = await callStaffApi<GiftData>('customer.giftHistory', id);
      this.setData({ giftData: data, giftLoaded: true });
    } catch (_) {
      this.setData({ giftData: { promoOrders: [], giftItems: [] }, giftLoaded: true });
    }
  },

  // ===== Tab 5: 退换记录 =====
  async loadRefundHistory() {
    const id = this._clientId();
    if (!id) return;
    try {
      const records = await callStaffApi<RefundRecord[]>('customer.refundHistory', id) || [];
      this.setData({ refundRecords: records, refundLoaded: true });
    } catch (_) {
      this.setData({ refundRecords: [], refundLoaded: true });
    }
  },

  onRefundOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== 备注编辑 =====
  onNotesChange(e: WechatMiniprogram.CustomEvent) {
    const val = e.detail as unknown as string;
    this.setData({
      notesValue: val,
      notesDirty: val !== (this.data.customer?.notes || ''),
    });
  },

  async onSaveNotes() {
    const { customer, notesValue } = this.data;
    if (!customer?.clientUserId) return;
    this.setData({ notesSaving: true });
    try {
      await callStaffApi('customer.updateNotes', {
        clientUserId: customer.clientUserId,
        notes: notesValue,
      });
      this.setData({
        notesDirty: false,
        'customer.notes': notesValue.trim() || null,
      });
      wx.showToast({ title: '备注已保存', icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ notesSaving: false });
    }
  },
});
