// packageOrder/refund-list/refund-list.ts — 退款单列表
import { callStaffApi } from '../../utils/cloud';

type TabStatus = '待审批' | '已支付' | '已关闭';

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
  statusLabel: string;
  statusClass: 'pending' | 'approved' | 'rejected';
}

interface RefundListResponse {
  refunds: RawRefund[];
  page: number;
  pageSize: number;
}

const STATUS_META: Record<TabStatus, { label: string; cls: DisplayRefund['statusClass'] }> = {
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
    loading: false,
    tabActive: '待审批' as TabStatus,
    refunds: [] as DisplayRefund[],
    page: 1,
    hasMore: true,
  },

  _loaded: false,

  onLoad() {
    this.resetAndLoad();
    this._loaded = true;
  },

  onShow() {
    if (this._loaded) this.resetAndLoad();
  },

  onPullDownRefresh() {
    this.resetAndLoad().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ tabActive: e.detail.name as TabStatus });
    this.resetAndLoad();
  },

  resetAndLoad() {
    this.setData({ refunds: [], page: 1, hasMore: true });
    return this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const res = await callStaffApi<RefundListResponse>('order.refundList', {
        status: this.data.tabActive,
        page: this.data.page,
        pageSize: 20,
      });
      const rows = res?.refunds || [];
      const mapped: DisplayRefund[] = rows.map(r => {
        const total = Math.abs(Number(r.total_amount || 0));
        const fee = Number(r.handling_fee || 0);
        const meta = STATUS_META[r.status as TabStatus] ?? { label: r.status, cls: 'pending' as const };
        return {
          ...r,
          refund_abs: total.toFixed(2),
          handling_fee_display: fee > 0 ? fee.toFixed(2) : '',
          created_at_display: fmtTime(r.created_at),
          statusLabel: meta.label,
          statusClass: meta.cls,
        };
      });
      this.setData({
        refunds: [...this.data.refunds, ...mapped],
        hasMore: mapped.length === 20,
        page: this.data.page + 1,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    this.loadList();
  },

  onTapRefund(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/refund-detail/refund-detail?id=${id}` });
  },
});
