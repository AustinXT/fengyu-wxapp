// packageCustomer/customer-detail/customer-detail.ts — 7-Tab 顾客详情
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTime, formatDate } from '../../utils/formatters';

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
  /** WorkFine 历史订单待核对数（按手机号匹配；> 0 时顾客详情展示徽章提示） */
  legacyOrderCount: number;
}

/** Wave 2B 新增 customer.customerBalance 响应（跨店统一余额） */
interface CustomerBalanceResponse {
  balance: number;
  cardId: string | null;
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
  paidSessions: number | null;
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
  // 消费记录列表（customer.orderHistory）扩展字段
  createdAt?: string;
  payableAmount?: string;
  received?: string;
  remark?: string;
  // 前端预算的展示字段
  statusClass?: string;
  amountText?: string;
  timeText?: string;
}

// 订单状态 → status-tag 修饰类（app.wxss 定义：pending/success/progress/done/error）
const ORDER_STATUS_CLASS: Record<string, string> = {
  待支付: 'pending',
  已支付: 'success',
  已完成: 'success',
  已关闭: 'done',
  已退款: 'error',
  部分支付: 'progress',
};

// Tab 3: 持卡汇总
interface TreatmentCard {
  saleItemId: string;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  paidSessions: number | null;
  /** 可消费次数 = min(remaining, paid - used)。stepper.max 用此值。 */
  consumableSessions: number;
  usedSessions: number;
  paidUnusedSessions: number;
  usedPct: number;
  paidUnusedPct: number;
  unpaidPct: number;
  saleOrderId: string;
  paidAt: string;
  selected: boolean;
  sessionCount: number;
  storeId?: string;
}

// Tab 4: 服务记录
interface ServiceRecord {
  serviceOrderId: string;
  status: string;
  statusClass?: string;
  serviceTime: string;
  staffName: string;
  storeName: string;
  items: Array<{ itemName: string; spec: string }>;
}

// 预约记录
interface AppointmentRecord {
  id: string;
  customerName: string;
  staffName: string | null;
  appointmentTime: string;
  statusText: string;
  statusClass: string;
  serviceItemName: string;
  remark: string;
  checkinAt: string | null;
  createdAt: string;
}

