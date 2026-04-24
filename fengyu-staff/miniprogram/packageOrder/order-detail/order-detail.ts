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
  paid_amount?: string;
  prepaid_card_amount?: string;
  payable_amount?: string;
  opened_by?: string;
  refund_reason?: string;
  ref_sale_order_id?: string;
}

interface RawOrderItem {
  sale_item_id: string;
  product_name?: string;
  sku_spec_name?: string;
  received?: string;
  session_count?: number;
  remaining_sessions?: number;
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
  sessionCount: number | undefined;
  remainingSessions: number | undefined;
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
    // Ticket 2: 回款弹层
    showRepayPopup: false,
    repayAmountInput: '',
    repayPrepaidCardInput: '',
    repayMethod: '线下' as '线下' | '微信' | '储值卡',
    repayNote: '',
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
      const items: DisplayOrderItem[] = (res.items || []).map((it) => ({
        saleItemId: it.sale_item_id,
        itemName: it.product_name || it.sku_spec_name || '—',
        spec: it.sku_spec_name || '',
        totalPrice: it.received || '0',
        sessionCount: it.session_count,
        remainingSessions: it.remaining_sessions,
      }));
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
      const paidAmount = Number(o.paid_amount || 0);
      // payable_amount 在旧订单可能 NULL，用 total - prepaid 兜底
      const payableAmount = o.payable_amount != null
        ? Number(o.payable_amount)
        : Math.round((totalAmount - prepaidCardAmount) * 100) / 100;
      const remainingPayable = Math.round((payableAmount - paidAmount) * 100) / 100;
      // 仅在"销售单"且未付清且非终态时视为欠款可回款
      const orderType = o.sale_order_type || '';
      const hasDebt = orderType === '销售单'
        && remainingPayable > 0
        && o.status !== '已关闭'
        && o.status !== '已完成';

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
          paidAmount: paidAmount.toFixed(2),
          prepaidCardAmount: prepaidCardAmount.toFixed(2),
          payableAmount: payableAmount.toFixed(2),
          remainingPayable: remainingPayable.toFixed(2),
          hasDebt,
          items,
          allocation,
          payments,
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

  // ===== Ticket 2 PR-A：发起回款 =====
  onRepayTap() {
    const o = this.data.order;
    if (!o || !o.hasDebt) return;
    this.setData({
      showRepayPopup: true,
      repayAmountInput: o.remainingPayable,
      repayPrepaidCardInput: '',
      repayMethod: '线下',
      repayNote: '',
    });
  },

  onCloseRepayPopup() {
    this.setData({ showRepayPopup: false });
  },

  onRepayAmountChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayAmountInput: val });
  },

  onRepayPrepaidCardChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayPrepaidCardInput: val });
  },

  onRepayMethodChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) as '线下' | '微信' | '储值卡';
    // 微信扫码暂未开放：UI 层也拦截一次（后端兜底）
    if (val === '微信') {
      wx.showToast({ title: '微信扫码回款开发中', icon: 'none' });
      return;
    }
    // 储值卡：清空 repayAmountInput，仅让用户填 prepaidCard
    if (val === '储值卡') {
      this.setData({ repayMethod: val, repayAmountInput: '0' });
      return;
    }
    this.setData({ repayMethod: val });
  },

  onRepayNoteChange(e: WechatMiniprogram.CustomEvent) {
    const val = (e.detail as unknown as string) || '';
    this.setData({ repayNote: val });
  },

  async onConfirmRepay() {
    if (this.data.submitting) return;
    const { order, repayAmountInput, repayPrepaidCardInput, repayMethod, repayNote, currentRemainingPayable } = this.data;
    if (!order || !order.saleOrderId) return;

    const repayAmount = Math.round((Number(repayAmountInput) || 0) * 100) / 100;
    const prepaidCardAmount = Math.round((Number(repayPrepaidCardInput) || 0) * 100) / 100;
    const total = Math.round((repayAmount + prepaidCardAmount) * 100) / 100;

    if (total <= 0) {
      wx.showToast({ title: '回款金额需大于 0', icon: 'none' });
      return;
    }
    if (total > currentRemainingPayable + 0.001) {
      wx.showToast({ title: `超出欠款 ¥${currentRemainingPayable.toFixed(2)}`, icon: 'none' });
      return;
    }
    if (repayMethod === '储值卡' && repayAmount > 0) {
      wx.showToast({ title: '储值卡方式下现金回款应为 0', icon: 'none' });
      return;
    }
    if (repayMethod === '微信') {
      wx.showToast({ title: '微信扫码回款开发中', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      await callStaffApi('order.createRepayment', {
        refSaleOrderId: order.saleOrderId,
        repayAmount,
        prepaidCardAmount,
        paymentMethod: repayMethod,
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
});
