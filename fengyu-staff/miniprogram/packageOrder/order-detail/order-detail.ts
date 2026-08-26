// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager, getCurrentStoreId, getStaffWfId, isManagementMode } from '../../utils/role';
import { STATUS_CLASS, ORDER_TYPE_LABEL, formatDateTime, formatDate } from '../../utils/formatters';
import { getTreatmentCardBusinessIdentity, groupTreatmentCards, sumGroupValue } from '../../utils/treatment-card-group';

const PAY_TYPE_LABEL: Record<string, string> = {
  wechat: '微信支付',
  offline: '线下收款',
};

function addCalendarDays(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}


// ===== API 原始类型（snake_case） =====

interface RawOrder {
  sale_order_id: string;
  status: string;
  sale_order_type?: string;
  sale_order_datetime?: string;
  store_id?: string;
  store_name?: string;
  payment_method?: string;
  customer_name?: string;
  client_phone?: string;
  preferred_staff_name?: string;
  offline_confirmed_by?: string;
  offline_confirmed_at?: string;
  created_at?: string;
  paid_at?: string;
  performance_attribution_date?: string;
  performance_attribution_adjusted_at?: string | null;
  performance_attribution_adjusted_by?: string | null;
  performance_attribution_adjusted_by_name?: string | null;
  original_order_date?: string;
  min_performance_date?: string;
  max_performance_date?: string;
  updated_at?: string;
  total_amount?: string;
  // 2026-04-26 sale-order-domain-refactor: paid_amount 列已 DROP，改用 received / refunded_amount
  received?: string;
  refunded_amount?: string;
  prepaid_card_amount?: string;
  pending_prepaid_card_amount?: string;
  payable_amount?: string;
  first_payment_amount?: string | null;
  lakala_out_order_no?: string | null;
  opened_by?: string;
  refund_reason?: string;
  ref_sale_order_id?: string;
  // 详情扩展字段（云函数 order SELECT * + coupon_name/offline_confirmed_by_name 衍生）
  document_type?: string;
  market_name?: string;
  coupon_discount?: string;
  coupon_name?: string;
  points_used?: number | string;
  points_discount?: string;
  allocation_status?: string;
  legacy_source?: string;
  offline_confirmed_by_name?: string;
  allocatable?: boolean;
  is_activity?: boolean;
  is_experience_conversion?: boolean;
  remark?: string;
}

interface RawOrderItem {
  sale_item_id: string;
  sale_item_group_id?: string | null;
  sale_order_id?: string;
  sku_id?: string | null;
  item_direction?: string;
  ref_sale_item_id?: string | null;
  product_name?: string;
  product_type?: string;
  sale_amount?: string;
  received?: string;
  prepaid_card_received?: string;
  cash_received?: string;
  pending_received?: string;
  refunded_amount?: string;
  session_count?: number;
  unit?: string;
  remaining_sessions?: number;
  paid_sessions?: number | null;
  unit_price?: string;
  unit_real_price?: string;
  quantity?: number;
  overpay_refundable?: string | number | null;
  expire_date?: string;
  remark?: string | null;
  sales_category?: string;
  picked_up_quantity?: number;
}

interface RawPayment {
  id: number;
  change_type: string;
  amount: number;
  payment_method: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  note: string | null;
  allocation_status?: string | null;
}

interface DisplayPayment {
  id: number;
  changeType: string;
  amount: string;
  amountAbs: string;
  isRefund: boolean;
  paymentMethod: string;
  status: string;
  timeFmt: string;
  note: string;
}

interface OrderDetailResponse {
  order: RawOrder;
  items: RawOrderItem[];
  payments?: RawPayment[];
  /** 顾客储值卡余额（供回款弹层「使用储值卡抵扣」自动抵满；无账户=0，无顾客=null） */
  cardBalance?: number | null;
  /** 多收余数可退额（部分支付单 received 不能被单次价整除时的订单级孤儿零头） */
  overpayRefundable?: number | null;
}

// ===== 展示层类型（camelCase，用于 WXML 绑定） =====

interface DisplayOrderItem {
  saleItemId: string;
  saleItemGroupId: string | null;
  saleOrderId: string;
  skuId: string | null;
  itemDirection: string;
  refSaleItemId: string | null;
  productType: string;
  isTreatmentCard: boolean;
  itemName: string;
  spec: string;
  totalPrice: string;
  /** 行应付（sale_amount）/ 已收（received）/ 可回款（应付-已收），按子项回款用 */
  saleAmount: string;
  received: string;
  refundedAmount: string;
  isRefunded: boolean;
  repayable: string;
  sessionCount: number | undefined;
  unit: string;
  remainingSessions: number | undefined;
  paidSessions: number | undefined;
  /** 已用次数 = sessionCount - remainingSessions（0 兜底） */
  usedSessions: number;
  /** 已付未用次数 = max(paidSessions - usedSessions, 0) */
  paidUnusedSessions: number;
  /** 该商品子项自己的多收余数 */
  overpayRefundable: number;
  /** 三段进度条百分比（用于 WXML 内联 style） */
  remainPct: number;
  paidUnusedPct: number;
  unpaidPct: number;
  /** 详情扩展：销售分类 / 过期日期（formatDate 后，空串=无）/ 已提货数量（家居，0=不展示） */
  salesCategory: string;
  expireDate: string;
  pickedUpQuantity: number;
  /** 单次现价 / 原价 + 是否有折扣（原价划线展示） */
  unitRealPrice: string;
  unitPrice: string;
  hasDiscount: boolean;
  /** 行购买数量；疗程卡按张数。 */
  quantity: number;
  /** 聚合后的疗程卡张数，仅供展示。 */
  cardCount: number;
  pendingReceived: string;
  remark: string;
}

