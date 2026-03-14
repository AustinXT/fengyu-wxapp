// pages/order-detail/order-detail.ts
import { callStaffApi } from '../../utils/cloud';
import { isManager, getStaffWfId } from '../../utils/role';
import { STATUS_CLASS, ORDER_TYPE_LABEL, formatDateTime } from '../../utils/formatters';

const PAY_TYPE_LABEL: Record<string, string> = {
  wechat: '微信支付',
  offline: '线下收款',
};

const ORDER_SOURCE_LABEL: Record<string, string> = {
  client: '顾客下单',
  staff: '员工开单',
};

Page({
  data: {
    loading: false,
    order: null as any,
    isManager: false,
    isCreator: false,
    statusClass: '',
    _saleOrderId: '',
    // P2: 退款
    showRefundDialog: false,
    refundReason: '',
    submitting: false,
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
      const res = await callStaffApi<any>('order.detail', { orderNo: saleOrderId });
      const o = res.order || {};
      const items = (res.items || []).map((it: any) => ({
        saleItemId: it.sale_item_id,
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
          saleOrderId: o.sale_order_id,
          status: o.status,
          storeName: o.store_name || '',
          orderType: o.sale_order_type || o.order_type,
          orderTypeLabel: ORDER_TYPE_LABEL[o.sale_order_type || o.order_type] || o.sale_order_type || o.order_type,
          orderSourceLabel: ORDER_SOURCE_LABEL[o.sale_order_source || o.order_source] || o.sale_order_source || o.order_source || '—',
          refundReason: o.refund_reason || '',
          refOrderId: o.ref_sale_order_id || '',
          payType: o.payment_method,
          payTypeLabel: PAY_TYPE_LABEL[o.payment_method] || o.payment_method || '—',
          customerName: o.customer_name || '',
          customerPhone: o.client_phone || '',
          customerPhoneMasked: o.client_phone ? o.client_phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '',
          preferredStaffName: o.preferred_staff_name || '',
          confirmedBy: o.offline_confirmed_by,
          confirmedAt: formatDateTime(o.offline_confirmed_at),
          createdAt: formatDateTime(o.created_at),
          paidAt: formatDateTime(o.paid_at),
          totalAmount: o.totalAmount || o.total_amount,
          items,
          allocation,
        },
        isCreator: o.opened_by === getStaffWfId(),
        statusClass: STATUS_CLASS[o.status] || 'pending',
      });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReAllocation() {
    const saleOrderId = this.data._saleOrderId;
    wx.navigateTo({ url: `/packageOrder/revenue-allocation/revenue-allocation?orderNo=${saleOrderId}` });
  },

  onResetFailed() {
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '重置支付',
      content: '确认将此订单重置为"待支付"状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.resetFailed', { orderNo: saleOrderId });
          wx.showToast({ title: '已重置', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  async onConfirmOffline() {
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.confirmOffline', { orderNo: saleOrderId });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onCloseOrder() {
    const saleOrderId = this.data._saleOrderId;
    wx.showModal({
      title: '取消订单',
      content: '确认取消该订单？取消后不可恢复。',
      confirmText: '确认取消',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.close', { orderNo: saleOrderId });
          wx.showToast({ title: '订单已取消', icon: 'success' });
          this.loadDetail(saleOrderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onBackToWorkbench() {
    wx.switchTab({ url: '/pages/workbench/workbench' });
  },

  onShowQrcode() {
    const o = this.data.order;
    const params = `orderNo=${o.saleOrderId}&customerName=${encodeURIComponent(o.customerName)}&totalAmount=${o.totalAmount}`;
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
      // 默认全部项目退款
      const items = order.items.map((it: any) => ({ saleItemId: it.saleItemId }));
      await callStaffApi('order.createRefund', {
        refSaleOrderId: order.saleOrderId,
        items,
        refundReason: refundReason.trim(),
      });
      this.setData({ showRefundDialog: false });
      wx.showToast({ title: '退款单已创建', icon: 'success' });
      this.loadDetail(this.data._saleOrderId);
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onCancelRefund() {
    this.setData({ showRefundDialog: false });
  },

  // ===== P2: 审批退款 =====
  onApproveRefund() {
    wx.showModal({
      title: '审批退款',
      content: '确认通过此退款申请？审批后将扣减对应次数。',
      confirmText: '通过',
      confirmColor: '#C0322A',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.approveRefund', { saleOrderId: this.data._saleOrderId });
          wx.showToast({ title: '退款已审批', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onRejectRefund() {
    wx.showModal({
      title: '驳回退款',
      content: '确认驳回此退款申请？',
      confirmText: '驳回',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.rejectRefund', { saleOrderId: this.data._saleOrderId });
          wx.showToast({ title: '退款已驳回', icon: 'success' });
          this.loadDetail(this.data._saleOrderId);
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
