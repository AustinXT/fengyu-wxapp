




import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';
import { formatCount } from '../../utils/number';
import { formatDateTime, formatDate } from '../../utils/formatters';



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


interface PaidOrderItem {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  paidSessions: number | null;
  productType: string;
  storeId?: string;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
}

interface PaidOrder {
  saleOrderId: string;
  status: string;
  paidAt: string;
  totalReceived: string;
  storeId?: string;
  storeName?: string;
  items: PaidOrderItem[];
  
  createdAt?: string;
  payableAmount?: string;
  received?: string;
  statusClass?: string;
  amountText?: string;
  timeText?: string;
}


const ORDER_STATUS_CLASS: Record<string, string> = {
  待支付: 'pending',
  已支付: 'success',
  已完成: 'success',
  已关闭: 'done',
  已退款: 'error',
  部分支付: 'progress',
};


interface TreatmentCard {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  paidSessions: number | null;
  usedSessions: number;
  paidUnusedSessions: number;
  usedPct: number;
  paidUnusedPct: number;
  unpaidPct: number;
  saleOrderId: string;
  paidAt: string;
  storeId?: string;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
}


interface GiftItem {
  saleItemId: string;
  productName: string;
  specName?: string;
  quantity: number;
  sessionCount: number;
  remainingSessions: number;
  paidSessions: number | null;
  
  paidUnusedSessions: number;
  createdAt?: string;
}

interface PromoOrder {
  saleOrderId: string;
  status: string;
  createdAt: string;
  paidAt?: string;
  items: Array<{
    productName: string;
    specName?: string;
    quantity: number;
    sessionCount?: number;
    remainingSessions?: number;
    paidSessions?: number | null;
    paidUnusedSessions?: number;
  }>;
}

interface GiftData {
  promoOrders: PromoOrder[];
  giftItems: GiftItem[];
}


interface ServiceRecord {
  serviceOrderId: string;
  status: string;
  statusClass?: string;
  serviceTime: string;
  staffName: string;
  storeName: string;
  metaText?: string;
  items: Array<{ itemName: string; spec: string }>;
}



Page({
  data: {
    loading: false,
    customerError: false,
    customer: null as CustomerDetail | null,
    activeTab: 0,
    
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '' as string,
    
    calendarYear: 0,
    calendarMonth: 0,
    calendarDays: [] as CalendarDay[],
    calendarSummary: [] as DailySummary[],
    calendarOrders: [] as CalendarOrder[],
    selectedDate: '',
    calendarLoaded: false,
    
    purchaseOrders: [] as PaidOrder[],
    purchaseLoaded: false,
    
    treatmentCards: [] as TreatmentCard[],
    cardsLoaded: false,
    
    giftData: null as GiftData | null,
    giftLoaded: false,
    
    serviceRecords: [] as ServiceRecord[],
    serviceLoaded: false,
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
      
      if (this.data.cardsLoaded) {
        this.setData({ cardsLoaded: false });
        this.loadTreatmentCards();
      }
    }
  },

  
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
      this.setData({ serviceLoaded: false });
      task = Promise.all([task, this.loadServiceHistory()]);
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
    } else if (index === 5 && !this.data.serviceLoaded) {
      this.loadServiceHistory();
    }
  },

  
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

  
  async loadPurchaseHistory() {
    if (!this._clientUserId) return;
    try {
      
      const orders = (await callStaffApi<PaidOrder[]>('mgmtCustomer.orderHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || []).map(o => ({
        ...o,
        statusClass: ORDER_STATUS_CLASS[o.status] || 'done',
        amountText: `¥${Number(o.payableAmount || 0).toFixed(2)}`,
        timeText: formatDateTime(o.paidAt || o.createdAt),
      }));
      this.setData({ purchaseOrders: orders, purchaseLoaded: true });
    } catch (_) {}
  },

  onPurchaseOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  
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
            const total = Number(item.totalSessions || 0);
            const remain = Number(item.remainingSessions || 0);
            const paid = item.paidSessions == null ? 0 : Number(item.paidSessions);
            const used = Math.max(total - remain, 0);
            const paidUnused = Math.max(paid - used, 0);
            const unpaid = Math.max(total - paid, 0);
            const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
            cards.push({
              saleItemId: item.saleItemId,
              itemName: item.itemName,
              spec: item.spec,
              remainingSessions: item.remainingSessions,
              totalSessions: item.totalSessions,
              paidSessions: item.paidSessions,
              usedSessions: used,
              paidUnusedSessions: paidUnused,
              usedPct: pct(used),
              paidUnusedPct: pct(paidUnused),
              unpaidPct: pct(unpaid),
              saleOrderId: order.saleOrderId,
              paidAt: order.paidAt,
              unitRealPrice: item.unitRealPrice,
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

  
  async loadGiftHistory() {
    if (!this._clientUserId) return;
    try {
      const data = await callStaffApi<GiftData>('mgmtCustomer.giftHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      });
      const formatted: GiftData = {
        promoOrders: (data?.promoOrders || []).map(o => ({
          ...o,
          paidAt: o.paidAt ? formatDateTime(o.paidAt) : o.paidAt,
          createdAt: formatDateTime(o.createdAt),
          items: (o.items || []).map(gi => {
            const gt = Number(gi.sessionCount || 0);
            const grm = Number(gi.remainingSessions || 0);
            const gpr = gi.paidSessions;
            return { ...gi, paidUnusedSessions: gpr == null ? grm : Math.max(0, Number(gpr) - Math.max(gt - grm, 0)) };
          }),
        })),
        giftItems: (data?.giftItems || []).map(g => {
          const ft = Number(g.sessionCount || 0);
          const frm = Number(g.remainingSessions || 0);
          const fpr = g.paidSessions;
          return {
            ...g,
            paidUnusedSessions: fpr == null ? frm : Math.max(0, Number(fpr) - Math.max(ft - frm, 0)),
            createdAt: g.createdAt ? formatDateTime(g.createdAt) : g.createdAt,
          };
        }),
      };
      this.setData({ giftData: formatted, giftLoaded: true });
    } catch (_) {
      this.setData({ giftData: { promoOrders: [], giftItems: [] }, giftLoaded: true });
    }
  },

  
  async loadServiceHistory() {
    if (!this._clientUserId) return;
    const statusClassMap: Record<string, string> = {
      '待服务': 'pending',
      '服务中': 'progress',
      '待客户确认': 'awaiting',
      '已完成': 'success',
      '已取消': 'done',
    };
    try {
      const records = (await callStaffApi<ServiceRecord[]>('mgmtCustomer.serviceHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || []).map(r => ({
        ...r,
        serviceTime: r.serviceTime ? formatDate(r.serviceTime) : '',
        statusClass: statusClassMap[r.status] || 'done',
        metaText: [r.storeName, r.staffName ? `美容师：${r.staffName}` : '']
          .filter(Boolean).join(' · '),
      }));
      this.setData({ serviceRecords: records, serviceLoaded: true });
    } catch (_) {
      this.setData({ serviceRecords: [], serviceLoaded: true });
    }
  },

  onServiceOrderTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageService/service-detail/service-detail?id=${id}` });
  },
});