interface DisplayOrder {
  saleOrderId: string;
  status: string;
  storeId: string;
  storeName: string;
  orderType: string;
  orderTypeLabel: string;
  orderSourceLabel: string;
  refundReason: string;
  refOrderId: string;
  payType: string;
  payTypeLabel: string;
  customerName: string;
  customerPhone: string;
  customerPhoneMasked: string;
  preferredStaffName: string;
  confirmedBy: string;
  confirmedAt: string;
  createdAt: string;
  paidAt: string;
  originalOrderDate: string;
  performanceAttributionDate: string;
  performanceAttributionAdjusted: boolean;
  performanceAttributionAdjustedAt: string;
  performanceAttributionAdjustedByName: string;
  updatedAt: string;
  totalAmount: string;
  paidAmount: string;
  prepaidCardAmount: string;
  pendingPrepaidCardAmount: string;
  grossRemainingPayable: string;
  remainingPayable: string;
  hasDebt: boolean;
  hasActivePaymentCap: boolean;
  activePaymentAmount: string;
  canInitiateRepayment: boolean;
  canResumeOnlinePayment: boolean;
  canViewQrcode: boolean;
  /** 详情扩展：单据类型 / 所属市场 / 券名 / 券抵扣 / 分配状态 / 历史订单标记 */
  documentType: string;
  marketName: string;
  couponName: string;
  couponDiscount: string;
  pointsUsed: string;
  pointsDiscount: string;
  allocationStatus: string;
  isLegacy: boolean;
  isActivity: boolean;
  isExperienceConversion: boolean;
  remark: string;
  /** 原始逐项列表；退款、回款继续使用它，不能被展示聚合结果替代。 */
  items: DisplayOrderItem[];
  /** 仅订单明细区域使用的聚合展示列表。 */
  displayItems: DisplayOrderItem[];
  payments: DisplayPayment[];
  /** 多收余数可退额（0=无）；退款弹层据此展示「多收可退余数」选项 */
  overpayRefundable: string;
}

