// pages/order-list/order-list.ts — 订单列表
import { callStaffApi } from '../../utils/cloud';
import { formatDateTime } from '../../utils/formatters';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

type OrderStatus = '全部' | '待支付' | '已支付' | '已完成' | '支付失败' | '已关闭';

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
  openedBy: string | null;
  hasRefund: boolean;
  hasPendingRefund: boolean;
}

interface RawOrderRow {
  sale_order_id: string;
  customer_name: string;
  client_phone: string;
  status: string;
  sale_order_type: string;
  payment_method: string | null;
  total_amount: string;
  created_at: string;
  paid_at: string | null;
  opened_by: string | null;
  has_refund?: boolean;
  has_pending_refund?: boolean;
}

interface OrderListResponse {
  orders: RawOrderRow[];
  page: number;
  pageSize: number;
}

const STATUS_CLASS: Record<string, string> = {
  '待支付': 'pending',
  '已支付': 'success',
  '已完成': 'done',
  '支付失败': 'error',
  '已关闭': 'done',
};

Page({
  data: {
    loading: false,
    isManager: false,
    tabActive: '全部',
    list: [] as OrderItem[],
    page: 1,
    hasMore: true,
    currentStaffId: '',
    // 来自代办区的预设过滤
    presetStatus: '',
  },

  _loaded: false,

  onLoad(options) {
    this.setData({ isManager: isManager(), currentStaffId: app.globalData.staffWfId || '' });
    if (options.status) {
      const statusMap: Record<string, OrderStatus> = {
        pendingOffline: '待支付',
        pendingCreate: '待支付',
      };
      const tab = statusMap[options.status] || '全部';
      this.setData({ tabActive: tab, presetStatus: options.status });
    }
    this.resetAndLoad();
    this._loaded = true;
  },

  onShow() {
    // 首次由 onLoad 加载，后续 navigateBack 回来时刷新
    if (this._loaded) {
      this.resetAndLoad();
    }
  },

  onPullDownRefresh() {
    this.resetAndLoad().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ tabActive: e.detail.name });
    this.resetAndLoad();
  },

  resetAndLoad() {
    this.setData({ list: [], page: 1, hasMore: true });
    return this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const tabStatus = this.data.tabActive === '全部' ? undefined : this.data.tabActive;
      const res = await callStaffApi<OrderListResponse>('order.list', {
        status: tabStatus,
        page: this.data.page,
        pageSize: 20,
      });
      const rows = res?.orders || [];
      const mapped: OrderItem[] = rows.map(r => ({
        id: r.sale_order_id,
        saleOrderId: r.sale_order_id,
        customerName: r.customer_name || '',
        customerPhoneMasked: r.client_phone || '',
        status: r.status as OrderStatus,
        orderType: r.sale_order_type,
        payType: r.payment_method,
        totalAmount: r.total_amount,
        createdAt: formatDateTime(r.created_at),
        paidAt: r.paid_at ? formatDateTime(r.paid_at) : r.paid_at,
        statusClass: STATUS_CLASS[r.status] || 'pending',
        openedBy: r.opened_by || null,
        hasRefund: !!r.has_refund,
        hasPendingRefund: !!r.has_pending_refund,
      }));
      this.setData({
        list: [...this.data.list, ...mapped],
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
          await callStaffApi('order.confirmOffline', { saleOrderId: id });
          wx.showToast({ title: '收款已确认', icon: 'success' });
          this.resetAndLoad();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        }
      }
    });
  },

  onViewQrcode(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${id}` });
  },

  onCloseOrder(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.showModal({
      title: '关闭订单',
      content: '确定要关闭该订单吗？关闭后不可恢复。',
      confirmText: '确认关闭',
      confirmColor: '#D94040',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.close', { saleOrderId: id });
          wx.showToast({ title: '订单已关闭', icon: 'success' });
          this.resetAndLoad();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        }
      }
    });
  },

  onResetFailed(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.showModal({
      title: '重置支付状态',
      content: '确定将该订单重置为待支付状态？',
      confirmText: '确认重置',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('order.resetFailed', { saleOrderId: id });
          wx.showToast({ title: '已重置为待支付', icon: 'success' });
          this.resetAndLoad();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
        }
      }
    });
  },

  onAllocate(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/packageOrder/revenue-allocation/revenue-allocation?saleOrderId=${id}` });
  },
});
