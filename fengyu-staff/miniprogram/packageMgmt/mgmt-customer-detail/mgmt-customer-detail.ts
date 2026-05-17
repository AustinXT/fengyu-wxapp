// packageMgmt/mgmt-customer-detail — 管理层"顾客档案"详情子页（只读）
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不展示 scope-picker
// 区别于门店视图（packageCustomer/customer-detail）：
//   - 移除：客户分配 / 备注保存 / 储值卡余额 / 持卡勾选 + 创建服务单
//   - 保留：订单详情跳转（只读浏览）
import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';
import { formatCount } from '../../utils/number';

// ===== 数据接口 =====

type ScopeType = 'all' | 'market' | 'store';

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
  payDate?: string;
  totalReceived: string;
  customerName: string;
  orderType?: string;
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
  storeId?: string;
}

interface PaidOrder {
  saleOrderId: string;
  status: string;
  paidAt: string;
  totalReceived: string;
  storeId?: string;
  storeName?: string;
  items: PaidOrderItem[];
}

// Tab 3: 持卡汇总（管理层视图：纯展示，无勾选/步进器）
interface TreatmentCard {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  saleOrderId: string;
  paidAt: string;
  storeId?: string;
}

// Tab 4: 赠送记录
interface GiftItem {
  saleItemId: string;
  productName: string;
  skuSpecName: string;
  specName?: string;
  quantity: number;
  sessionCount: number;
  remainingSessions: number;
  createdAt?: string;
}

interface PromoOrder {
  saleOrderId: string;
  status: string;
  createdAt: string;
  paidAt?: string;
  items: Array<{
    productName: string;
    skuSpecName: string;
    specName?: string;
    quantity: number;
    sessionCount?: number;
    remainingSessions?: number;
  }>;
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
  items: Array<{
    productName: string;
    skuSpecName: string;
    quantity: number;
    received: string;
    direction?: string;
  }>;
}

// ===== 页面逻辑 =====

Page({
  data: {
    loading: false,
    customerError: false,
    customer: null as CustomerDetail | null,
    activeTab: 0,
    // scope 透传
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '' as string,
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
    // Tab 4: 赠送记录
    giftData: null as GiftData | null,
    giftLoaded: false,
    // Tab 5: 退换记录
    refundRecords: [] as RefundRecord[],
    refundLoaded: false,
  },

  _clientUserId: '' as string,
  _loaded: false,

  onLoad(options: Record<string, string>) {
    const clientUserId = options.clientUserId || '';
    const scopeType = ((options.scopeType as ScopeType) || 'all') as ScopeType;
    const scopeId = options.scopeId ? decodeURIComponent(options.scopeId) : null;
    const scopeName = options.scopeName ? decodeURIComponent(options.scopeName) : '';

    if (!clientUserId) {
      wx.showToast({ title: '参数缺失', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 800);
      return;
    }

    this._clientUserId = clientUserId;

    const now = new Date();
    this.setData({
      scopeType,
      scopeId,
      scopeName,
      calendarYear: now.getFullYear(),
      calendarMonth: now.getMonth() + 1,
    });

    this.loadCustomer();
    this._loaded = true;
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' });
      return;
    }
    if (this._loaded && this._clientUserId) {
      // 刷新已加载的 tab 数据（疗程卡次数可能因服务单完成而变化）
      if (this.data.cardsLoaded) {
        this.setData({ cardsLoaded: false });
        this.loadTreatmentCards();
      }
    }
  },

  /** 公共 scope payload */
  _scopePayload(): { scopeType: ScopeType; scopeId: string | null } {
    return {
      scopeType: this.data.scopeType,
      scopeId: this.data.scopeId,
    };
  },

  async loadCustomer() {
    if (!this._clientUserId) return;
    this.setData({ loading: true, customerError: false });
    try {
      const customer = await callStaffApi<CustomerDetail>('mgmtCustomer.detail', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      });
      this.setData({ customer });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      // 优先按 errorType 路由（callStaffApi 已把 errorType 挂到 Error 实例），
      // 回退到 message indexOf 兜底（仅在 errorType 字段未透出时生效）
      const errorType = (err as { errorType?: string } | null)?.errorType;
      if (errorType === 'PERMISSION_DENIED' || (!errorType && msg.indexOf('PERMISSION_DENIED') >= 0)) {
        wx.showToast({ title: '顾客不在当前数据范围', icon: 'none' });
        setTimeout(() => wx.navigateBack({ delta: 1 }), 800);
      } else {
        this.setData({ customerError: true });
        wx.showToast({ title: msg, icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  onCustomerRetry() {
    this.loadCustomer();
  },

  onPullDownRefresh() {
    const finish = () => wx.stopPullDownRefresh();
    const tab = this.data.activeTab;
    let task: Promise<unknown> = this.loadCustomer();
    if (tab === 1) {
      this.setData({ calendarLoaded: false });
      task = Promise.all([task, this.loadCalendar()]);
    } else if (tab === 2) {
      this.setData({ purchaseLoaded: false });
      task = Promise.all([task, this.loadPurchaseHistory()]);
    } else if (tab === 3) {
      this.setData({ cardsLoaded: false });
      task = Promise.all([task, this.loadTreatmentCards()]);
    } else if (tab === 4) {
      this.setData({ giftLoaded: false });
      task = Promise.all([task, this.loadGiftHistory()]);
    } else if (tab === 5) {
      this.setData({ refundLoaded: false });
      task = Promise.all([task, this.loadRefundHistory()]);
    }
    task.finally(finish);
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
    if (!this._clientUserId) return;
    try {
      const data = await callStaffApi<CalendarResponse>('mgmtCustomer.calendar', {
        clientUserId: this._clientUserId,
        year: this.data.calendarYear,
        month: this.data.calendarMonth,
        ...this._scopePayload(),
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
        amountLabel: formatCount(amount),
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
    if (!this._clientUserId) return;
    try {
      const orders = await callStaffApi<PaidOrder[]>('mgmtCustomer.paidOrders', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || [];
      this.setData({ purchaseOrders: orders, purchaseLoaded: true });
    } catch (_) {}
  },

  onPurchaseOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== Tab 3: 持卡汇总（仅展示） =====
  async loadTreatmentCards() {
    if (!this._clientUserId) return;
    try {
      const orders = await callStaffApi<PaidOrder[]>('mgmtCustomer.paidOrders', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || [];
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
            });
          }
        }
      }
      this.setData({ treatmentCards: cards, cardsLoaded: true });
    } catch (_) {}
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  // ===== Tab 4: 赠送记录 =====
  async loadGiftHistory() {
    if (!this._clientUserId) return;
    try {
      const data = await callStaffApi<GiftData>('mgmtCustomer.giftHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      });
      this.setData({ giftData: data, giftLoaded: true });
    } catch (_) {
      this.setData({ giftData: { promoOrders: [], giftItems: [] }, giftLoaded: true });
    }
  },

  // ===== Tab 5: 退换记录 =====
  async loadRefundHistory() {
    if (!this._clientUserId) return;
    try {
      const records = await callStaffApi<RefundRecord[]>('mgmtCustomer.refundHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || [];
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
