// packageMgmt/mgmt-customer-detail — 管理层"顾客档案"详情子页（只读）
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不展示 scope-picker
// 区别于门店视图（packageCustomer/customer-detail）：
//   - 移除：客户分配 / 备注保存 / 储值卡余额 / 持卡勾选 + 创建服务单
//   - 保留：订单详情跳转（只读浏览）
import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';
import { formatAmount, formatCount } from '../../utils/number';
import { formatDateTime, formatDate, ORDER_TYPE_LABEL } from '../../utils/formatters';
import { MemberLevelBadgeData, withMemberLevelBadgeClass } from '../../utils/member-level-badge';

// ===== 数据接口 =====

type ScopeType = 'all' | 'market' | 'store';

interface CustomerDetail extends MemberLevelBadgeData {
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
  totalActualConsumption: number;
  yearActualConsumption: number;
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
  paidSessions: number | null;
  productType: string;
  unit?: string;
  storeId?: string;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
  /** 品项标签（product_categories.category_name） */
  category?: string;
  /** 品项标签色（display_color） */
  categoryColor?: string;
  /** 一级品项（product_categories.product_kind） */
  productKind?: string;
  /** 二级品项 ID（历史无分类卡为空） */
  categoryId?: string;
  /** 二级品项名称（保留 category 兼容字段） */
  categoryName?: string;
}

interface PaidOrder {
  saleOrderId: string;
  status: string;
  paidAt: string;
  totalReceived: string;
  storeId?: string;
  storeName?: string;
  /** 单据类型（sale_orders.sale_order_type） */
  saleOrderType?: string;
  items: PaidOrderItem[];
  // 消费记录列表（mgmtCustomer.orderHistory）扩展字段
  createdAt?: string;
  payableAmount?: string;
  received?: string;
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

// Tab 3: 持卡汇总（管理层视图：纯展示，无勾选/步进器）
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
  unit: string;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
  /** 品项标签（product_categories.category_name） */
  category?: string;
  /** 品项标签色（display_color） */
  categoryColor?: string;
  /** 单据类型展示文案（ORDER_TYPE_LABEL 映射后） */
  saleOrderTypeLabel?: string;
  productKind?: string;
  categoryId?: string;
  categoryName?: string;
}

interface CardFilterOption {
  value: string;
  label: string;
}

// Tab 4: 赠送记录
interface GiftItem {
  saleItemId: string;
  productName: string;
  specName?: string;
  quantity: number;
  sessionCount: number;
  unit: string;
  remainingSessions: number;
  paidSessions: number | null;
  /** 已付未用次数（与持卡汇总同口径）；paidSessions 为 null 时退回物理剩余 */
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
    unit?: string;
  }>;
}

interface GiftData {
  promoOrders: PromoOrder[];
  giftItems: GiftItem[];
}

function normalizeSpecName(productName?: string | null, specName?: string | null): string {
  const name = (productName || '').trim();
  const spec = (specName || '').trim();
  return spec && spec !== name ? spec : '';
}

