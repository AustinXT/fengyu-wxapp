// packageCustomer/customer-detail/customer-detail.ts — 7-Tab 顾客详情
import { callStaffApi, StaffApiError } from '../../utils/cloud';
import { getCurrentStoreId, isManager } from '../../utils/role';
import { formatDateTime, formatDate, ORDER_TYPE_LABEL, formatDiscount } from '../../utils/formatters';
import { MemberLevelBadgeData, withMemberLevelBadgeClass } from '../../utils/member-level-badge';
import { collectSourceOrderRemarks, expandGroupServiceSessions, getTreatmentCardBusinessIdentity, groupTreatmentCards, SourceOrderRemark, sumGroupValue } from '../../utils/treatment-card-group';

const app = getApp<IAppOption>();

// ===== 数据接口 =====

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
  customerSource: string | null;
  promoterEmployeeId: string | null;
  promoterEmployeeName: string | null;
  inviterName: string | null;
  inviterPhone: string;
  invitedAt: string | null;
  customerType: string | null;
  spendingTier: string | null;
  monthlyActivity: string | null;
  customerStatus: string | null;
  birthday: string | null;
  occupation: string | null;
  isMarried: boolean | null;
  wechatName: string | null;
  totalConsumption: number;
  yearConsumption: number;
  totalActualConsumption: number;
  yearActualConsumption: number;
  storeName: string;
  skinType: string | null;
  focusAreas: string | null;
  skinIssue: string | null;
  wellnessPreference: string | null;
  isCrossStoreTemp: boolean;
  updatedAt: string;
  notes: string | null;
  pointsBalance: number;
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

interface StaffAction {
  name: string;
  subname?: string;
  staffWfId: string;
}

interface StaffListResponse {
  staffList: Array<{
    staffWfId: string;
    name: string;
    department?: string;
    storeId?: string;
  }>;
}

interface PromoterEmployeeCandidate {
  employeeId: string;
  name: string;
  phoneMasked: string;
  storeName: string;
}

interface ProfileFormState {
  promoterEmployeeId: string;
  promoterEmployeeName: string;
  customerSource: string;
  birthday: string;
  occupation: string;
  isMarried: '' | 'true' | 'false';
  skinIssue: string;
  wellnessPreference: string;
  isCrossStoreTemp: boolean;
}

interface ProfileChanges {
  promoterEmployeeId?: string | null;
  customerSource?: string | null;
  birthday?: string | null;
  occupation?: string | null;
  isMarried?: boolean | null;
  skinIssue?: string | null;
  wellnessPreference?: string | null;
  isCrossStoreTemp?: boolean;
  promoterEmployeeName?: string | null;
}

interface UpdateProfileResponse {
  updatedAt: string;
  changes: ProfileChanges;
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
  saleItemGroupId?: string | null;
  itemName: string;
  spec: string;
  remainingSessions: number;
  totalSessions: number;
  paidSessions: number | null;
  productType: string;
  unit?: string;
  storeId?: string;
  skuId?: string | null;
  itemDirection?: string;
  refSaleItemId?: string | null;
  /** 单次优惠后价（unit_real_price，应付口径；全额已付卡下=单次实付） */
  unitRealPrice?: string;
  /** 品项标签（product_categories.category_name 二级分类名） */
  category?: string;
  /** 品项标签色（product_categories.display_color，取父级一级行） */
  categoryColor?: string;
  /** 一级品项（product_categories.product_kind） */
  productKind?: string;
  /** 二级品项 ID（历史无分类卡为空） */
  categoryId?: string;
  /** 二级品项名称（保留 category 兼容字段） */
  categoryName?: string;
  quantity?: number;
  unitPrice?: string;
  saleAmount?: string;
  received?: string;
  pendingReceived?: string;
  expireDate?: string | null;
  remark?: string | null;
  salesCategory?: string | null;
  pickedUpQuantity?: number | null;
  orderRemark?: string | null;
}

