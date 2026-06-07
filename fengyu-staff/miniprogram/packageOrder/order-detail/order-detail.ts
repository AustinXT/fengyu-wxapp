// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager, getStaffWfId } from '../../utils/role';
import { STATUS_CLASS, ORDER_TYPE_LABEL, formatDateTime } from '../../utils/formatters';

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
  allocatable?: boolean;
}

interface RawOrderItem {
  sale_item_id: string;
  product_name?: string;
  sku_spec_name?: string;
  sale_amount?: string;
  received?: string;
  session_count?: number;
  remaining_sessions?: number;
  paid_sessions?: number | null;
}

interface RawAllocation {
  employee_name?: string;
  employee_id?: string;
  department_name?: string;
  total_amount?: string;
  allocation_ratio?: number;
}

interface RawPayment {
  change_type: string;
  amount: number;
  payment_method: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  note: string | null;
}

interface DisplayPayment {
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
  allocations: RawAllocation[];
  payments?: RawPayment[];
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
}

interface DisplayAllocation {
  staffName: string;
  department: string;
  amount: string;
  ratio: string;
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
  payableAmount: string;
  remainingPayable: string;
  hasDebt: boolean;
  items: DisplayOrderItem[];
  allocation: DisplayAllocation[];
  payments: DisplayPayment[];
  allocatable: boolean;
}