// Tab 5: 服务记录
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
    cardProductKind: '',
    cardCategoryId: '',
    cardNameQuery: '',
    cardProductKindOptions: [] as CardFilterOption[],
    cardCategoryOptions: [] as CardFilterOption[],
    cardProductKindLabel: '全部一级品项',
    cardCategoryLabel: '全部二级品项',
    hasTreatmentCardFilter: false,
    // Tab 4: 赠送记录
    giftData: null as GiftData | null,
    giftLoaded: false,
    // Tab 5: 服务记录
    serviceRecords: [] as ServiceRecord[],
    serviceLoaded: false,
  },

  _clientUserId: '' as string,
  _loaded: false,
  _allTreatmentCards: [] as TreatmentCard[],

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
      const raw = await callStaffApi<CustomerDetail>('mgmtCustomer.detail', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      });
      // 金额字段就地格式化为「千分位 + 2 位小数」展示串。
      const customer = {
        ...raw,
        totalConsumption: formatAmount(raw.totalConsumption),
        yearConsumption: formatAmount(raw.yearConsumption),
        totalActualConsumption: formatAmount(raw.totalActualConsumption),
        yearActualConsumption: formatAmount(raw.yearActualConsumption),
      } as unknown as CustomerDetail;
      this.setData({ customer: withMemberLevelBadgeClass(customer) });
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
      // 选中日订单金额格式化为「千分位 + 2 位小数」（wxml ¥{{item.totalReceived}}）
      const orders = (data.orders || []).map(o => ({
        ...o,
        totalReceived: formatAmount(Number(o.totalReceived) || 0),
      }));
      this.setData({
        calendarDays: days,
        calendarSummary: data.dailySummary || [],
        calendarOrders: orders,
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
      // 消费记录走 orderHistory（全状态 + 跨门店）；疗程卡 Tab 仍走 paidOrders（仅已支付可核销卡）
      const orders = (await callStaffApi<PaidOrder[]>('mgmtCustomer.orderHistory', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) || []).map(o => ({
        ...o,
        statusClass: ORDER_STATUS_CLASS[o.status] || 'done',
        amountText: `¥${formatAmount(Number(o.payableAmount) || 0)}`,
        timeText: formatDateTime(o.paidAt || o.createdAt),
      }));
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
      const resp = await callStaffApi<{ scope: unknown; orders: PaidOrder[] }>('mgmtCustomer.paidOrders', {
        clientUserId: this._clientUserId,
        ...this._scopePayload(),
      }) ?? { orders: [] };
      const orders = resp.orders || [];
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
              unitRealPrice: item.unitRealPrice ? formatAmount(Number(item.unitRealPrice)) : undefined,
              unit: item.unit || '次',
              category: item.category,
              categoryColor: item.categoryColor,
              productKind: item.productKind || '',
              categoryId: item.categoryId || '',
              categoryName: item.categoryName || item.category || '',
              saleOrderTypeLabel: ORDER_TYPE_LABEL[order.saleOrderType || ''] || order.saleOrderType || '',
            });
          }
        }
      }
      // 按品项标签归拢排序：主键 category（空排末尾），次键 paidAt DESC 兜底
      cards.sort((a, b) => {
        const ca = a.category || '';
        const cb = b.category || '';
        if (ca !== cb) {
          if (!ca) return 1;
          if (!cb) return -1;
          return ca.localeCompare(cb, 'zh');
        }
        return (a.paidAt < b.paidAt) ? 1 : (a.paidAt > b.paidAt) ? -1 : 0;
      });
      this.applyTreatmentCardFilters(cards, {
        productKind: '',
        categoryId: '',
        nameQuery: '',
      });
      this.setData({ cardsLoaded: true });
    } catch (_) {}
  },

  applyTreatmentCardFilters(
    this: any,
    cards: TreatmentCard[] = this._allTreatmentCards,
    filters: { productKind?: string; categoryId?: string; nameQuery?: string } = {},
  ) {
    this._allTreatmentCards = cards;
    const productKind = filters.productKind ?? this.data.cardProductKind;
    const categoryId = filters.categoryId ?? this.data.cardCategoryId;
    const nameQuery = filters.nameQuery ?? this.data.cardNameQuery;
    const productKindOptions: CardFilterOption[] = [
      { value: '', label: '全部一级品项' },
      ...Array.from(new Set(cards.map((card) => card.productKind).filter((value): value is string => Boolean(value))))
        .map((value) => ({ value, label: value })),
    ];
    const categoryOptions: CardFilterOption[] = [
      { value: '', label: productKind ? '全部二级品项' : '请先选择一级品项' },
      ...Array.from(
        new Map(
          cards
            .filter((card) => card.categoryId && card.categoryName && productKind && card.productKind === productKind)
            .map((card) => [card.categoryId!, { value: card.categoryId!, label: card.categoryName! }]),
        ).values(),
      ),
    ];
    const query = nameQuery.trim().toLocaleLowerCase();
    const treatmentCards = cards.filter((card) => {
      if (productKind && card.productKind !== productKind) return false;
      if (categoryId && card.categoryId !== categoryId) return false;
      return !query || card.itemName.toLocaleLowerCase().includes(query);
    });
    this.setData({
      treatmentCards,
      cardProductKind: productKind,
      cardCategoryId: categoryId,
      cardNameQuery: nameQuery,
      cardProductKindOptions: productKindOptions,
      cardCategoryOptions: categoryOptions,
      cardProductKindLabel: productKind || '全部一级品项',
      cardCategoryLabel: categoryOptions.find((option) => option.value === categoryId)?.label || categoryOptions[0].label,
      hasTreatmentCardFilter: Boolean(productKind || categoryId || nameQuery),
    });
  },

  onCardProductKindChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value);
    const productKind = this.data.cardProductKindOptions[index]?.value || '';
    this.applyTreatmentCardFilters(this._allTreatmentCards, {
      productKind,
      categoryId: '',
      nameQuery: this.data.cardNameQuery,
    });
  },

  onCardCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value);
    const categoryId = this.data.cardCategoryOptions[index]?.value || '';
    this.applyTreatmentCardFilters(this._allTreatmentCards, { categoryId });
  },

  onCardNameChange(e: WechatMiniprogram.CustomEvent) {
    const detail = e.detail as unknown as string | { value?: string };
    const nameQuery = typeof detail === 'string' ? detail : detail?.value || '';
    this.applyTreatmentCardFilters(this._allTreatmentCards, { nameQuery });
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
      const formatted: GiftData = {
        promoOrders: (data?.promoOrders || []).map(o => ({
          ...o,
          paidAt: o.paidAt ? formatDateTime(o.paidAt) : o.paidAt,
          createdAt: formatDateTime(o.createdAt),
          items: (o.items || []).map(gi => {
            const gt = Number(gi.sessionCount || 0);
            const grm = Number(gi.remainingSessions || 0);
            const gpr = gi.paidSessions;
          return {
            ...gi,
            specName: normalizeSpecName(gi.productName, gi.specName),
            unit: gi.unit || '次',
            paidUnusedSessions: gpr == null ? grm : Math.max(0, Number(gpr) - Math.max(gt - grm, 0)),
            };
          }),
        })),
        giftItems: (data?.giftItems || []).map(g => {
          const ft = Number(g.sessionCount || 0);
          const frm = Number(g.remainingSessions || 0);
          const fpr = g.paidSessions;
          return {
            ...g,
            specName: normalizeSpecName(g.productName, g.specName),
            unit: g.unit || '次',
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

  // ===== Tab 5: 服务记录 =====
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
