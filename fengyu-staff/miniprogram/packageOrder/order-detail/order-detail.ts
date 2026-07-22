// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager, getStaffWfId } from '../../utils/role';
import { STATUS_CLASS, ORDER_TYPE_LABEL, formatDateTime, formatDate } from '../../utils/formatters';

const PAY_TYPE_LABEL: Record<string, string> = {
  wechat: '微信支付',
  offline: '线下收款',
};


// ===== API 原始类型（snake_case） =====

interface RawOrder {
  sale_order_id: string;
  status: string;
  sale_order_type?: string;
  store_name?: string;
  payment_method?: string;
  customer_name?: string;
  client_phone?: string;
  preferred_staff_name?: string;
  offline_confirmed_by?: string;
  offline_confirmed_at?: string;
  created_at?: string;
  paid_at?: string;
  total_amount?: string;
  // 2026-04-26 sale-order-domain-refactor: paid_amount 列已 DROP，改用 received / refunded_amount
  received?: string;
  refunded_amount?: string;
  prepaid_card_amount?: string;
  payable_amount?: string;
  opened_by?: string;
  refund_reason?: string;
  ref_sale_order_id?: string;
  // 详情扩展字段（云函数 order SELECT * + coupon_name/offline_confirmed_by_name 衍生）
  document_type?: string;
  market_name?: string;
  coupon_discount?: string;
  coupon_name?: string;
  allocation_status?: string;
  legacy_source?: string;
  offline_confirmed_by_name?: string;
  allocatable?: boolean;
  is_activity?: boolean;
  remark?: string;
}

interface RawOrderItem {
  sale_item_id: string;
  product_name?: string;
  sale_amount?: string;
  received?: string;
  session_count?: number;
  remaining_sessions?: number;
  paid_sessions?: number | null;
  unit_price?: string;
  unit_real_price?: string;
  expire_date?: string;
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
  itemName: string;
  spec: string;
  totalPrice: string;
  /** 行应付（sale_amount）/ 已收（received）/ 可回款（应付-已收），按子项回款用 */
  saleAmount: string;
  received: string;
  repayable: string;
  sessionCount: number | undefined;
  remainingSessions: number | undefined;
  paidSessions: number | undefined;
  /** 已用次数 = sessionCount - remainingSessions（0 兜底） */
  usedSessions: number;
  /** 已付未用次数 = max(paidSessions - usedSessions, 0) */
  paidUnusedSessions: number;
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
}

interface DisplayOrder {
  saleOrderId: string;
  status: string;
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
  totalAmount: string;
  paidAmount: string;
  prepaidCardAmount: string;
  remainingPayable: string;
  hasDebt: boolean;
  /** 详情扩展：单据类型 / 所属市场 / 券名 / 券抵扣 / 分配状态 / 历史订单标记 */
  documentType: string;
  marketName: string;
  couponName: string;
  couponDiscount: string;
  allocationStatus: string;
  isLegacy: boolean;
  isActivity: boolean;
  remark: string;
  items: DisplayOrderItem[];
  payments: DisplayPayment[];
  /** 多收余数可退额（0=无）；退款弹层据此展示「多收可退余数」选项 */
  overpayRefundable: string;
}

// 多收余数退款选项哨兵 id（与云函数 OVERPAY_SENTINEL 一致）：退款弹层勾选该项 →
// createRefund 带 includeOverpay=true，云函数把订单级孤儿零头作纯现金并入退款（不挂品项/不退次数/不触发级联）。
const OVERPAY_OPTION_ID = 'OVERPAY';