Page({
  data: {
    loading: false,
    order: null as DisplayOrder | null,
    isManager: false,
    isCreator: false,
    statusClass: '',
    _saleOrderId: '',
    // P2: 退款
    showRefundDialog: false,
    refundReason: '',
    submitting: false,
    // Ticket 2026-05-21: 按子项回款弹层
    showRepayPopup: false,
    // 每个购买子项一行：{ saleItemId, itemName, repayable, cash, card }
    repayLines: [] as Array<{ saleItemId: string; itemName: string; repayable: string; cash: string; card: string }>,
    repayMethod: '线下' as '线下' | '微信' | '储值卡',
    repayNote: '',
    repayCashTotal: '0.00',
    repayCardTotal: '0.00',
    repayGrandTotal: '0.00',
    // 当前订单欠款（弹层内引用）
    currentRemainingPayable: 0,
    // 寄存单历史实收编辑弹层
    showDepositPopup: false,
    depositLines: [] as Array<{ saleItemId: string; itemName: string; received: string }>,
    depositTotal: '0.00',
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
        const repayable = Math.max(0, Math.round((saleAmt - recv) * 100) / 100);
        return {
          saleItemId: it.sale_item_id,
          itemName: it.product_name || it.sku_spec_name || '—',
          spec: it.sku_spec_name || '',
          totalPrice: it.received || '0',
          saleAmount: saleAmt.toFixed(2),
          received: recv.toFixed(2),
          repayable: repayable.toFixed(2),
          sessionCount: it.session_count,
          remainingSessions: it.remaining_sessions,
          paidSessions: it.paid_sessions == null ? undefined : Number(it.paid_sessions),
          usedSessions: used,
          paidUnusedSessions: paidUnused,
          remainPct: pct(remain),
          paidUnusedPct: pct(paidUnused),
          unpaidPct: pct(unpaid),
        };
      });
      const allocation: DisplayAllocation[] = (res.allocations || []).map((a) => ({
        staffName: a.employee_name || a.employee_id || '',
        department: a.department_name || '',
        amount: a.total_amount || '0',
        ratio: `${Number(a.allocation_ratio) * 100}%`,
      }));

      // Ticket 2 PR-A：payments 流水 + 欠款计算
      const payments: DisplayPayment[] = (res.payments || []).map((p) => {
        const amt = Number(p.amount) || 0;
        const isRefund = amt < 0 || p.change_type === '退款';
        const timeSrc = p.paid_at || p.created_at;
        return {
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

      const totalAmount = Number(o.total_amount || 0);
      const prepaidCardAmount = Number(o.prepaid_card_amount || 0);
      // 2026-04-26 sale-order-domain-refactor: paid_amount 列已 DROP，净到账 = received - refunded_amount
      const received = Number(o.received || 0);
      const refundedAmount = Number(o.refunded_amount || 0);
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      // payable_amount 在旧订单可能 NULL，用 total - prepaid 兜底
      const payableAmount = o.payable_amount != null
        ? Number(o.payable_amount)
        : Math.round((totalAmount - prepaidCardAmount) * 100) / 100;
      const remainingPayable = Math.max(0, Math.round((payableAmount - netReceived) * 100) / 100);
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
          confirmedBy: o.offline_confirmed_by || '',
          confirmedAt: formatDateTime(o.offline_confirmed_at),
          createdAt: formatDateTime(o.created_at),
          paidAt: formatDateTime(o.paid_at),
          totalAmount: totalAmount.toFixed(2),
          paidAmount: netReceived.toFixed(2),
          prepaidCardAmount: prepaidCardAmount.toFixed(2),
          payableAmount: payableAmount.toFixed(2),
          remainingPayable: remainingPayable.toFixed(2),
          hasDebt,
          items,
          allocation,
          payments,
          allocatable: o.allocatable ?? false,
        },
        currentRemainingPayable: remainingPayable,
        isCreator: o.opened_by === getStaffWfId(),
        statusClass: STATUS_CLASS[o.status] || 'pending',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReAllocation() {
    const saleOrderId = this.data._saleOrderId;
    wx.navigateTo({ url: `/packageOrder/revenue-allocation/revenue-allocation?saleOrderId=${saleOrderId}` });
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

  // ===== P2: 退款 =====
  onCreateRefund() {
    const o = this.data.order;
    if (!o) return;
    this.setData({ showRefundDialog: true, refundReason: '' });
  },

  onRefundReasonChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ refundReason: (e.detail as unknown as string) || '' });
  },

  async onConfirmRefund() {
    const { order, refundReason, submitting } = this.data;
    if (submitting || !order) return;
    if (!refundReason?.trim()) {
      wx.showToast({ title: '请填写退款原因', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const items = order.items.map((it) => ({ saleItemId: it.saleItemId }));
      await callStaffApi('order.createRefund', {
        refSaleOrderId: order.saleOrderId,
        items,
        refundReason: refundReason.trim(),
      });
      this.setData({ showRefundDialog: false });
      wx.showToast({ title: '退款单已创建', icon: 'success' });
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

  // ===== P2: 审批退款 =====
  onApproveRefund() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '审批退款',
      content: '确认通过此退款申请？审批后将扣减对应次数。',
      confirmText: '通过',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('order.approveRefund', { saleOrderId: this.data._saleOrderId });
          wx.showToast({ title: '退款已审批', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  onRejectRefund() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '驳回退款',
      content: '确认驳回此退款申请？',
      confirmText: '驳回',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ submitting: true });
        try {
          await callStaffApi('order.rejectRefund', { saleOrderId: this.data._saleOrderId });
          wx.showToast({ title: '退款已驳回', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          this.setData({ submitting: false });
        }
      },
    });
  },

  // ===== Ticket 2026-05-21：按子项发起回款 =====
  // 合计当前各行金额（线下=cash 列，储值卡=card 列）
  _recalcRepayTotals(lines: Array<{ cash: string; card: string }>) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const isCard = this.data.repayMethod === '储值卡';
    const cash = r2(lines.reduce((s, l) => s + (Number(l.cash) || 0), 0));
    const card = r2(lines.reduce((s, l) => s + (Number(l.card) || 0), 0));
    const grand = isCard ? card : r2(cash + card);
    this.setData({ repayCashTotal: cash.toFixed(2), repayCardTotal: card.toFixed(2), repayGrandTotal: grand.toFixed(2) });
  },

  onRepayTap() {
    const o = this.data.order;
    if (!o || !o.hasDebt) return;
    // 默认线下、每行现金 = 该行可回款额（操作员可改小或清零，不要求全额）
    const lines = (o.items || [])
      .filter((it) => Number(it.repayable) > 0)
      .map((it) => ({ saleItemId: it.saleItemId, itemName: it.itemName, repayable: it.repayable, cash: it.repayable, card: '0.00' }));
    this.setData({ showRepayPopup: true, repayLines: lines, repayMethod: '线下', repayNote: '' });
    this._recalcRepayTotals(lines);
  },

  onCloseRepayPopup() {
    this.setData({ showRepayPopup: false });
  },

  // 子项金额输入：data-index 指定行，data-col 指定 cash/card
  onRepayLineChange(e: WechatMiniprogram.CustomEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const col = e.currentTarget.dataset.col as 'cash' | 'card';
    const val = (e.detail as unknown as string) || '';
    const lines = this.data.repayLines.slice();
    if (!lines[idx]) return;
    lines[idx] = { ...lines[idx], [col]: val };
    this.setData({ repayLines: lines });
    this._recalcRepayTotals(lines);
  },

  onRepayMethodChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) as '线下' | '微信' | '储值卡';
    if (val === '微信') {
      wx.showToast({ title: '微信扫码回款开发中', icon: 'none' });
      return;
    }
    this.setData({ repayMethod: val });
    this._recalcRepayTotals(this.data.repayLines);
  },

  onRepayNoteChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayNote: val });
  },

  async onConfirmRepay() {
    if (this.data.submitting) return;
    const { order, repayLines, repayMethod, repayNote, currentRemainingPayable } = this.data;
    if (!order || !order.saleOrderId) return;
    if (repayMethod === '微信') {
      wx.showToast({ title: '微信扫码回款开发中', icon: 'none' });
      return;
    }
    const isCard = repayMethod === '储值卡';
    const r2 = (n: number) => Math.round(n * 100) / 100;

    // 逐项归一为 { saleItemId, repayAmount(现金), prepaidCardAmount(储值卡) }
    // 储值卡方式 → 金额进 card 列；线下 → 进 cash 列（仍可叠加 card 列储值卡抵扣）
    const items = repayLines
      .map((l) => {
        const entered = r2(Number((isCard ? l.card : l.cash)) || 0);
        const cardExtra = isCard ? 0 : r2(Number(l.card) || 0);
        return {
          saleItemId: l.saleItemId,
          repayAmount: isCard ? 0 : entered,
          prepaidCardAmount: isCard ? entered : cardExtra,
          repayable: Number(l.repayable),
        };
      })
      .filter((it) => it.repayAmount > 0 || it.prepaidCardAmount > 0);

    if (items.length === 0) {
      wx.showToast({ title: '请至少为一个子项填写金额', icon: 'none' });
      return;
    }
    const total = r2(items.reduce((s, it) => s + it.repayAmount + it.prepaidCardAmount, 0));
    if (total > currentRemainingPayable + 0.001) {
      wx.showToast({ title: `超出欠款 ¥${currentRemainingPayable.toFixed(2)}`, icon: 'none' });
      return;
    }
    for (const it of items) {
      if (r2(it.repayAmount + it.prepaidCardAmount) > it.repayable + 0.001) {
        wx.showToast({ title: '某子项金额超过该行可回款额', icon: 'none' });
        return;
      }
    }

    this.setData({ submitting: true });
    try {
      await callStaffApi('order.createRepayment', {
        refSaleOrderId: order.saleOrderId,
        paymentMethod: repayMethod,
        items: items.map((it) => ({ saleItemId: it.saleItemId, repayAmount: it.repayAmount, prepaidCardAmount: it.prepaidCardAmount })),
        note: repayNote || undefined,
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

  // ===== 寄存单历史实收编辑 =====
  _recalcDepositTotal(lines: Array<{ received: string }>) {
    const total = Math.round(lines.reduce((s, l) => s + (Number(l.received) || 0), 0) * 100) / 100;
    this.setData({ depositTotal: total.toFixed(2) });
  },

  onDepositEditTap() {
    const o = this.data.order;
    if (!o || o.orderType !== '寄存单') return;
    const lines = (o.items || []).map((it) => ({
      saleItemId: it.saleItemId,
      itemName: it.itemName,
      received: Number(it.received) > 0 ? Number(it.received).toFixed(2) : '',
    }));
    this.setData({ showDepositPopup: true, depositLines: lines });
    this._recalcDepositTotal(lines);
  },

  onCloseDepositPopup() {
    this.setData({ showDepositPopup: false });
  },

  onDepositLineChange(e: WechatMiniprogram.CustomEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const val = (e.detail as unknown as string) || '';
    const lines = this.data.depositLines.slice();
    if (!lines[idx]) return;
    lines[idx] = { ...lines[idx], received: val };
    this.setData({ depositLines: lines });
    this._recalcDepositTotal(lines);
  },

  async onConfirmDepositEdit() {
    if (this.data.submitting) return;
    const { order, depositLines } = this.data;
    if (!order || !order.saleOrderId) return;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const items = depositLines.map((l) => ({
      saleItemId: l.saleItemId,
      received: Math.max(0, r2(Number(l.received) || 0)),
    }));

    this.setData({ submitting: true });
    try {
      await callStaffApi('order.updateDepositReceived', {
        saleOrderId: order.saleOrderId,
        items,
      });
      wx.showToast({ title: '实收已更新', icon: 'success' });
      this.setData({ showDepositPopup: false });
      this.loadDetail(this.data._saleOrderId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '修改失败';
      wx.showToast({ title: msg.replace(/^[A-Z_]+:\s*/, '') || '修改失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
