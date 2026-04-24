// packageOrder/refund-detail/refund-detail.ts — 退款凭证单详情 + 审批操作
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

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
  change_type: string;
  payment_method: string;
  status: string;
  timeFmt: string;
  amountAbs: string;
  note: string | null;
}

interface RawRefund {
  sale_order_id: string;
  status: string;
  ref_sale_order_id: string;
  client_phone: string | null;
  customer_name: string | null;
  total_amount: string | number;
  handling_fee: string | number | null;
  refund_reason: string | null;
  rejected_reason: string | null;
  opened_by: string | null;
  approved_by: string | null;
  opened_by_name: string | null;
  approved_by_name: string | null;
  created_at: string;
  approved_at: string | null;
}

interface DisplayRefund extends RawRefund {
  refund_abs: string;
  handling_fee_display: string;
  created_at_display: string;
  approved_at_display: string;
  statusLabel: string;
  statusClass: 'pending' | 'approved' | 'rejected';
}

interface RawRefundItem {
  sale_item_id: string;
  product_name: string;
  sku_spec_name: string | null;
  product_type: string;
  quantity: number;
  unit_real_price: string | number;
  sale_amount: string | number;
}

interface DisplayRefundItem extends RawRefundItem {
  amount_abs: string;
}

interface RawOrigOrder {
  sale_order_id: string;
  status: string;
  total_amount: string;
  paid_amount: string;
  prepaid_card_amount: string;
  payable_amount: string | null;
  payment_method: string;
  sale_order_datetime: string;
  client_phone: string;
  customer_name: string;
}

interface DisplayOrigOrder {
  status: string;
  total_display: string;
  paid_display: string;
  prepaid_display: string;
}

interface RefundDetailResponse {
  refund: RawRefund;
  origOrder: RawOrigOrder | null;
  refundItems: RawRefundItem[];
  payments: RawPayment[];
}

const STATUS_META: Record<string, { label: string; cls: DisplayRefund['statusClass'] }> = {
  '待审批': { label: '待审批', cls: 'pending' },
  '已支付': { label: '已通过', cls: 'approved' },
  '已关闭': { label: '已驳回', cls: 'rejected' },
};

function fmtTime(s: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    loading: true,
    isManager: false,
    refundId: '',
    refund: null as DisplayRefund | null,
    refundItems: [] as DisplayRefundItem[],
    origOrder: null as DisplayOrigOrder | null,
    payments: [] as DisplayPayment[],
    rejectPopup: false,
    rejectReason: '',
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
        saleOrderId: this.data.refundId,
      });
      const r = res.refund;
      const meta = STATUS_META[r.status] ?? { label: r.status, cls: 'pending' as const };
      const fee = Number(r.handling_fee || 0);
      const refund: DisplayRefund = {
        ...r,
        refund_abs: Math.abs(Number(r.total_amount || 0)).toFixed(2),
        handling_fee_display: fee > 0 ? fee.toFixed(2) : '',
        created_at_display: fmtTime(r.created_at),
        approved_at_display: fmtTime(r.approved_at),
        statusLabel: meta.label,
        statusClass: meta.cls,
      };
      const refundItems: DisplayRefundItem[] = (res.refundItems || []).map(it => ({
        ...it,
        amount_abs: Math.abs(Number(it.sale_amount || 0)).toFixed(2),
      }));
      const origOrder: DisplayOrigOrder | null = res.origOrder ? {
        status: res.origOrder.status,
        total_display: Number(res.origOrder.total_amount || 0).toFixed(2),
        paid_display: Number(res.origOrder.paid_amount || 0).toFixed(2),
        prepaid_display: Number(res.origOrder.prepaid_card_amount || 0) > 0
          ? Number(res.origOrder.prepaid_card_amount).toFixed(2)
          : '',
      } : null;
      const payments: DisplayPayment[] = (res.payments || []).map(p => ({
        change_type: p.change_type,
        payment_method: p.payment_method,
        status: p.status,
        timeFmt: fmtTime(p.paid_at || p.created_at),
        amountAbs: Math.abs(Number(p.amount || 0)).toFixed(2),
        note: p.note,
      }));
      this.setData({ refund, refundItems, origOrder, payments });
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
    wx.showModal({
      title: '审批通过',
      content: '确认通过此退款单？通过后将扣减对应次数/库存，并回冲储值卡、退现金。',
      confirmText: '确认通过',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '审批中', mask: true });
        try {
          await callStaffApi('order.approveRefund', { saleOrderId: this.data.refundId });
          wx.hideLoading();
          wx.showToast({ title: '审批已通过', icon: 'success' });
          this.loadDetail();
        } catch (err: unknown) {
          wx.hideLoading();
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
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
    const reason = (this.data.rejectReason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请输入驳回原因', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '提交中', mask: true });
    try {
      await callStaffApi('order.rejectRefund', {
        saleOrderId: this.data.refundId,
        rejectedReason: reason,
      });
      wx.hideLoading();
      wx.showToast({ title: '已驳回', icon: 'success' });
      this.setData({ rejectPopup: false, rejectReason: '' });
      this.loadDetail();
    } catch (err: unknown) {
      wx.hideLoading();
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
