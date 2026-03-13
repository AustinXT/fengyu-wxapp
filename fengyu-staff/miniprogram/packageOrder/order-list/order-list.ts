// pages/order-list/order-list.ts — 订单列表（仅店长）
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';

type OrderStatus = '全部' | '待支付' | '待确认收款' | '已支付' | '已完成' | '支付失败' | '已关闭';

interface OrderItem {
  id: string;
  saleOrderId: string;
  customerName: string;
  customerPhoneMasked: string;
  status: OrderStatus;
  orderType: string;
  payType: string | null;
  totalAmount: string;
  createdAt: string;
  paidAt: string | null;
  statusClass: string;
}

const STATUS_CLASS: Record<string, string> = {
  '待支付': 'pending',
  '待确认收款': 'pending',
  '已支付': 'success',
  '已完成': 'done',
  '支付失败': 'error',
  '已关闭': 'done',
};

Page({
  data: {
    loading: false,
    tabActive: '全部',
    list: [] as OrderItem[],
    // 来自代办区的预设过滤
    presetStatus: '',
  },

  onLoad(options) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    if (options.status) {
      const statusMap: Record<string, OrderStatus> = {
        pendingOffline: '待确认收款',
        pendingCreate: '待支付',
      };
      const tab = statusMap[options.status] || '全部';
      this.setData({ tabActive: tab, presetStatus: options.status });
    }
    this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ tabActive: e.detail.name });
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      const tabStatus = this.data.tabActive === '全部' ? undefined : this.data.tabActive;
      const res = await callStaffApi<{ orders: any[]; page: number; pageSize: number }>('order.list', {
        status: tabStatus,
      });
      const rows = res?.orders || [];
      const mapped: OrderItem[] = rows.map(r => ({
        id: r.sale_order_id,
        saleOrderId: r.sale_order_id,
        customerName: r.customer_name || '',
        customerPhoneMasked: r.client_phone || '',
        status: r.status,
        orderType: r.order_type,
        payType: r.payment_method,
        totalAmount: r.total_amount,
        createdAt: r.created_at,
        paidAt: r.paid_at,
        statusClass: STATUS_CLASS[r.status] || 'pending',
      }));
      this.setData({ list: mapped });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-detail/order-detail?id=${id}` });
  },

  noop() {},

  async onConfirmOffline(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.showModal({
      title: '确认线下收款',
      content: '确认已收到顾客的现金/转账付款？',
      confirmText: '确认收款',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.confirmOffline', { orderNo: id });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.loadList();
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },
});