interface PaidOrder {
  saleOrderId: string;
  status: string;
  saleOrderDatetime?: string | null;
  paidAt: string;
  totalReceived: string;
  storeId?: string;
  storeName?: string;
  /** 单据类型（sale_orders.sale_order_type：销售单/内部单/转换单/寄存单/充值单） */
  saleOrderType?: string;
  documentType?: string | null;
  marketName?: string;
  legacySource?: string | null;
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

const CUSTOMER_SOURCE_OPTIONS = [
  { value: '', label: '未设置' },
  { value: '美团', label: '美团' },
  { value: '抖音', label: '抖音' },
  { value: '小程序', label: '小程序' },
  { value: '推广部', label: '推广部' },
  { value: '全员地推', label: '全员地推' },
  { value: '外请团队拓客', label: '外请团队拓客' },
  { value: '老带新', label: '老带新' },
  { value: '转让店', label: '转让店' },
  { value: '自进店', label: '自进店' },
  { value: '员工或家属', label: '员工或家属' },
];

const MARRIAGE_OPTIONS = [
  { value: '', label: '未设置' },
  { value: 'false', label: '未婚' },
  { value: 'true', label: '已婚' },
];

function emptyProfileForm(): ProfileFormState {
  return {
    promoterEmployeeId: '',
    promoterEmployeeName: '',
    customerSource: '',
    birthday: '',
    occupation: '',
    isMarried: '',
    skinIssue: '',
    wellnessPreference: '',
    isCrossStoreTemp: false,
  };
}

// Tab 3: 持卡汇总
interface TreatmentCard {
  saleItemId: string;
  saleItemGroupId?: string | null;
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
  unit: string;
  storeId?: string;
  orderStoreId?: string;
  storeName?: string;
  saleOrderDatetime?: string | null;
  orderStatus?: string;
  saleOrderType?: string;
  documentType?: string | null;
  marketName?: string;
  legacySource?: string | null;
  skuId?: string | null;
  itemDirection?: string;
  refSaleItemId?: string | null;
  /** NULL 卡（paid_sessions 为 null 的历史卡）置 true：灰显不可核销 */
  disabled?: boolean;
  disabledReason?: string;
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
  quantity?: number;
  unitPrice?: string;
  saleAmount?: string;
  received?: string;
  pendingReceived?: string;
  expireDate?: string | null;
  remark?: string | null;
  salesCategory?: string | null;
  pickedUpQuantity?: number | null;
  orderRemark?: string | null;
  groupKey?: string;
  cardCount?: number;
  sourceItems?: TreatmentCard[];
  sourceOrderRemarks?: SourceOrderRemark[];
}

interface CardFilterOption {
  value: string;
  label: string;
}

interface HomeProduct {
  saleItemId: string;
  saleOrderId: string;
  productName: string;
  unit: string;
  purchasedQuantity: number;
  paidQuantity: number;
  pickedQuantity: number;
  refundedQuantity: number;
  /** 已通过转换单折抵转走的数量（#125，与已退款分列） */
  convertedQuantity: number;
  remainingQuantity: number;
  pendingPickupQuantity: number;
  status: string;
  storeId: string;
  storeName: string | null;
  purchasedAt: string;
  purchasedAtFmt?: string;
  statusClass?: string;
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

// 顾客优惠券（customer.coupons 返回 + 前端预算展示字段）
interface CouponView {
  couponId: string;
  name: string;
  couponType: string;
  discountValue: number | string;
  minSpend: number | string | null;
  status: string;
  expireAt: string;
  usedAt: string | null;
  description: string | null;
  applicableStoreNames: string[] | null;
  applicableCategoryNames: string[] | null;
  // 前端预算展示字段
  applicableStoreNamesText: string;
  discountLabel: string;
  expireAtFmt: string;
  usedAtFmt: string;
  minSpendNum: number;
  minSpendHint: string;
}

// ===== 页面逻辑 =====

Page({
  data: {
    loading: false,
    customer: null as CustomerDetail | null,
    isManager: false,
    activeTab: 0,
    tabTitles: ['基本档案', '消费记录', '疗程卡', '家居产品', '预约记录', '服务记录', '顾客优惠券', '手机号变更', '日历'],
    // Tab 0: 详情（客户信息）
    notesValue: '',
    notesDirty: false,
    notesSaving: false,
    profileSaving: false,
    showAssignSheet: false,
    staffActions: [] as StaffAction[],
    showProfileEditor: false,
    profileForm: emptyProfileForm(),
    customerSourceOptions: CUSTOMER_SOURCE_OPTIONS,
    customerSourceLabel: '未设置',
    marriageOptions: MARRIAGE_OPTIONS,
    marriageLabel: '未设置',
    promoterSearchKeyword: '',
    promoterSearchLoading: false,
    promoterCandidates: [] as PromoterEmployeeCandidate[],
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
    homeProducts: [] as HomeProduct[],
    homeProductsLoaded: false,
    selectedCount: 0,
    cardProductKind: '',
    cardCategoryId: '',
    cardNameQuery: '',
    cardProductKindOptions: [] as CardFilterOption[],
    cardCategoryOptions: [] as CardFilterOption[],
    cardProductKindLabel: '全部一级品项',
    cardCategoryLabel: '全部二级品项',
    hasTreatmentCardFilter: false,
    // Tab 4: 服务记录
    serviceRecords: [] as ServiceRecord[],
    serviceLoaded: false,
    // 预约记录
    appointmentRecords: [] as AppointmentRecord[],
    appointmentsLoaded: false,
    // 手机号变更
    phoneChangeRecords: [] as PhoneChangeRecord[],
    phoneLoaded: false,
    // 顾客优惠券
    coupons: [] as CouponView[],
    filteredCoupons: [] as CouponView[],
    couponsLoaded: false,
    couponStatus: '' as string,
    couponStatusOptions: [
      { value: '', label: '全部' },
      { value: '未使用', label: '未使用' },
      { value: '已使用', label: '已使用' },
      { value: '已过期', label: '已过期' },
    ],
    // Wave 3G — 储值卡余额（跨店统一，仅店长视角）
    cardBalance: 0 as number,
    cardBalanceLoaded: false as boolean,
  },

  _query: null as CustomerQuery | null,
  _loaded: false,
  _allTreatmentCards: [] as TreatmentCard[],
  _profileOriginal: null as ProfileChanges | null,

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
    const canManage = isManager();
    this.setData({ isManager: canManage });
    if (!canManage) {
      this.setData({ cardBalance: 0, cardBalanceLoaded: false });
    }
    if (this._loaded && this._query) {
      this.loadCustomer();
      // 刷新已加载的 tab 数据（疗程卡次数可能因服务单完成而变化）
      if (this.data.cardsLoaded) {
        this.setData({ cardsLoaded: false });
        this.loadTreatmentCards();
      }
      if (this.data.homeProductsLoaded) {
        this.setData({ homeProductsLoaded: false });
        this.loadHomeProducts();
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
      if (customer.birthday) customer.birthday = customer.birthday.slice(0, 10);
      if (customer.invitedAt) customer.invitedAt = formatDateTime(customer.invitedAt);
      const canManage = isManager();
      this.setData({
        customer: withMemberLevelBadgeClass(customer),
        notesValue: customer.notes || '',
        notesDirty: false,
        isManager: canManage,
        cardBalance: 0,
        cardBalanceLoaded: false,
      });
      // 储值卡余额接口仅供当前门店有效店长使用，避免普通员工触发无权限请求。
      if (canManage) void this.loadCardBalance();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * Wave 3G — 加载顾客储值卡余额（跨店统一）
   * - 仅当前门店有效店长且 customer.clientUserId 存在时调用
   * - 请求失败不以余额 0 代替，避免将权限错误伪装为业务余额
   */
  async loadCardBalance() {
    if (!isManager()) {
      this.setData({ cardBalance: 0, cardBalanceLoaded: false });
      return;
    }
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
      this.setData({ cardBalanceLoaded: false });
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number;
    this.selectTab(index);
  },

  selectTab(index: number) {
    this.setData({ activeTab: index });
    // 9-Tab：0 基本档案 / 1 消费记录 / 2 疗程卡 / 3 家居产品 / 4 预约记录 /
    //         5 服务记录 / 6 顾客优惠券 / 7 手机号变更 / 8 日历
    if (index === 1 && !this.data.purchaseLoaded) {
      this.loadPurchaseHistory();
    } else if (index === 2 && !this.data.cardsLoaded) {
      this.loadTreatmentCards();
    } else if (index === 3 && !this.data.homeProductsLoaded) {
      this.loadHomeProducts();
    } else if (index === 4 && !this.data.appointmentsLoaded) {
      this.loadAppointments();
    } else if (index === 5 && !this.data.serviceLoaded) {
      this.loadServiceHistory();
    } else if (index === 6 && !this.data.couponsLoaded) {
      this.loadCoupons();
    } else if (index === 7 && !this.data.phoneLoaded) {
      this.loadPhoneChangeLogs();
    } else if (index === 8 && !this.data.calendarLoaded) {
      this.loadCalendar();
    }
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.tabTitles.length) return;
    this.selectTab(index);
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
          const isNullCard = item.paidSessions == null;
          const paid = isNullCard ? 0 : Number(item.paidSessions);
          const used = Math.max(total - remain, 0);
          const paidUnused = Math.max(paid - used, 0);
          const unpaid = Math.max(total - paid, 0);
          const consumable = Math.max(0, Math.min(remain, paid - used));
          // D6=A：paid_sessions=0 或 已用满已付 → 整张卡锁死，不显示
          // NULL 卡（0040 前未回填的历史卡）：保留但 disabled 灰显不可核销
          if (!isNullCard && consumable <= 0) continue;
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
            saleOrderDatetime: order.saleOrderDatetime,
            orderStatus: order.status,
            paidAt: order.paidAt,
            saleOrderType: order.saleOrderType,
            documentType: order.documentType,
            marketName: order.marketName,
            legacySource: order.legacySource,
            orderStoreId: order.storeId,
            storeName: order.storeName,
            storeId: item.storeId,
            skuId: item.skuId,
            itemDirection: item.itemDirection,
            refSaleItemId: item.refSaleItemId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            saleAmount: item.saleAmount,
            received: item.received,
            pendingReceived: item.pendingReceived,
            expireDate: item.expireDate,
            remark: item.remark,
            salesCategory: item.salesCategory,
            pickedUpQuantity: item.pickedUpQuantity,
            unitRealPrice: item.unitRealPrice,
            unit: item.unit || '次',
            category: item.category,
            categoryColor: item.categoryColor,
            productKind: item.productKind || '',
            categoryId: item.categoryId || '',
            categoryName: item.categoryName || item.category || '',
            saleOrderTypeLabel: ORDER_TYPE_LABEL[order.saleOrderType || ''] || order.saleOrderType || '',
            selected: false,
            sessionCount: 1,
            disabled: isNullCard,
            disabledReason: isNullCard ? '历史卡未回填,不可核销' : '',
          });
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
      const groupedCards = groupTreatmentCards(cards, {
        getId: (card) => card.saleItemId,
        getQuantity: (card) => card.quantity,
        getIdentity: (card) => getTreatmentCardBusinessIdentity(card),
      }).map((group) => {
        const primary = group.primary;
        const totalSessions = sumGroupValue(group, (card) => card.totalSessions);
        const remainingSessions = sumGroupValue(group, (card) => card.remainingSessions);
        const paidSessions = primary.paidSessions === null
          ? null
          : sumGroupValue(group, (card) => card.paidSessions);
        const usedSessions = sumGroupValue(group, (card) => card.usedSessions);
        const paidUnusedSessions = sumGroupValue(group, (card) => card.paidUnusedSessions);
        const unpaidSessions = paidSessions === null ? totalSessions : Math.max(totalSessions - paidSessions, 0);
        const pct = (value: number) => totalSessions > 0 ? Math.round((value / totalSessions) * 1000) / 10 : 0;
        return {
          ...primary,
          saleItemId: group.groupKey,
          groupKey: group.groupKey,
          sourceItems: group.sourceItems,
          cardCount: group.cardCount,
          sourceOrderRemarks: collectSourceOrderRemarks(group.sourceItems),
          quantity: sumGroupValue(group, (card) => card.quantity ?? 1),
          totalSessions,
          remainingSessions,
          paidSessions,
          consumableSessions: sumGroupValue(group, (card) => card.consumableSessions),
          usedSessions,
          paidUnusedSessions,
          usedPct: pct(usedSessions),
          paidUnusedPct: pct(paidUnusedSessions),
          unpaidPct: pct(unpaidSessions),
          selected: false,
          sessionCount: 1,
        };
      });
      this.applyTreatmentCardFilters(groupedCards, {
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
      selectedCount: cards.filter((card) => card.selected).length,
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

  async loadHomeProducts() {
    const id = this._clientId();
    if (!id) return;
    try {
      const rows = await callStaffApi<HomeProduct[]>('customer.homeProducts', id) || [];
      const statusClassMap: Record<string, string> = {
        退款处理中: 'pending',
        待提货: 'pending',
        部分提货: 'progress',
        已提货: 'success',
        已完成: 'done',
      };
      this.setData({
        homeProducts: rows.map((item) => ({
          ...item,
          purchasedAtFmt: item.purchasedAt ? formatDate(item.purchasedAt) : '',
          statusClass: statusClassMap[item.status] || 'done',
        })),
        homeProductsLoaded: true,
      });
    } catch (_) {
      this.setData({ homeProducts: [], homeProductsLoaded: true });
    }
  },

  onToggleCard(e: WechatMiniprogram.TouchEvent) {
    const saleItemId = e.currentTarget.dataset.saleItemId as string;
    const card = this._allTreatmentCards.find((item) => item.saleItemId === saleItemId);
    // NULL 历史卡：disabled 灰显，拦截核销并提示
    if (card?.disabled) {
      wx.showToast({ title: card.disabledReason || '历史卡未回填,不可核销', icon: 'none' });
      return;
    }
    if (!card) return;
    const newSelected = !card.selected;
    const cards = this._allTreatmentCards.map((item) =>
      item.saleItemId === saleItemId
        ? { ...item, selected: newSelected, sessionCount: newSelected ? item.sessionCount : 1 }
        : item,
    );
    this.applyTreatmentCardFilters(cards);
  },

  onStepperChange(e: WechatMiniprogram.CustomEvent) {
    const saleItemId = e.currentTarget.dataset.saleItemId as string;
    const target = this._allTreatmentCards.find((item) => item.saleItemId === saleItemId);
    const max = Math.max(1, Number(target?.consumableSessions || 1));
    const sessionCount = Math.max(1, Math.min(Number(e.detail) || 1, max));
    const cards = this._allTreatmentCards.map((item) =>
      item.saleItemId === saleItemId ? { ...item, sessionCount } : item,
    );
    this.applyTreatmentCardFilters(cards);
  },

  preventBubble() {},

  onCreateService() {
    const { customer } = this.data;
    if (!customer) return;
    const selected = this._allTreatmentCards.filter(c => c.selected);
    if (selected.length === 0) return;
    const preloadItems: Array<{
      saleItemId: string;
      itemName: string;
      spec: string;
      saleOrderId: string;
      sessionCount: number;
      remainingSessions: number;
      unit?: string;
      orderRemark?: string | null;
    }> = [];
    for (const card of selected) {
      const sourceItems = card.sourceItems?.length ? card.sourceItems : [card];
      const expanded = expandGroupServiceSessions(
        {
          groupKey: card.groupKey || card.saleItemId,
          primary: card,
          sourceItems,
          cardCount: card.cardCount || 1,
        },
        card.sessionCount,
        (item) => item.saleItemId,
        (item) => item.consumableSessions,
      );
      for (const selection of expanded) {
        const source = sourceItems.find((item) => item.saleItemId === selection.saleItemId) || card;
        preloadItems.push({
          saleItemId: selection.saleItemId,
          itemName: source.itemName,
          spec: source.spec,
          saleOrderId: source.saleOrderId,
          sessionCount: selection.sessionUsed,
          remainingSessions: source.remainingSessions,
          unit: source.unit,
          orderRemark: source.orderRemark || null,
        });
      }
    }
    if (preloadItems.length === 0) return;
    app.globalData._serviceCreatePreload = {
      customer: {
        id: customer.clientUserId || customer.id || '',
        name: customer.name,
        phone: customer.phone,
        clientUserId: customer.clientUserId || undefined,
      },
      items: preloadItems,
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
      const rows = (await callStaffApi<PhoneChangeRecord[]>('customer.phoneChangeLogs', {
        clientUserId: id,
        page: 1,
        pageSize: 50,
      }) || [])
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

  // ===== 顾客优惠券 =====
  async loadCoupons() {
    const id = this._clientId();
    if (!id) return;
    try {
      const res = await callStaffApi<{ coupons: CouponView[] }>('customer.coupons', id);
      const coupons = this._decorateCoupons(res?.coupons || []);
      this.setData({
        coupons,
        filteredCoupons: this._filterCoupons(coupons, this.data.couponStatus),
        couponsLoaded: true,
      });
    } catch (_) {
      this.setData({ coupons: [], filteredCoupons: [], couponsLoaded: true });
    }
  },

  onCouponStatusTap(e: WechatMiniprogram.TouchEvent) {
    const value = (e.currentTarget.dataset.value as string) ?? '';
    this.setData({
      couponStatus: value,
      filteredCoupons: this._filterCoupons(this.data.coupons, value),
    });
  },

  /** 按 couponStatus 客户端过滤（'' = 全部），一次加载全量、切状态不重新请求 */
  _filterCoupons(list: CouponView[], status: string): CouponView[] {
    return status ? list.filter((c) => c.status === status) : list;
  },

  /** 预算展示字段（discountLabel/expireAtFmt/usedAtFmt/minSpendHint），镜像 client my-coupons.ts */
  _decorateCoupons(list: CouponView[]): CouponView[] {
    return list.map((c) => {
      const minSpendNum = Number(c.minSpend) || 0;
      const hasCategory = Array.isArray(c.applicableCategoryNames) && c.applicableCategoryNames.length > 0;
      const minSpendHint = minSpendNum > 0
        ? (hasCategory
            ? `仅限 ${(c.applicableCategoryNames || []).join('/')} 品类小计满 ${minSpendNum} 元可用`
            : `满 ${minSpendNum} 元可用`)
        : '';
      return {
        ...c,
        applicableStoreNamesText: (c.applicableStoreNames || []).join('、'),
        expireAtFmt: formatDate(c.expireAt),
        usedAtFmt: c.usedAt ? formatDate(c.usedAt) : '',
        discountLabel: formatDiscount(c),
        minSpendNum,
        minSpendHint,
      };
    });
  },

  // ===== 基本档案编辑（仅当前门店有效店长） =====
  _profileValuesFromCustomer(customer: CustomerDetail): ProfileChanges {
    return {
      promoterEmployeeId: customer.promoterEmployeeId || null,
      customerSource: customer.customerSource || null,
      birthday: customer.birthday || null,
      occupation: customer.occupation || null,
      isMarried: customer.isMarried,
      skinIssue: customer.skinIssue || null,
      wellnessPreference: customer.wellnessPreference || null,
      isCrossStoreTemp: customer.isCrossStoreTemp === true,
    };
  },

  onOpenProfileEditor() {
    if (!isManager() || this.data.profileSaving) return;
    const { customer } = this.data;
    if (!customer?.clientUserId || !customer.updatedAt) return;

    this._profileOriginal = this._profileValuesFromCustomer(customer);
    const sourceIndex = CUSTOMER_SOURCE_OPTIONS.findIndex((item) => item.value === (customer.customerSource || ''));
    const marriageValue = customer.isMarried === true ? 'true' : customer.isMarried === false ? 'false' : '';
    const marriageIndex = MARRIAGE_OPTIONS.findIndex((item) => item.value === marriageValue);
    this.setData({
      showProfileEditor: true,
      profileForm: {
        promoterEmployeeId: customer.promoterEmployeeId || '',
        promoterEmployeeName: customer.promoterEmployeeName || '',
        customerSource: customer.customerSource || '',
        birthday: customer.birthday || '',
        occupation: customer.occupation || '',
        isMarried: marriageValue,
        skinIssue: customer.skinIssue || '',
        wellnessPreference: customer.wellnessPreference || '',
        isCrossStoreTemp: customer.isCrossStoreTemp === true,
      },
      customerSourceLabel: CUSTOMER_SOURCE_OPTIONS[sourceIndex >= 0 ? sourceIndex : 0].label,
      marriageLabel: MARRIAGE_OPTIONS[marriageIndex >= 0 ? marriageIndex : 0].label,
      promoterSearchKeyword: '',
      promoterCandidates: [],
      promoterSearchLoading: false,
    });
  },

  onCloseProfileEditor() {
    if (this.data.profileSaving) return;
    this._profileOriginal = null;
    this.setData({
      showProfileEditor: false,
      promoterSearchKeyword: '',
      promoterCandidates: [],
      promoterSearchLoading: false,
    });
  },

  onProfileTextChange(e: WechatMiniprogram.CustomEvent) {
    const field = String(e.currentTarget.dataset.field || '') as 'occupation' | 'skinIssue' | 'wellnessPreference';
    if (!['occupation', 'skinIssue', 'wellnessPreference'].includes(field)) return;
    this.setData({
      profileForm: { ...this.data.profileForm, [field]: String(e.detail || '') },
    });
  },

  onCustomerSourceChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value) || 0;
    const selected = CUSTOMER_SOURCE_OPTIONS[index] || CUSTOMER_SOURCE_OPTIONS[0];
    this.setData({
      profileForm: { ...this.data.profileForm, customerSource: selected.value },
      customerSourceLabel: selected.label,
    });
  },

  onBirthdayChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({
      profileForm: { ...this.data.profileForm, birthday: String(e.detail.value || '') },
    });
  },

  onClearBirthday() {
    this.setData({
      profileForm: { ...this.data.profileForm, birthday: '' },
    });
  },

  onMarriageChange(e: WechatMiniprogram.CustomEvent) {
    const index = Number(e.detail.value) || 0;
    const selected = MARRIAGE_OPTIONS[index] || MARRIAGE_OPTIONS[0];
    this.setData({
      profileForm: { ...this.data.profileForm, isMarried: selected.value as '' | 'true' | 'false' },
      marriageLabel: selected.label,
    });
  },

  onCrossStoreTempChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({
      profileForm: { ...this.data.profileForm, isCrossStoreTemp: e.detail as unknown as boolean },
    });
  },

  onPromoterKeywordChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ promoterSearchKeyword: String(e.detail || '') });
  },

