// pages/order-list/order-list.ts — 订单列表
import { callStaffApi } from '../../utils/cloud';
import { STATUS_CLASS, formatDateTime } from '../../utils/formatters';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

type OrderStatus = '全部' | '待支付' | '待审批' | '已支付' | '部分支付' | '已完成' | '已退款' | '未审核' | '支付失败' | '已关闭' | '已作废';

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
  isActivity: boolean;
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
  business_date?: string;
  paid_at: string | null;
  opened_by: string | null;
  has_refund?: boolean;
  has_pending_refund?: boolean;
  is_activity?: boolean;
}

const STATUS_OPTIONS = [
  { text: '全部状态', value: '' },
  { text: '待支付（含部分支付）', value: '待支付' },
  { text: '部分支付', value: '部分支付' },
  { text: '待审批', value: '待审批' },
  { text: '已支付', value: '已支付' },
  { text: '已完成', value: '已完成' },
  { text: '已退款', value: '已退款' },
  { text: '支付失败', value: '支付失败' },
  { text: '已关闭', value: '已关闭' },
  { text: '未审核', value: '未审核' },
  { text: '已作废', value: '已作废' },
];

interface OrderListResponse {
  orders: RawOrderRow[];
  page: number;
  pageSize: number;
}

Page({
  data: {
    loading: false,
    isManager: false,
    status: '',
    statusOptions: STATUS_OPTIONS,
    searchInput: '',
    keyword: '',
    startDate: '',
    endDate: '',
    list: [] as OrderItem[],
    page: 1,
    hasMore: true,
    currentStaffId: '',
    // 来自代办区的预设过滤
    presetStatus: '',
  },

  _loaded: false,
  _loadToken: 0,

  onLoad(options) {
    this.setData({ isManager: isManager(), currentStaffId: app.globalData.staffWfId || '' });
    if (options.status) {
      const statusMap: Record<string, OrderStatus> = {
        pendingOffline: '待支付',
        pendingCreate: '待支付',
      };
      const status = statusMap[options.status] || '';
      this.setData({ status, presetStatus: options.status });
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

  onStatusChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ status: e.detail as unknown as string });
    this.resetAndLoad();
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchInput: e.detail as unknown as string });
  },

  onSearch() {
    this.setData({ keyword: this.data.searchInput.trim() });
    this.resetAndLoad();
  },

  onSearchClear() {
    this.setData({ searchInput: '', keyword: '' });
    this.resetAndLoad();
  },

  onStartDateChange(e: WechatMiniprogram.PickerChange) {
    const startDate = e.detail.value as string;
    if (this.data.endDate && startDate > this.data.endDate) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    this.setData({ startDate });
    this.resetAndLoad();
  },

  onEndDateChange(e: WechatMiniprogram.PickerChange) {
    const endDate = e.detail.value as string;
    if (this.data.startDate && endDate < this.data.startDate) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' });
      return;
    }
    this.setData({ endDate });
    this.resetAndLoad();
  },

  clearDates() {
    this.setData({ startDate: '', endDate: '' });
    this.resetAndLoad();
  },

  resetAndLoad() {
    this._loadToken += 1;
    this.setData({ list: [], page: 1, hasMore: true, loading: false });
    return this.loadList();
  },

  async loadList() {
    if (this.data.loading || !this.data.hasMore) return;
    const loadToken = this._loadToken;
    this.setData({ loading: true });
    try {
      const res = await callStaffApi<OrderListResponse>('order.list', {
        status: this.data.status || undefined,
        keyword: this.data.keyword || undefined,
        startDate: this.data.startDate || undefined,
        endDate: this.data.endDate || undefined,
        page: this.data.page,
        pageSize: 20,
      });
      const rows = res?.orders || [];
      if (loadToken !== this._loadToken) return;
      const mapped: OrderItem[] = rows.map(r => ({
        id: r.sale_order_id,
        saleOrderId: r.sale_order_id,
        customerName: r.customer_name || '',
        customerPhoneMasked: r.client_phone || '',
        status: r.status as OrderStatus,
        orderType: r.sale_order_type,
        payType: r.payment_method,
        totalAmount: r.total_amount,
        createdAt: formatDateTime(r.business_date || r.created_at),
        paidAt: r.paid_at ? formatDateTime(r.paid_at) : r.paid_at,
        statusClass: STATUS_CLASS[r.status] || 'pending',
        openedBy: r.opened_by || null,
        hasRefund: !!r.has_refund,
        hasPendingRefund: !!r.has_pending_refund,
        isActivity: !!r.is_activity,
      }));
      this.setData({
        list: [...this.data.list, ...mapped],
        hasMore: mapped.length === 20,
        page: this.data.page + 1,
      });
    } catch (err: unknown) {
      if (loadToken !== this._loadToken) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      if (loadToken === this._loadToken) this.setData({ loading: false });
    }
  },

  onReachBottom() {
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
});
