// packageOrder/refund-detail/refund-detail.ts — 退款凭证单详情 + 审批操作
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { formatDateTimeShort } from '../../utils/formatters';

interface RawPayment {
  paymentId: number;
  saleOrderId: string;
  amount: number;
  status: string;
  paymentMethod: string;
  changeType: string;
  saleOrderType?: string;
  createdAt: string;
  paidAt: string | null;
}

interface RawDetail {
  refundReason: string | null;
  refSaleItemId: string | null;
  sessionCount: number | null;
  operatorEmployeeId: string | null;
  operatorName: string | null;
  auditEmployeeId: string | null;
  auditName: string | null;
  auditAt: string | null;
  auditRemark: string | null;
  noteJson: { handlingFee?: number } | null;
}

interface DisplayRefund {
  refund_abs: string;
  handling_fee_display: string;
  refund_reason: string | null;
  rejected_reason: string | null;
  ref_sale_order_id: string;
  customer_name: string | null;
  client_phone: string | null;
  opened_by_name: string | null;
  approved_by_name: string | null;
  created_at_display: string;
  approved_at_display: string;
  status: string;
  statusLabel: string;
  statusClass: 'pending' | 'approved' | 'rejected';
}

interface RawRefundItem {
  saleItemId: string;
  productName: string | null;
  specName: string | null;
  productType: string | null;
  unit: string;
  quantity: number;
  refundAmount: number;
}

interface DisplayRefundItem {
  saleItemId: string;
  productName: string;
  specName: string | null;
  quantity: number;
  unit: string;
  amount_abs: string;
}

interface RawOrigOrder {
  saleOrderId: string;
  totalAmount: number;
  received: number;
  prepaidCardAmount: number;
  paymentMethod: string;
  saleOrderDatetime: string;
  clientPhone: string | null;
  customerName: string | null;
}

interface DisplayOrigOrder {
  status: string;
  total_display: string;
  paid_display: string;
  prepaid_display: string;
}

interface RefundDetailResponse {
  payment: RawPayment;
  detail: RawDetail;
  origOrder: RawOrigOrder | null;
  refundItems: RawRefundItem[];
}

const STATUS_META: Record<string, { label: string; cls: DisplayRefund['statusClass'] }> = {
  '待审批': { label: '待审批', cls: 'pending' },
  '已支付': { label: '已通过', cls: 'approved' },
  '已作废': { label: '已驳回', cls: 'rejected' },
};


Page({
  data: {
    loading: true,
    isManager: false,
    refundId: '',
    refund: null as DisplayRefund | null,
    refundItems: [] as DisplayRefundItem[],
    origOrder: null as DisplayOrigOrder | null,
    rejectPopup: false,
    rejectReason: '',
    saleOrderType: '',
    submitting: false,
  },

  onLoad(options: { id?: string }) {
    const id = options.id || '';
    this.setData({ refundId: id, isManager: isManager() });
    if (!id) {
      wx.showToast({ title: '缺少退款单号', icon: 'none' });
      return;
    }
    this.loadDetail();
  },

  async loadDetail() {
    this.setData({ loading: true });
    try {
      const res = await callStaffApi<RefundDetailResponse>('order.refundDetail', {
        paymentId: Number(this.data.refundId),
      });
      const p = res.payment;
      const d = res.detail;
      const meta = STATUS_META[p.status] ?? { label: p.status, cls: 'pending' as const };
      const fee = Number(d.noteJson?.handlingFee || 0);
      const refund: DisplayRefund = {
        refund_abs: Math.abs(Number(p.amount || 0)).toFixed(2),
        handling_fee_display: fee > 0 ? fee.toFixed(2) : '',
        refund_reason: d.refundReason,
        // 驳回原因复用审批备注（驳回时 auditRemark 记录原因）
        rejected_reason: p.status === '已作废' ? d.auditRemark : null,
        ref_sale_order_id: p.saleOrderId,
        customer_name: res.origOrder?.customerName ?? null,
        client_phone: res.origOrder?.clientPhone ?? null,
        opened_by_name: d.operatorName,
        approved_by_name: d.auditName,
        created_at_display: formatDateTimeShort(p.createdAt),
        approved_at_display: formatDateTimeShort(d.auditAt),
        status: p.status,
        statusLabel: meta.label,
        statusClass: meta.cls,
      };
      const refundItems: DisplayRefundItem[] = (res.refundItems || []).map(it => ({
        saleItemId: it.saleItemId,
        productName: it.productName || '商品',
        specName: it.specName,
        quantity: it.quantity,
        unit: it.unit || (it.productType === '家居产品' ? '盒' : '次'),
        amount_abs: Math.abs(Number(it.refundAmount || 0)).toFixed(2),
      }));
      const origOrder: DisplayOrigOrder | null = res.origOrder ? {
        status: '',
        total_display: Number(res.origOrder.totalAmount || 0).toFixed(2),
        paid_display: Number(res.origOrder.received || 0).toFixed(2),
        prepaid_display: Number(res.origOrder.prepaidCardAmount || 0) > 0
          ? Number(res.origOrder.prepaidCardAmount).toFixed(2)
          : '',
      } : null;
      this.setData({ refund, refundItems, origOrder, saleOrderType: p.saleOrderType || '' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapOrigOrder() {
    const id = this.data.refund?.ref_sale_order_id;
    if (!id) return;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  onApprove() {
    if (this.data.submitting) return;
    // 充值单退款走 card.approveRefund（扣 prepaid_cards.balance）；销售单退款走 order.approveRefund（5 通道 cascade）
    const isRecharge = this.data.saleOrderType === '充值单';
    wx.showModal({
      title: '审批通过',
      content: isRecharge
        ? '确认通过此充值卡退款？通过后将扣减卡内余额，退款金额由门店线下处理。'
        : '确认通过此退款单？通过后将扣减对应服务额度/库存，退款金额由门店线下处理。',
      confirmText: '确认通过',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm) return;
        if (this.data.submitting) return;
        this.setData({ submitting: true });
        wx.showLoading({ title: '审批中', mask: true });
        try {
          const action = isRecharge ? 'card.approveRefund' : 'order.approveRefund';
          await callStaffApi(action, { paymentId: Number(this.data.refundId) });
          wx.showToast({ title: '审批已通过', icon: 'success' });
          this.loadDetail();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        } finally {
          wx.hideLoading();
          this.setData({ submitting: false });
        }
      },
    });
  },

  onShowReject() {
    this.setData({ rejectPopup: true, rejectReason: '' });
  },

  onCloseReject() {
    this.setData({ rejectPopup: false });
  },

  onRejectReasonChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ rejectReason: String(e.detail ?? '') });
  },

  async onConfirmReject() {
    if (this.data.submitting) return;
    const reason = (this.data.rejectReason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请输入驳回原因', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });
    try {
      // 充值单退款走 card.rejectRefund（读 reason），销售单走 order.rejectRefund（读 auditRemark）；传两字段兼容
      const action = this.data.saleOrderType === '充值单' ? 'card.rejectRefund' : 'order.rejectRefund';
      await callStaffApi(action, {
        paymentId: Number(this.data.refundId),
        auditRemark: reason,
        reason,
      });
      wx.showToast({ title: '已驳回', icon: 'success' });
      this.setData({ rejectPopup: false, rejectReason: '' });
      this.loadDetail();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  },
});