// 手机号变更
interface PhoneChangeRecord {
  id: number;
  createdAt: string;
  oldPhone: string;
  newPhone: string;
  operatorLabel: string;
  source: string;
  sourceText: string;
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
    // Tab 4: 服务记录
    serviceRecords: [] as ServiceRecord[],
    serviceLoaded: false,
    // 预约记录
    appointmentRecords: [] as AppointmentRecord[],
    appointmentsLoaded: false,
    // 手机号变更
    phoneChangeRecords: [] as PhoneChangeRecord[],
    phoneLoaded: false,
    // Wave 3G — 储值卡余额（跨店统一，仅店长视角）
    cardBalance: 0 as number,
    cardBalanceLoaded: false as boolean,
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
      // lastServiceDate 为原始 pg date（序列化成 UTC 串会偏移日期），格式化为 YYYY-MM-DD
      if (customer.lastServiceDate) customer.lastServiceDate = formatDate(customer.lastServiceDate);
      this.setData({ customer, notesValue: customer.notes || '', notesDirty: false });
      // Wave 3G — 拉取储值卡余额（跨店统一）。失败静默兜底为 0
      void this.loadCardBalance();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * Wave 3G — 加载顾客储值卡余额（跨店统一）
   * - 仅当 customer.clientUserId 存在时调用
   * - 静默失败：余额展示 0，不阻塞页面
   */
  async loadCardBalance() {
    const { customer } = this.data;
    if (!customer?.clientUserId) {
      this.setData({ cardBalance: 0, cardBalanceLoaded: true });
      return;
    }
    try {
      const data = await callStaffApi<CustomerBalanceResponse>('customer.customerBalance', {
        customerUserId: customer.clientUserId,
      });
      this.setData({
        cardBalance: Math.max(0, Number(data?.balance) || 0),
        cardBalanceLoaded: true,
      });
    } catch (_) {
      this.setData({ cardBalance: 0, cardBalanceLoaded: true });
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.setData({ activeTab: index });
    // 7-Tab：0 基本档案 / 1 消费记录 / 2 疗程卡 / 3 预约记录 / 4 服务记录 /
    //         5 手机号变更 / 6 日历
    if (index === 1 && !this.data.purchaseLoaded) {
      this.loadPurchaseHistory();
    } else if (index === 2 && !this.data.cardsLoaded) {
      this.loadTreatmentCards();
    } else if (index === 3 && !this.data.appointmentsLoaded) {
      this.loadAppointments();
    } else if (index === 4 && !this.data.serviceLoaded) {
      this.loadServiceHistory();
    } else if (index === 5 && !this.data.phoneLoaded) {
      this.loadPhoneChangeLogs();
    } else if (index === 6 && !this.data.calendarLoaded) {
      this.loadCalendar();
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
      // 消费记录走 orderHistory（全状态 + 跨门店）；疗程卡 Tab 仍走 paidOrders（仅已支付可核销卡）
      const orders = (await callStaffApi<PaidOrder[]>('customer.orderHistory', id) || [])
        .map(o => ({
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

  // ===== Tab 3: 持卡汇总 =====
  async loadTreatmentCards() {
    const id = this._clientId();
    if (!id) return;
    try {
      const orders = await callStaffApi<PaidOrder[]>('customer.paidOrders', id) || [];
      const cards: TreatmentCard[] = [];
      for (const order of orders) {
        for (const item of order.items) {
          const total = Number(item.totalSessions || 0);
          const remain = Number(item.remainingSessions || 0);
          const paid = item.paidSessions == null ? 0 : Number(item.paidSessions);
          const used = Math.max(total - remain, 0);
          const paidUnused = Math.max(paid - used, 0);
          const unpaid = Math.max(total - paid, 0);
          const consumable = Math.max(0, Math.min(remain, paid - used));
          // D6=A：paid_sessions=0 或 已用满已付 → 整张卡锁死，不显示
          if (consumable <= 0) continue;
          const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
          cards.push({
            saleItemId: item.saleItemId,
            itemName: item.itemName,
            spec: item.spec,
            remainingSessions: item.remainingSessions,
            totalSessions: item.totalSessions,
            paidSessions: item.paidSessions,
            consumableSessions: consumable,
            usedSessions: used,
            paidUnusedSessions: paidUnused,
            usedPct: pct(used),
            paidUnusedPct: pct(paidUnused),
            unpaidPct: pct(unpaid),
            saleOrderId: order.saleOrderId,
            paidAt: order.paidAt,
            selected: false,
            sessionCount: 1,
          });
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

  // ===== Tab 4: 服务记录 =====
  async loadServiceHistory() {
    const id = this._clientId();
    if (!id) return;
    const statusClassMap: Record<string, string> = {
      '待服务': 'pending',
      '服务中': 'progress',
      '待客户确认': 'awaiting',
      '已完成': 'success',
      '已取消': 'done',
    };
    try {
      const records = (await callStaffApi<ServiceRecord[]>('customer.serviceHistory', id) || [])
        .map(r => ({
          ...r,
          serviceTime: r.serviceTime ? formatDate(r.serviceTime) : '',
          statusClass: statusClassMap[r.status] || 'done',
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

  // ===== 预约记录 =====
  async loadAppointments() {
    const id = this._clientId();
    if (!id) return;
    const statusClassMap: Record<string, string> = {
      '待确认': 'pending',
      '已确认': 'success',
      '已完成': 'done',
      '已取消': 'done',
      '已关闭': 'done',
    };
    try {
      const rows = (await callStaffApi<AppointmentRecord[]>('customer.appointments', id) || [])
        .map(r => ({
          ...r,
          appointmentTime: r.appointmentTime ? formatDateTime(r.appointmentTime) : '',
          statusClass: statusClassMap[r.statusText] || 'done',
        }));
      this.setData({ appointmentRecords: rows, appointmentsLoaded: true });
    } catch (_) {
      this.setData({ appointmentRecords: [], appointmentsLoaded: true });
    }
  },

  // ===== 手机号变更 =====
  async loadPhoneChangeLogs() {
    const id = this._clientId();
    if (!id) return;
    try {
      const rows = (await callStaffApi<PhoneChangeRecord[]>('customer.phoneChangeLogs', id) || [])
        .map(r => ({
          ...r,
          createdAt: r.createdAt ? formatDateTime(r.createdAt) : '',
          sourceText: r.source === 'admin' ? '后台修改' : '顾客换绑',
        }));
      this.setData({ phoneChangeRecords: rows, phoneLoaded: true });
    } catch (_) {
      this.setData({ phoneChangeRecords: [], phoneLoaded: true });
    }
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