Page({
  data: {
    loading: false,
    order: null as DisplayOrder | null,
    isManager: false,
    isReadOnly: false,
    isCreator: false,
    statusClass: '',
    refundBadge: '',
    hasPendingRefund: false,
    _saleOrderId: '',
    // P2: 退款
    showRefundDialog: false,
    refundDialogScrollable: false,
    refundReason: '',
    // 退款明细多选（可选订单内若干项；疗程卡整卡退、不支持部分退次数）
    refundItemOptions: [] as Array<{ saleItemId: string; label: string; includeOverpay: boolean }>,
    refundSelectedIds: [] as string[],
    submitting: false,
    // Ticket 2026-05-21 按子项回款弹层（2026-06-24 重构：储值卡改独立抵扣勾选）
    showRepayPopup: false,
    // 每个购买子项一行：{ saleItemId, itemName, repayable, real(本次实付金额) }
    repayLines: [] as Array<{ saleItemId: string; itemName: string; repayable: string; real: string }>,
    repayMethod: '线下' as '线下' | '微信' | '支付宝',
    repayNote: '',
    // 储值卡抵扣：独立勾选，金额手填，默认 0.00
    repayUseCard: false,
    repayCardBalance: 0,
    repayCardAmountInput: '0.00',
    repayCardMax: '0.00',
    // 创建订单时已预选、尚待结算的储值卡金额：回款弹层必须固定带入，禁止再次选卡重复抵扣。
    repayCardLocked: false,
    repayPendingCardAmount: 0,
    // 本次回款意向幂等键（打开弹层生成一次，重试/误点复用，防重复扣卡；服务端据此作扣卡 external_ref）
    repayIdempKey: '',
    repayRealTotal: '0.00',
    repayCardDeduct: '0.00',
    // 需支付金额（线下=现金 / 微信支付宝=顾客扫码）= 实付合计 − 储值卡抵扣
    repayNeedPay: '0.00',
    // 当前订单欠款（弹层内引用）
    currentRemainingPayable: 0,
    attributionMinDate: '',
    attributionMaxDate: '',
    attributionSubmitting: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager(), isReadOnly: isManagementMode() });
    if (options.id) {
      this.setData({ _saleOrderId: options.id });
      this.loadDetail(options.id);
    }
  },

  onShow() {
    this.setData({
      isManager: isManager(),
      isReadOnly: this._isReadOnly(),
    });
  },

  _isReadOnly() {
    if (isManagementMode()) return true;
    const orderStoreId = this.data.order?.storeId || '';
    return !!orderStoreId && orderStoreId !== getCurrentStoreId();
  },

  async loadDetail(saleOrderId: string) {
    this.setData({ loading: true });
    try {
      const res = await callStaffApi<OrderDetailResponse>('order.detail', { saleOrderId });
      const o = res.order || {} as RawOrder;
      const items: DisplayOrderItem[] = (res.items || []).map((it) => {
        const sc = Number(it.session_count || 0);
        const rs = Number(it.remaining_sessions || 0);
        const ps = it.paid_sessions == null ? 0 : Number(it.paid_sessions);
        const used = Math.max(sc - rs, 0);
        const paidUnused = Math.max(ps - used, 0);
        const remain = rs;
        const unpaid = Math.max(sc - ps, 0);
        const pct = (n: number) => (sc > 0 ? Math.round((n / sc) * 1000) / 10 : 0);
        const saleAmt = Number(it.sale_amount || 0);
        const recv = Number(it.received || 0);
        const refunded = Number(it.refunded_amount || 0);
        const overpayRefundable = Math.max(0, Number(it.overpay_refundable || 0));
        // 已退行不可回款（行级口径，与 client/admin 一致）；received 为净额
        const repayable = refunded > 0 ? 0 : Math.max(0, Math.round((saleAmt - recv) * 100) / 100);
        return {
          saleItemId: it.sale_item_id,
          saleItemGroupId: it.sale_item_group_id || null,
          saleOrderId: it.sale_order_id || o.sale_order_id,
          skuId: it.sku_id || null,
          itemDirection: it.item_direction || '',
          refSaleItemId: it.ref_sale_item_id || null,
          productType: it.product_type || '',
          isTreatmentCard: it.product_type === '疗程卡',
          itemName: it.product_name || '—',
          spec: '',
          totalPrice: it.received || '0',
          saleAmount: saleAmt.toFixed(2),
          received: recv.toFixed(2),
          refundedAmount: refunded.toFixed(2),
          isRefunded: refunded > 0,
          repayable: repayable.toFixed(2),
          sessionCount: it.session_count,
          unit: it.unit || '次',
          remainingSessions: it.remaining_sessions,
          paidSessions: it.paid_sessions == null ? undefined : Number(it.paid_sessions),
          usedSessions: used,
          paidUnusedSessions: paidUnused,
          overpayRefundable,
          remainPct: pct(remain),
          paidUnusedPct: pct(paidUnused),
          unpaidPct: pct(unpaid),
          salesCategory: it.sales_category || '',
          // expire_date 是 pg date 列，必须 formatDate 避免 UTC 串偏移日期
          expireDate: it.expire_date ? formatDate(it.expire_date) : '',
          pickedUpQuantity: Number(it.picked_up_quantity || 0),
          unitRealPrice: Number(it.unit_real_price || 0).toFixed(2),
          unitPrice: Number(it.unit_price || 0).toFixed(2),
          hasDiscount: Number(it.unit_price || 0) > Number(it.unit_real_price || 0),
          quantity: Number(it.quantity || 1),
          cardCount: Number(it.quantity || 1),
          pendingReceived: Number(it.pending_received || 0).toFixed(2),
          remark: it.remark || '',
        };
      });

      // 疗程卡仅在完整业务快照一致时合并；非疗程商品始终按原始行隔离。
      // 退款与回款仍继续读取原始 items。
      const displayItems = groupTreatmentCards(items, {
        getId: (item) => item.saleItemId,
        getQuantity: (item) => item.quantity,
        preserveNonUnitQuantity: false,
        getIdentity: (item) => {
          const identity = getTreatmentCardBusinessIdentity(item);
          return item.isTreatmentCard ? identity : { ...identity, sourceId: item.saleItemId };
        },
      }).map((group) => {
        const primary = group.primary;
        const aggregate = {
          ...primary,
          quantity: sumGroupValue(group, (item) => item.quantity),
          cardCount: group.cardCount,
          totalPrice: sumGroupValue(group, (item) => item.totalPrice).toFixed(2),
          saleAmount: sumGroupValue(group, (item) => item.saleAmount).toFixed(2),
          received: sumGroupValue(group, (item) => item.received).toFixed(2),
          refundedAmount: sumGroupValue(group, (item) => item.refundedAmount).toFixed(2),
          repayable: sumGroupValue(group, (item) => item.repayable).toFixed(2),
          overpayRefundable: sumGroupValue(group, (item) => item.overpayRefundable),
          pickedUpQuantity: sumGroupValue(group, (item) => item.pickedUpQuantity),
          pendingReceived: sumGroupValue(group, (item) => item.pendingReceived).toFixed(2),
        };
        if (!primary.isTreatmentCard) return aggregate;

        const sessionCount = sumGroupValue(group, (item) => item.sessionCount);
        const remainingSessions = sumGroupValue(group, (item) => item.remainingSessions);
        const paidSessions = primary.paidSessions === undefined
          ? undefined
          : sumGroupValue(group, (item) => item.paidSessions);
        const usedSessions = sumGroupValue(group, (item) => item.usedSessions);
        const paidUnusedSessions = sumGroupValue(group, (item) => item.paidUnusedSessions);
        const unpaidSessions = paidSessions === undefined
          ? sessionCount
          : Math.max(sessionCount - paidSessions, 0);
        const pct = (value: number) => sessionCount > 0
          ? Math.round((value / sessionCount) * 1000) / 10
          : 0;

        return {
          ...aggregate,
          sessionCount,
          remainingSessions,
          paidSessions,
          usedSessions,
          paidUnusedSessions,
          overpayRefundable: sumGroupValue(group, (item) => item.overpayRefundable),
          remainPct: pct(remainingSessions),
          paidUnusedPct: pct(paidUnusedSessions),
          unpaidPct: pct(unpaidSessions),
          pickedUpQuantity: sumGroupValue(group, (item) => item.pickedUpQuantity),
          pendingReceived: sumGroupValue(group, (item) => item.pendingReceived).toFixed(2),
        };
      });

      // payments 流水：按 DB sale_order_payments 原样逐条展示
      // （储值卡抵扣/首次支付/回款/退款各自真实金额，不归并；同一次收款的现金行与卡行 paid_at 相同，
      // 用流水 id 作 wx:key 避免冲突）。历史归并方案有顺序依赖 bug（卡行先独立 push 又被现金行吸收 → 重复计算），已移除。
      const payments: DisplayPayment[] = (res.payments || []).map((p) => {
        const amt = Number(p.amount) || 0;
        const isRefund = amt < 0 || p.change_type === '退款';
        const timeSrc = p.paid_at || p.created_at;
        return {
          id: p.id,
          changeType: p.change_type,
          amount: amt.toFixed(2),
          amountAbs: Math.abs(amt).toFixed(2),
          isRefund,
          paymentMethod: p.payment_method,
          status: p.status,
          timeFmt: timeSrc ? formatDateTime(timeSrc) : '',
          note: p.note || '',
        };
      });
      // 退款入口守卫：该单已有「待审批/待支付」退款则隐藏「申请退款」按钮，防重复发起（对齐 admin order-detail-page.tsx）
      const hasPendingRefund = payments.some((p) => p.isRefund && (p.status === '待审批' || p.status === '待支付'));

      const totalAmount = Number(o.total_amount || 0);
      const actualPrepaidCardAmount = Number(o.prepaid_card_amount || 0);
      const pendingPrepaidCardAmount = Number(o.pending_prepaid_card_amount || 0);
      const prepaidCardAmount = (o.status === '待支付' || o.status === '支付失败')
        ? pendingPrepaidCardAmount
        : actualPrepaidCardAmount;
      // 2026-04-26 sale-order-domain-refactor: paid_amount 列已 DROP，净到账 = received - refunded_amount
      const received = Number(o.received || 0);
      const refundedAmount = Number(o.refunded_amount || 0);
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      const grossRemainingPayable = Math.max(0, Math.round((totalAmount - netReceived) * 100) / 100);
      // 现金待收 = total − netReceived − pendingPrepaid。
      // actual 储值卡已包含在 received，不能再扣；pending 尚未进入 received，需单独从本次现金欠款扣除。
      const remainingPayable = Math.max(0, Math.round((totalAmount - netReceived - pendingPrepaidCardAmount) * 100) / 100);
      // 销售单仍仅在部分支付后发起回款；普通转换单允许零首付形成的待支付欠款
      // 进入订单级回款。是否有欠款与是否允许新建支付意图分离：已有 cap 时保留欠款展示和二维码恢复入口。
      const orderType = o.sale_order_type || '';
      const frozenPaymentAmount = Number(o.first_payment_amount || 0);
      const hasActivePaymentCap = frozenPaymentAmount > 0 || !!String(o.lakala_out_order_no || '').trim();
      const hasRepayableStatus = (orderType === '销售单' && o.status === '部分支付')
        || (orderType === '转换单'
          && (o.status === '待支付' || o.status === '部分支付'));
      const hasDebt = hasRepayableStatus
        && remainingPayable > 0
        && !o.is_experience_conversion;
      const canInitiateRepayment = hasDebt && !hasActivePaymentCap;
      const canResumeOnlinePayment = orderType === '转换单'
        && (o.status === '待支付' || o.status === '部分支付')
        && hasActivePaymentCap
        && remainingPayable > 0
        && !o.is_experience_conversion;
      const canViewQrcode = o.status === '待支付' || canResumeOnlinePayment;
      const activePaymentAmount = hasActivePaymentCap
        ? Math.min(remainingPayable, frozenPaymentAmount > 0 ? frozenPaymentAmount : remainingPayable)
        : 0;
      const originalOrderDate = o.original_order_date
        || formatDate(o.sale_order_datetime)
        || formatDate(o.created_at);
      const attributionMinDate = o.min_performance_date
        || (originalOrderDate ? addCalendarDays(originalOrderDate, -7) : '');
      const attributionMaxDate = o.max_performance_date
        || (originalOrderDate ? addCalendarDays(originalOrderDate, 7) : '');
      const isReadOnly = isManagementMode()
        || (!!o.store_id && o.store_id !== getCurrentStoreId());

      this.setData({
        order: {
          saleOrderId: o.sale_order_id,
          status: o.status,
          storeId: o.store_id || '',
          storeName: o.store_name || '',
          orderType,
          orderTypeLabel: ORDER_TYPE_LABEL[orderType] || orderType,
          orderSourceLabel: o.opened_by ? '员工开单' : '顾客下单',
          refundReason: o.refund_reason || '',
          refOrderId: o.ref_sale_order_id || '',
          payType: o.payment_method || '',
          payTypeLabel: PAY_TYPE_LABEL[o.payment_method || ''] || o.payment_method || '—',
          customerName: o.customer_name || '',
          customerPhone: o.client_phone || '',
          customerPhoneMasked: o.client_phone ? o.client_phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '',
          preferredStaffName: o.preferred_staff_name || '',
          confirmedBy: o.offline_confirmed_by_name || o.offline_confirmed_by || '',
          confirmedAt: formatDateTime(o.offline_confirmed_at),
          createdAt: formatDateTime(o.created_at),
          paidAt: formatDateTime(o.paid_at),
          originalOrderDate,
          performanceAttributionDate: formatDate(o.performance_attribution_date),
          performanceAttributionAdjusted: !!o.performance_attribution_adjusted_at,
          performanceAttributionAdjustedAt: formatDateTime(o.performance_attribution_adjusted_at),
          performanceAttributionAdjustedByName: o.performance_attribution_adjusted_by_name
            || o.performance_attribution_adjusted_by
            || '',
          updatedAt: o.updated_at || '',
          totalAmount: totalAmount.toFixed(2),
          paidAmount: netReceived.toFixed(2),
          prepaidCardAmount: prepaidCardAmount.toFixed(2),
          pendingPrepaidCardAmount: pendingPrepaidCardAmount.toFixed(2),
          grossRemainingPayable: grossRemainingPayable.toFixed(2),
          remainingPayable: remainingPayable.toFixed(2),
          hasDebt,
          hasActivePaymentCap,
          activePaymentAmount: activePaymentAmount.toFixed(2),
          canInitiateRepayment,
          canResumeOnlinePayment,
          canViewQrcode,
          documentType: o.document_type || '',
          marketName: o.market_name || '',
          couponName: o.coupon_name || '',
          couponDiscount: Number(o.coupon_discount || 0) > 0 ? Number(o.coupon_discount).toFixed(2) : '',
          pointsUsed: Number(o.points_used || 0) > 0 ? String(Number(o.points_used || 0)) : '',
          pointsDiscount: Number(o.points_discount || 0) > 0 ? Number(o.points_discount).toFixed(2) : '',
          allocationStatus: o.allocation_status || '',
          isLegacy: o.legacy_source === 'workfine',
          isActivity: !!o.is_activity,
          isExperienceConversion: !!o.is_experience_conversion,
          remark: o.remark || '',
          items,
          displayItems,
          payments,
          overpayRefundable: Number(res.overpayRefundable || 0).toFixed(2),
        },
        currentRemainingPayable: remainingPayable,
        repayCardBalance: res.cardBalance != null ? Number(res.cardBalance) : 0,
        isCreator: o.opened_by === getStaffWfId(),
        statusClass: STATUS_CLASS[o.status] || 'pending',
        // 退款后状态角标（Bug B）：按 refunded_amount 派生「已退款/部分退款」，订单主状态不变（对齐 admin）
        refundBadge: refundedAmount > 0 && o.status !== '已退款'
          ? (refundedAmount >= received - 0.01 ? '已退款' : '部分退款')
          : '',
        hasPendingRefund,
        attributionMinDate,
        attributionMaxDate,
        isReadOnly,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPerformanceAttributionChange(e: WechatMiniprogram.PickerChange) {
    const targetDate = String(e.detail.value || '');
    const order = this.data.order;
    if (!order || this.data.attributionSubmitting || !this.data.isManager || this._isReadOnly()) return;
    if (!targetDate || targetDate === order.performanceAttributionDate) {
      wx.showToast({ title: '请选择不同于当前值的日期', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '确认修改业绩归属日期',
      content: `原始订单日期不会改变。确认将归属日期改为 ${targetDate}？成功后不能再次修改。`,
      confirmText: '确认修改',
      confirmColor: '#C0322A',
      success: (result) => {
        if (result.confirm) this._submitPerformanceAttributionDate(targetDate);
      },
    });
  },

  async _submitPerformanceAttributionDate(targetDate: string) {
    const order = this.data.order;
    if (!order || this.data.attributionSubmitting) return;
    this.setData({ attributionSubmitting: true });
    try {
      const result = await callStaffApi<{ message?: string }>('order.updatePerformanceAttribution', {
        saleOrderId: order.saleOrderId,
        performanceAttributionDate: targetDate,
        expectedUpdatedAt: order.updatedAt,
      });
      wx.showToast({ title: result.message || '归属日期已修改', icon: 'success' });
      await this.loadDetail(order.saleOrderId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '修改失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ attributionSubmitting: false });
    }
  },

  onResetFailed() {
    if (this._isReadOnly() || this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '重置支付',
      content: '确认将此订单重置为"待支付"状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('order.resetFailed', { saleOrderId });
          wx.showToast({ title: '已重置', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  onConfirmOffline() {
    if (this._isReadOnly() || this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('order.confirmOffline', { saleOrderId });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  onCloseOrder() {
    if (this._isReadOnly() || this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '取消订单',
      content: '确认取消该订单？取消后不可恢复。',
      confirmText: '确认取消',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('order.close', { saleOrderId });
          wx.showToast({ title: '订单已取消', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  onCreateService() {
    if (this._isReadOnly()) return;
    const saleOrderId = this.data._saleOrderId;
    wx.navigateTo({ url: `/packageService/service-create/service-create?saleOrderId=${saleOrderId}` });
  },

  onBackToWorkbench() {
    wx.switchTab({ url: '/pages/workbench/workbench' });
  },

  onShowQrcode() {
    if (this._isReadOnly()) return;
    const o = this.data.order;
    if (!o) return;
    const params = `saleOrderId=${o.saleOrderId}&customerName=${encodeURIComponent(o.customerName)}&totalAmount=${o.totalAmount}`;
    wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?${params}` });
  },

  // ===== 充值卡退款（充值单专用，走 card.createRefund）=====
  onCreateCardRefund() {
    if (this._isReadOnly()) return;
    const o = this.data.order;
    if (!o) return;
    wx.showModal({
      title: '充值卡退款',
      content: '确认发起充值卡退款？将退还卡内剩余余额（按该充值单实付比例线下退款），提交后需店长审批。',
      confirmText: '发起退款',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm || this._isReadOnly()) return;
        wx.showLoading({ title: '提交中', mask: true });
        try {
          await callStaffApi('card.createRefund', { saleOrderId: o.saleOrderId });
          wx.hideLoading();
          wx.showToast({ title: '退款申请已提交，等待审批', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } catch (err: unknown) {
          wx.hideLoading();
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        }
      },
    });
  },

  // ===== P2: 退款 =====
  onCreateRefund() {
    if (this._isReadOnly()) return;
    const o = this.data.order;
    if (!o) return;
    // 可退项：疗程卡按「已付未用次数」可退；行级多收余数随所属子项一起退，不再作为独立订单级选项。
    // 疗程卡整卡全退（不支持部分退次数），label 标注可退次数。
    const options = o.items
      .filter((it) => (it.sessionCount == null ? true : it.paidUnusedSessions > 0) || it.overpayRefundable > 0)
      .map((it) => ({
        saleItemId: it.saleItemId,
        label: [
          it.sessionCount == null
            ? it.itemName
            : `${it.itemName}（${it.paidUnusedSessions > 0 ? `整卡退 ${it.paidUnusedSessions} ${it.unit || '次'}` : '不退数量'}）`,
          it.overpayRefundable > 0 ? `含余数 ¥${it.overpayRefundable.toFixed(2)}` : '',
        ].filter(Boolean).join('，'),
        includeOverpay: it.overpayRefundable > 0,
      }));
    this.setData({
      showRefundDialog: true,
      refundDialogScrollable: options.length > 8,
      refundReason: '',
      refundItemOptions: options,
      refundSelectedIds: options.map((x) => x.saleItemId), // 默认全选
    });
  },

  onRefundReasonChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ refundReason: (e.detail as unknown as string) || '' });
  },

  onRefundItemsChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ refundSelectedIds: (e.detail as unknown as string[]) || [] });
  },

  async onConfirmRefund() {
    if (this._isReadOnly()) return;
    const { order, refundReason, refundSelectedIds, submitting } = this.data;
    if (submitting || !order) return;
    if (!refundReason?.trim()) {
      wx.showToast({ title: '请填写退款原因', icon: 'none' });
      return;
    }
    const optionById: Record<string, { includeOverpay: boolean }> = {};
    for (const opt of this.data.refundItemOptions) optionById[opt.saleItemId] = opt;
    const items = refundSelectedIds
      .map((saleItemId) => ({
        saleItemId,
        includeOverpay: !!optionById[saleItemId]?.includeOverpay,
      }));
    if (!items.length) {
      wx.showToast({ title: '请至少选择一个退款项', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 仅退选中项；不带 refundQuantity → 后端疗程卡强制整卡全退、家居退全部未提货
      await callStaffApi('order.createRefund', {
        refSaleOrderId: order.saleOrderId,
        items,
        refundReason: refundReason.trim(),
      });
      this.setData({ showRefundDialog: false, refundDialogScrollable: false });
      wx.showToast({ title: '退款申请已提交，等待审批', icon: 'success' });
      this.loadDetail(this.data._saleOrderId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onCancelRefund() {
    this.setData({
      showRefundDialog: false,
      refundDialogScrollable: false,
      refundReason: '',
      refundItemOptions: [],
      refundSelectedIds: [],
    });
  },

  // 退款审批已收口到 refund-list/refund-detail 页；原 onApproveRefund/onRejectRefund 传 saleOrderId（后端需 paymentId）
  // 且依赖恒不命中的 orderType==='退款单'，属死代码 + 传参错误，已删除（Bug D）。

  // ===== Ticket 2026-05-21：按子项发起回款 =====
  // 合计：实付合计 → 手填储值卡抵扣（上限 min(余额, 实付合计)）→ 需支付
  _recalcRepayTotals(lines: Array<{ real: string }>) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const realTotal = r2(lines.reduce((s, l) => s + (Number(l.real) || 0), 0));
    const lockedPendingCard = this.data.repayCardLocked
      ? r2(Math.max(0, this.data.repayPendingCardAmount))
      : 0;
    const cardMax = this.data.repayCardLocked
      ? lockedPendingCard
      : r2(Math.min(Math.max(0, this.data.repayCardBalance), Math.max(0, realTotal)));
    const requested = Number(this.data.repayCardAmountInput);
    const requestedAmount = Number.isFinite(requested) ? Math.max(0, requested) : 0;
    const cardDeduct = this.data.repayCardLocked
      ? lockedPendingCard
      : (this.data.repayUseCard ? r2(Math.min(requestedAmount, cardMax)) : 0);
    const needPay = r2(Math.max(0, realTotal - cardDeduct));
    this.setData({
      repayRealTotal: realTotal.toFixed(2),
      repayCardMax: cardMax.toFixed(2),
      repayCardDeduct: cardDeduct.toFixed(2),
      repayNeedPay: needPay.toFixed(2),
    });
  },

  onRepayTap() {
    if (this._isReadOnly()) return;
    const o = this.data.order;
    if (!o || !o.canInitiateRepayment) return;
    // 默认线下、每行实付 = 该行可回款额（操作员可改小或清零，不要求全额）
    const pendingCardAmount = o.orderType === '转换单'
      ? Number(o.pendingPrepaidCardAmount || 0)
      : 0;
    // 已有 pending 卡额尚未扣卡，必须把它作为本场固定组成部分：本场总额用
    // total-netReceived，卡额固定为 pending，现金/在线部分才是其差额。
    const conversionRepayable = pendingCardAmount > 0 ? o.grossRemainingPayable : o.remainingPayable;
    const lines = o.orderType === '转换单'
      ? [{ saleItemId: '__ORDER__', itemName: '转换单剩余欠款', repayable: conversionRepayable, real: conversionRepayable }]
      : (o.items || [])
        .filter((it) => Number(it.repayable) > 0)
        .map((it) => ({ saleItemId: it.saleItemId, itemName: it.itemName, repayable: it.repayable, real: it.repayable }));
    this.setData({
      showRepayPopup: true,
      repayLines: lines,
      repayMethod: '线下',
      repayNote: '',
      repayUseCard: pendingCardAmount > 0,
      repayCardAmountInput: pendingCardAmount.toFixed(2),
      repayCardMax: pendingCardAmount.toFixed(2),
      repayCardLocked: pendingCardAmount > 0,
      repayPendingCardAmount: pendingCardAmount,
      currentRemainingPayable: Number(conversionRepayable),
      repayIdempKey: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
    this._recalcRepayTotals(lines);
  },

  onCloseRepayPopup() {
    this.setData({ showRepayPopup: false });
  },

  // 子项实付金额输入：data-index 指定行
  onRepayLineChange(e: WechatMiniprogram.CustomEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const val = (e.detail as unknown as string) || '';
    const lines = this.data.repayLines.slice();
    if (!lines[idx]) return;
    lines[idx] = { ...lines[idx], real: val };
    this.setData({ repayLines: lines });
    this._recalcRepayTotals(lines);
  },

  onRepayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const val = e.currentTarget.dataset.method as '线下' | '微信' | '支付宝';
    if (!val || val === this.data.repayMethod) return;
    this.setData({ repayMethod: val });
    this._recalcRepayTotals(this.data.repayLines);
  },

  // 切换「使用储值卡抵扣」勾选；每次切换从 0.00 开始填写。
  onToggleUseCard() {
    if (this.data.repayCardLocked) return;
    if (this.data.repayCardBalance <= 0) return;
    this.setData({ repayUseCard: !this.data.repayUseCard, repayCardAmountInput: '0.00' });
    this._recalcRepayTotals(this.data.repayLines);
  },

  onRepayCardAmountInput(e: WechatMiniprogram.CustomEvent) {
    if (this.data.repayCardLocked) return;
    const raw = String((e.detail as unknown as { value?: string })?.value ?? e.detail ?? '');
    this.setData({ repayCardAmountInput: raw });
    this._recalcRepayTotals(this.data.repayLines);
  },

  onRepayCardAmountBlur() {
    if (this.data.repayCardLocked) return;
    const realTotal = this.data.repayLines.reduce((sum, line) => sum + (Number(line.real) || 0), 0);
    const maxAmount = Math.min(Math.max(0, this.data.repayCardBalance), Math.max(0, realTotal));
    const requested = Number(this.data.repayCardAmountInput);
    const amount = Number.isFinite(requested) ? Math.max(0, Math.min(requested, maxAmount)) : 0;
    this.setData({ repayCardAmountInput: amount.toFixed(2) });
    this._recalcRepayTotals(this.data.repayLines);
  },

  onRepayNoteChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayNote: val });
  },

  async onConfirmRepay() {
    if (this._isReadOnly() || this.data.submitting) return;
    const { order, repayLines, repayMethod, repayNote, currentRemainingPayable, repayUseCard, repayCardBalance, repayCardAmountInput, repayIdempKey } = this.data;
    if (!order || !order.saleOrderId) return;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const isOnline = repayMethod === '微信' || repayMethod === '支付宝';

    // 实付合计 + 逐项校验（实付 ≤ 该行可回款额）
    const reals = repayLines.map((l) => ({
      saleItemId: l.saleItemId,
      real: r2(Number(l.real) || 0),
      repayable: Number(l.repayable),
    }));
    const realTotal = r2(reals.reduce((s, it) => s + it.real, 0));
    if (realTotal <= 0) {
      wx.showToast({ title: '请至少为一个子项填写实付金额', icon: 'none' });
      return;
    }
    if (realTotal > currentRemainingPayable + 0.001) {
      wx.showToast({ title: `超出欠款 ¥${currentRemainingPayable.toFixed(2)}`, icon: 'none' });
      return;
    }
    if (this.data.repayCardLocked && realTotal + 0.001 < this.data.repayPendingCardAmount) {
      wx.showToast({ title: `本次实付不能低于预选储值卡 ¥${this.data.repayPendingCardAmount.toFixed(2)}`, icon: 'none' });
      return;
    }
    for (const it of reals) {
      if (it.real < 0) {
        wx.showToast({ title: '金额不能为负', icon: 'none' });
        return;
      }
      if (it.real > it.repayable + 0.001) {
        wx.showToast({ title: '某子项实付超过该行可回款额', icon: 'none' });
        return;
      }
    }

    // 储值卡抵扣 + 按各子项实付比例摊分（末项补差，每项 ≤ 该行实付）。
    // 已有 pending 时它是服务端待结算事实，不能再按当前余额 min 后静默缩小：余额不足
    // 必须在任何扣卡/出码请求前明确阻断；余额足够则本次卡额恒等于固定 pending。
    const fixedPendingCard = this.data.repayCardLocked
      ? r2(Math.max(0, this.data.repayPendingCardAmount))
      : 0;
    if (this.data.repayCardLocked && repayCardBalance + 0.001 < fixedPendingCard) {
      wx.showToast({
        title: `储值卡余额不足（预选 ¥${fixedPendingCard.toFixed(2)}，当前 ¥${Math.max(0, repayCardBalance).toFixed(2)}）`,
        icon: 'none',
      });
      return;
    }
    const cardMax = Math.min(Math.max(0, repayCardBalance), realTotal);
    const requestedCard = Number(repayCardAmountInput);
    const cardDeduct = this.data.repayCardLocked
      ? fixedPendingCard
      : (repayUseCard && Number.isFinite(requestedCard)
        ? r2(Math.min(Math.max(0, requestedCard), cardMax))
        : 0);
    const filled = reals.filter((it) => it.real > 0);
    const cardMap: Record<string, number> = {};
    let acc = 0;
    filled.forEach((it, i) => {
      let card = i === filled.length - 1 ? r2(cardDeduct - acc) : r2((cardDeduct * it.real) / realTotal);
      card = Math.max(0, Math.min(card, it.real));
      cardMap[it.saleItemId] = card;
      acc = r2(acc + card);
    });

    // ===== 微信/支付宝：储值卡部分先即时扣，剩余生成收款码让顾客扫码在线付 =====
    if (isOnline) {
      const cardItems = reals
        .map((it) => ({ saleItemId: it.saleItemId, repayAmount: 0, prepaidCardAmount: r2(cardMap[it.saleItemId] || 0) }))
        .filter((it) => it.prepaidCardAmount > 0);
      const needPay = r2(realTotal - cardDeduct);
      this.setData({ submitting: true });
      try {
        if (cardItems.length > 0) {
          await callStaffApi('order.createRepayment', {
            refSaleOrderId: order.saleOrderId,
            paymentMethod: '储值卡',
            ...(order.orderType === '转换单'
              ? { prepaidCardAmount: cardDeduct, ...(needPay > 0.001 ? { onlinePaymentAmount: needPay } : {}) }
              : { items: cardItems }),
            note: repayNote || undefined,
            idempotencyKey: repayIdempKey || undefined,
          });
        }
        if (needPay <= 0.001) {
          // 储值卡已全额抵扣结清，无需出码
          this.setData({ showRepayPopup: false });
          wx.showToast({ title: '储值卡已抵扣结清', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } else {
          // 转换单先把操作员填写的本次在线回款额冻结到订单；二维码页和顾客收银台均从
          // first_payment_amount 读取硬上限，避免默认按整笔剩余欠款收费。有储值卡时，
          // createRepayment 已在扣卡事务内同时冻结该金额；无卡时才单独冻结，杜绝部分成功。
          if (order.orderType === '转换单' && cardItems.length === 0) {
            await callStaffApi('order.qrcode', {
              saleOrderId: order.saleOrderId,
              paymentAmount: needPay,
            });
          }
          this.setData({ showRepayPopup: false });
          // 跳收款码页：顾客扫码进收银台在线付本次冻结金额，payNotify 回调写 change_type=回款
          const params = `saleOrderId=${order.saleOrderId}&customerName=${encodeURIComponent(order.customerName)}&totalAmount=${order.totalAmount}`;
          wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?${params}` });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '操作失败';
        wx.showToast({ title: msg.replace(/^[A-Z_]+:\s*/, '') || '操作失败', icon: 'none' });
        // 服务端可能已完成幂等事务但响应丢失；立即刷新余额/欠款，并保留本弹层的幂等键供重试。
        await this.loadDetail(this.data._saleOrderId);
      } finally {
        this.setData({ submitting: false });
      }
      return;
    }

    // ===== 线下：即时记账（实付 = 现金 repayAmount + 储值卡抵扣 prepaidCardAmount） =====
    const items = reals
      .map((it) => {
        const card = r2(cardMap[it.saleItemId] || 0);
        return { saleItemId: it.saleItemId, repayAmount: r2(it.real - card), prepaidCardAmount: card };
      })
      .filter((it) => it.repayAmount > 0 || it.prepaidCardAmount > 0);

    this.setData({ submitting: true });
    try {
      await callStaffApi('order.createRepayment', {
        refSaleOrderId: order.saleOrderId,
        paymentMethod: '线下',
        ...(order.orderType === '转换单'
          ? { repayAmount: r2(realTotal - cardDeduct), prepaidCardAmount: cardDeduct }
          : { items }),
        note: repayNote || undefined,
        idempotencyKey: repayIdempKey || undefined,
      });
      wx.showToast({ title: '回款成功', icon: 'success' });
      this.setData({ showRepayPopup: false });
      this.loadDetail(this.data._saleOrderId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '回款失败';
      // 剥离错误前缀（INVALID_PARAMS:OVERPAY → OVERPAY / 中文后缀）
      wx.showToast({ title: msg.replace(/^[A-Z_]+:\s*/, '') || '回款失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

});