  async onSearchPromoterEmployees() {
    if (!isManager() || this.data.promoterSearchLoading) return;
    const { customer, promoterSearchKeyword } = this.data;
    if (!customer?.clientUserId) return;
    const keyword = promoterSearchKeyword.trim();
    if (keyword.length < 2) {
      wx.showToast({ title: '请输入至少2个字符', icon: 'none' });
      return;
    }

    this.setData({ promoterSearchLoading: true });
    try {
      const candidates = await callStaffApi<PromoterEmployeeCandidate[]>('customer.searchPromoterEmployees', {
        clientUserId: customer.clientUserId,
        keyword,
      });
      this.setData({ promoterCandidates: candidates || [] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '搜索失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ promoterSearchLoading: false });
    }
  },

  onSelectPromoterEmployee(e: WechatMiniprogram.BaseEvent) {
    const employeeId = String(e.currentTarget.dataset.id || '');
    const selected = this.data.promoterCandidates.find((item) => item.employeeId === employeeId);
    if (!selected) return;
    this.setData({
      profileForm: {
        ...this.data.profileForm,
        promoterEmployeeId: selected.employeeId,
        promoterEmployeeName: selected.name,
      },
      promoterSearchKeyword: '',
      promoterCandidates: [],
    });
  },

  onClearPromoterEmployee() {
    this.setData({
      profileForm: {
        ...this.data.profileForm,
        promoterEmployeeId: '',
        promoterEmployeeName: '',
      },
      promoterSearchKeyword: '',
      promoterCandidates: [],
    });
  },

  async onSaveProfile() {
    if (!isManager() || this.data.profileSaving) return;
    const { customer, profileForm } = this.data;
    if (!customer?.clientUserId || !customer.updatedAt || !this._profileOriginal) return;

    const marriageValue = profileForm.isMarried === 'true'
      ? true
      : profileForm.isMarried === 'false'
        ? false
        : null;
    const current: ProfileChanges = {
      promoterEmployeeId: profileForm.promoterEmployeeId || null,
      customerSource: profileForm.customerSource || null,
      birthday: profileForm.birthday || null,
      occupation: profileForm.occupation.trim() || null,
      isMarried: marriageValue,
      skinIssue: profileForm.skinIssue.trim() || null,
      wellnessPreference: profileForm.wellnessPreference.trim() || null,
      isCrossStoreTemp: profileForm.isCrossStoreTemp,
    };
    const changes: ProfileChanges = {};
    for (const key of Object.keys(current) as Array<keyof ProfileChanges>) {
      if (JSON.stringify(current[key]) !== JSON.stringify(this._profileOriginal[key])) {
        (changes as Record<string, unknown>)[key] = current[key];
      }
    }
    if (Object.keys(changes).length === 0) {
      this.onCloseProfileEditor();
      return;
    }

    this.setData({ profileSaving: true });
    try {
      const result = await callStaffApi<UpdateProfileResponse>('customer.updateProfile', {
        clientUserId: customer.clientUserId,
        expectedUpdatedAt: customer.updatedAt,
        changes,
      });
      const mergedCustomer = {
        ...customer,
        ...result.changes,
        updatedAt: result.updatedAt,
      } as CustomerDetail;
      this._profileOriginal = null;
      this.setData({
        customer: mergedCustomer,
        showProfileEditor: false,
        promoterCandidates: [],
        promoterSearchKeyword: '',
      });
      wx.showToast({ title: '基本档案已更新', icon: 'success' });
    } catch (err: unknown) {
      const apiError = err as StaffApiError;
      const msg = err instanceof Error ? err.message : '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
      if (apiError.errorType === 'CONFLICT') {
        this._profileOriginal = null;
        this.setData({ showProfileEditor: false });
        await this.loadCustomer();
      }
    } finally {
      this.setData({ profileSaving: false });
    }
  },

  onEditCustomerName() {
    if (!isManager() || this.data.profileSaving) return;
    const { customer } = this.data;
    if (!customer?.clientUserId) return;

    wx.showModal({
      title: '修改顾客姓名',
      content: customer.name || '',
      editable: true,
      placeholderText: '请输入顾客姓名',
      confirmColor: '#C0322A',
      success: (res) => {
        if (res.confirm) void this.saveCustomerName(res.content);
      },
    });
  },

  async saveCustomerName(name: string) {
    if (!isManager() || this.data.profileSaving) return;
    const { customer } = this.data;
    if (!customer?.clientUserId) return;

    const trimmed = String(name || '').trim();
    if (!trimmed) {
      wx.showToast({ title: '顾客姓名不能为空', icon: 'none' });
      return;
    }
    if (trimmed.length > 50) {
      wx.showToast({ title: '顾客姓名不能超过50个字符', icon: 'none' });
      return;
    }
    if (trimmed === customer.name) return;

    this.setData({ profileSaving: true });
    try {
      const result = await callStaffApi<{ message: string; name: string }>('customer.updateName', {
        clientUserId: customer.clientUserId,
        name: trimmed,
      });
      this.setData({
        customer: { ...customer, name: result.name || trimmed },
      });
      wx.showToast({ title: '顾客姓名已更新', icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '修改失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ profileSaving: false });
    }
  },

  async onEditPreferredStaff() {
    if (!isManager() || this.data.profileSaving) return;
    if (!this.data.customer?.clientUserId) return;

    if (this.data.staffActions.length === 0) {
      try {
        const response = await callStaffApi<StaffListResponse>('staff.list');
        const currentStoreId = getCurrentStoreId();
        const staffActions = (response?.staffList || [])
          // 顾客长期归属只允许绑定本店员工；外店支援员工仅用于当次开单/服务。
          .filter((staff) => Boolean(staff.staffWfId)
            && (!currentStoreId || !staff.storeId || staff.storeId === currentStoreId))
          .map((staff) => ({
            name: staff.name,
            subname: staff.department || undefined,
            staffWfId: staff.staffWfId,
          }));
        this.setData({ staffActions });
      } catch (_) {
        wx.showToast({ title: '获取美容师列表失败', icon: 'none' });
        return;
      }
    }

    if (this.data.staffActions.length === 0) {
      wx.showToast({ title: '当前门店暂无可选美容师', icon: 'none' });
      return;
    }
    this.setData({ showAssignSheet: true });
  },

  onAssignClose() {
    this.setData({ showAssignSheet: false });
  },

  async onAssignSelect(e: WechatMiniprogram.CustomEvent) {
    if (!isManager() || this.data.profileSaving) {
      this.setData({ showAssignSheet: false });
      return;
    }
    const action = e.detail as StaffAction;
    const { customer } = this.data;
    if (!action?.staffWfId || !customer?.clientUserId) return;

    this.setData({ showAssignSheet: false, profileSaving: true });
    try {
      const result = await callStaffApi<{ message: string; employeeName: string }>('customer.assign', {
        clientUserId: customer.clientUserId,
        employeeId: action.staffWfId,
      });
      this.setData({
        customer: { ...customer, preferredStaffName: result.employeeName },
      });
      wx.showToast({ title: `已指定${result.employeeName}`, icon: 'success' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '修改失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ profileSaving: false });
    }
  },

  // ===== 备注编辑 =====
  onNotesChange(e: WechatMiniprogram.CustomEvent) {
    if (!isManager()) return;
    const val = e.detail as unknown as string;
    this.setData({
      notesValue: val,
      notesDirty: val !== (this.data.customer?.notes || ''),
    });
  },

  async onSaveNotes() {
    if (!isManager()) return;
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
