// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const STATUS_CLASS: Record<string, string> = {
  '待支付': 'pending',
  '待确认收款': 'pending',
  '已支付': 'success',
  '已完成': 'done',
  '支付失败': 'error',
  '已关闭': 'done',
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  正式: '正常单',
  促销方案: '促销方案',
  体验: '体验单',
};

const PAY_TYPE_LABEL: Record<string, string> = {
  wechat: '微信支付',
  offline: '线下收款',
};

const ORDER_SOURCE_LABEL: Record<string, string> = {
  client: '顾客下单',
  staff: '员工开单',
};

function formatTime(v: any): string {
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

Page({
  data: {
    loading: false,
    order: null as any,
    isManager: false,
    statusClass: '',
    _orderNo: '',
  },

  onLoad(options: Record<string, string>) {
    this.setData({ isManager: isManager() });
    if (options.id) {
      this.setData({ _orderNo: options.id });
      this.loadDetail(options.id);
    }
  },

  async loadDetail(orderNo: string) {
    this.setData({ loading: true });
    try {
      const res = await callStaffApi<any>('order.detail', { orderNo });
      const o = res.order || {};
      const items = (res.items || []).map((it: any) => ({
        itemFlowNo: it.item_flow_no,
        itemName: it.spu_name || it.sku_display_name || '—',
        spec: it.sku_display_name || '',
        totalPrice: it.receivable,
        sessionCount: it.session_count,
        remainingSessions: it.remaining_sessions,
      }));
      const allocation = (res.allocations || []).map((a: any) => ({
        staffName: a.employeeId,
        department: '',
        amount: a.totalAmount,
        ratio: `${Number(a.allocationRatio) * 100}%`,
      }));
      this.setData({
        order: {
          orderNo: o.order_no,
          status: o.status,
          storeName: o.store_name || '',
          orderType: o.order_type,
          orderTypeLabel: ORDER_TYPE_LABEL[o.order_type] || o.order_type,
          orderSourceLabel: ORDER_SOURCE_LABEL[o.order_source] || o.order_source || '—',
          payType: o.payment_method,
          payTypeLabel: PAY_TYPE_LABEL[o.payment_method] || o.payment_method || '—',
          customerName: o.customer_name || '',
          customerPhone: o.client_phone || '',
          customerPhoneMasked: o.client_phone ? o.client_phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '',
          preferredStaffName: o.preferred_staff_name || '',
          confirmedBy: o.offline_confirmed_by,
          confirmedAt: formatTime(o.offline_confirmed_at),
          createdAt: formatTime(o.created_at),
          paidAt: formatTime(o.paid_at),
          totalAmount: o.totalAmount || o.total_amount,
          items,
          allocation,
        },
        statusClass: STATUS_CLASS[o.status] || 'pending',
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReAllocation() {
    const orderNo = this.data._orderNo;
    wx.navigateTo({ url: `/pages/revenue-allocation/revenue-allocation?orderNo=${orderNo}` });
  },

  onResetFailed() {
    const orderNo = this.data._orderNo;
    wx.showModal({
      title: '重置支付',
      content: '确认将此订单重置为"待支付"状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.resetFailed', { orderNo });
          wx.showToast({ title: '已重置', icon: 'success' });
          this.loadDetail(orderNo);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  async onConfirmOffline() {
    const orderNo = this.data._orderNo;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.confirmOffline', { orderNo });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadDetail(orderNo);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