Page({
  data: {
    loading: false,
    order: null as DisplayOrder | null,
    isManager: false,
    isCreator: false,
    statusClass: '',
    refundBadge: '',
    hasPendingRefund: false,
    _saleOrderId: '',
    // P2: 退款
    showRefundDialog: false,
    refundReason: '',
    // 退款明细多选（可选订单内若干项；疗程卡整卡退、不支持部分退次数）
    refundItemOptions: [] as Array<{ saleItemId: string; label: string }>,
    refundSelectedIds: [] as string[],
    submitting: false,
    // Ticket 2026-05-21 按子项回款弹层（2026-06-24 重构：储值卡改独立抵扣勾选）
    showRepayPopup: false,
    // 每个购买子项一行：{ saleItemId, itemName, repayable, real(本次实付金额) }
    repayLines: [] as Array<{ saleItemId: string; itemName: string; repayable: string; real: string }>,
    repayMethod: '线下' as '线下' | '微信' | '支付宝',
    repayNote: '',
    // 储值卡抵扣：独立勾选，勾选后自动抵满 min(余额, 实付合计)
    repayUseCard: false,
    repayCardBalance: 0,
    // 本次回款意向幂等键（打开弹层生成一次，重试/误点复用，防重复扣卡；服务端据此作扣卡 external_ref）
    repayIdempKey: '',
    repayRealTotal: '0.00',
    repayCardDeduct: '0.00',
    // 需支付金额（线下=现金 / 微信支付宝=顾客扫码）= 实付合计 − 储值卡抵扣
    repayNeedPay: '0.00',
    // 当前订单欠款（弹层内引用）
    currentRemainingPayable: 0,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.setData({ _saleOrderId: options.id });
      this.loadDetail(options.id);
    }
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
        // 已退行不可回款（行级口径，与 client/admin 一致）；received 为净额
        const repayable = refunded > 0 ? 0 : Math.max(0, Math.round((saleAmt - recv) * 100) / 100);
        return {
          saleItemId: it.sale_item_id,
          itemName: it.product_name || '—',
          spec: it.product_name || '',
          totalPrice: it.received || '0',
          saleAmount: saleAmt.toFixed(2),
          received: recv.toFixed(2),
          refundedAmount: refunded.toFixed(2),
          isRefunded: refunded > 0,
          repayable: repayable.toFixed(2),
          sessionCount: it.session_count,
          remainingSessions: it.remaining_sessions,
          paidSessions: it.paid_sessions == null ? undefined : Number(it.paid_sessions),
          usedSessions: used,
          paidUnusedSessions: paidUnused,
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
      const prepaidCardAmount = Number(o.prepaid_card_amount || 0);
      // 2026-04-26 sale-order-domain-refactor: paid_amount 列已 DROP，净到账 = received - refunded_amount
      const received = Number(o.received || 0);
      const refundedAmount = Number(o.refunded_amount || 0);
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      // 欠款口径 = total − netReceived（与 status 结清判定 settleTarget = payable + prepaid 一致；
      // received 按 I1 含储值卡抵扣，须用总额减，否则含卡部分支付单 payable(扣卡)−received(含卡) ≤ 0 → hasDebt 误判）
      const remainingPayable = Math.max(0, Math.round((totalAmount - netReceived) * 100) / 100);
      // 「发起回款」仅在已首次支付（部分支付）且仍有欠款时显示；
      // 待支付走「确认线下收款」，已结清/终态均不显示回款入口
      const orderType = o.sale_order_type || '';
      const hasDebt = orderType === '销售单'
        && o.status === '部分支付'
        && remainingPayable > 0;

      this.setData({
        order: {
          saleOrderId: o.sale_order_id,
          status: o.status,
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
          totalAmount: totalAmount.toFixed(2),
          paidAmount: netReceived.toFixed(2),
          prepaidCardAmount: prepaidCardAmount.toFixed(2),
          remainingPayable: remainingPayable.toFixed(2),
          hasDebt,
          documentType: o.document_type || '',
          marketName: o.market_name || '',
          couponName: o.coupon_name || '',
          couponDiscount: Number(o.coupon_discount || 0) > 0 ? Number(o.coupon_discount).toFixed(2) : '',
          allocationStatus: o.allocation_status || '',
          isLegacy: o.legacy_source === 'workfine',
          isActivity: !!o.is_activity,
          remark: o.remark || '',
          items,
          payments,
          overpayRefundable: Number(res.overpayRefundable || 0).toFixed(2),
        },
        currentRemainingPayable: remainingPayable,
        repayCardBalance: res.cardBalance != null ? Number(res.cardBalance) : 0,
        isCreator: o.opened_by === getStaffWfId(),
        statusClass: STATUS_CLASS[o.status] || 'pending',
        // 退款后状态角标（Bug B）：按 refunded_amount 派生「已退款/部分退款」，订单主状态不变（对齐 admin）
        refundBadge: refundedAmount > 0
          ? (refundedAmount >= received - 0.01 ? '已退款' : '部分退款')
          : '',
        hasPendingRefund,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onResetFailed() {
    if (this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '重置支付',
      content: '确认将此订单重置为"待支付"状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm) return;
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
    if (this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
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
    if (this.data.submitting) return;
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '取消订单',
      content: '确认取消该订单？取消后不可恢复。',
      confirmText: '确认取消',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm) return;
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
    const saleOrderId = this.data._saleOrderId;
    wx.navigateTo({ url: `/packageService/service-create/service-create?saleOrderId=${saleOrderId}` });
  },

  onBackToWorkbench() {
    wx.switchTab({ url: '/pages/workbench/workbench' });
  },

  onShowQrcode() {
    const o = this.data.order;
    if (!o) return;
    const params = `saleOrderId=${o.saleOrderId}&customerName=${encodeURIComponent(o.customerName)}&totalAmount=${o.totalAmount}`;
    wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?${params}` });
  },

  // ===== 充值卡退款（充值单专用，走 card.createRefund）=====
  onCreateCardRefund() {
    const o = this.data.order;
    if (!o) return;
    wx.showModal({
      title: '充值卡退款',
      content: '确认发起充值卡退款？将退还卡内剩余余额（按该充值单实付比例原路退款），提交后需店长审批。',
      confirmText: '发起退款',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm) return;
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
    const o = this.data.order;
    if (!o) return;
    // 可退项：疗程卡按「已付未用次数」(paidUnusedSessions>0) 可退；家居（无 session_count）默认列出，后端校验可退量。
    // 疗程卡整卡全退（不支持部分退次数），label 标注可退次数。
    const options = o.items
      .filter((it) => (it.sessionCount == null ? true : it.paidUnusedSessions > 0))
      .map((it) => ({
        saleItemId: it.saleItemId,
        label:
          it.sessionCount == null
            ? it.itemName
            : `${it.itemName}（整卡退 ${it.paidUnusedSessions} 次）`,
      }));
    // 多收余数（overpay）：部分支付单实收不能被单次价整除时的零头，作为独立可勾选项追加。
    // 全选品项时一并勾选 → 整单退全额；7 项已退完只剩零头时它是唯一项 → 余数单独退。
    const overpay = Number(o.overpayRefundable || 0);
    if (overpay > 0) {
      options.push({
        saleItemId: OVERPAY_OPTION_ID,
        label: `多收余数退款 ¥${overpay.toFixed(2)}`,
      });
    }
    this.setData({
      showRefundDialog: true,
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
    const { order, refundReason, refundSelectedIds, submitting } = this.data;
    if (submitting || !order) return;
    if (!refundReason?.trim()) {
      wx.showToast({ title: '请填写退款原因', icon: 'none' });
      return;
    }
    // 拆分：真实品项 vs 多收余数哨兵。余数单独退时 items 可空（云函数 includeOverpay 兜底放行）。
    const includeOverpay = refundSelectedIds.includes(OVERPAY_OPTION_ID);
    const items = refundSelectedIds
      .filter((id) => id !== OVERPAY_OPTION_ID)
      .map((saleItemId) => ({ saleItemId }));
    if (!items.length && !includeOverpay) {
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
        includeOverpay,
      });
      this.setData({ showRefundDialog: false });
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
    this.setData({ showRefundDialog: false });
  },

  // 退款审批已收口到 refund-list/refund-detail 页；原 onApproveRefund/onRejectRefund 传 saleOrderId（后端需 paymentId）
  // 且依赖恒不命中的 orderType==='退款单'，属死代码 + 传参错误，已删除（Bug D）。

  // ===== Ticket 2026-05-21：按子项发起回款 =====
  // 合计：实付合计 → 储值卡抵扣（勾选则自动抵满 min(余额, 实付合计)）→ 需支付
  _recalcRepayTotals(lines: Array<{ real: string }>) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const realTotal = r2(lines.reduce((s, l) => s + (Number(l.real) || 0), 0));
    const cardDeduct = this.data.repayUseCard
      ? r2(Math.min(this.data.repayCardBalance, realTotal))
      : 0;
    const needPay = r2(Math.max(0, realTotal - cardDeduct));
    this.setData({
      repayRealTotal: realTotal.toFixed(2),
      repayCardDeduct: cardDeduct.toFixed(2),
      repayNeedPay: needPay.toFixed(2),
    });
  },

  onRepayTap() {
    const o = this.data.order;
    if (!o || !o.hasDebt) return;
    // 默认线下、每行实付 = 该行可回款额（操作员可改小或清零，不要求全额）
    const lines = (o.items || [])
      .filter((it) => Number(it.repayable) > 0)
      .map((it) => ({ saleItemId: it.saleItemId, itemName: it.itemName, repayable: it.repayable, real: it.repayable }));
    this.setData({ showRepayPopup: true, repayLines: lines, repayMethod: '线下', repayNote: '', repayUseCard: false, repayIdempKey: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` });
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

  // 切换「使用储值卡抵扣」勾选（勾选后自动抵满 min(余额, 实付合计)）
  onToggleUseCard() {
    this.setData({ repayUseCard: !this.data.repayUseCard });
    this._recalcRepayTotals(this.data.repayLines);
  },

  onRepayNoteChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayNote: val });
  },

  async onConfirmRepay() {
    if (this.data.submitting) return;
    const { order, repayLines, repayMethod, repayNote, currentRemainingPayable, repayUseCard, repayCardBalance, repayIdempKey } = this.data;
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

    // 储值卡抵扣（勾选则自动抵满）+ 按各子项实付比例摊分（末项补差，每项 ≤ 该行实付）
    const cardDeduct = repayUseCard ? r2(Math.min(repayCardBalance, realTotal)) : 0;
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
            items: cardItems,
            note: repayNote || undefined,
            idempotencyKey: repayIdempKey || undefined,
          });
        }
        this.setData({ showRepayPopup: false });
        if (needPay <= 0.001) {
          // 储值卡已全额抵扣结清，无需出码
          wx.showToast({ title: '储值卡已抵扣结清', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } else {
          // 跳收款码页：顾客扫码进收银台在线付剩余应付，payNotify 回调写 change_type=回款
          const params = `saleOrderId=${order.saleOrderId}&customerName=${encodeURIComponent(order.customerName)}&totalAmount=${order.totalAmount}`;
          wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?${params}` });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '操作失败';
        wx.showToast({ title: msg.replace(/^[A-Z_]+:\s*/, '') || '操作失败', icon: 'none' });
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
        items,
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
