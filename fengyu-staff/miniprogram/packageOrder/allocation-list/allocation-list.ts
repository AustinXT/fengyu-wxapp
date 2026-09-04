// packageOrder/allocation-list/allocation-list.ts — 营业额分配（销售提成 / 服务提成 双 Tab）
import { callStaffApi } from '../../utils/cloud';
import { safeParseDate } from '../../utils/formatters';
import { requireManager } from '../../utils/role';

// 销售提成分配单元已下沉到「回款事件」：列表展示每一笔回款（首次支付/回款/储值卡抵扣）
interface SalePayment {
  sale_payment_id: number;
  sale_order_id: string;
  change_type: string;
  amount: string;
  payment_method: string;
  customer_name: string;
  client_phone: string;
  paid_at: string;
  allocation_status: string;
  preferred_employee_id: string | null;
  time_display?: string;
}

interface ServiceOrder {
  service_order_id: string;
  customer_name: string;
  client_phone: string;
  employee_name: string;
  service_date: string;
  // 历史数据可能为 null（建单初值无 DB default）；云函数已 COALESCE 成「待分配」，wxml 仍做兜底
  commission_status: string | null;
  time_display?: string;
}

type Tab = 'sale' | 'service';
type Status = '全部' | '待分配' | '已分配';

const STATUS_OPTIONS = [
  { text: '全部状态', value: '全部' },
  { text: '待分配', value: '待分配' },
  { text: '已分配', value: '已分配' },
];

Page({
  data: {
    activeTab: 'sale' as Tab,
    saleStatus: '待分配' as Status,
    serviceStatus: '待分配' as Status,
    status: '待分配' as Status,
    statusOptions: STATUS_OPTIONS,
    searchInput: '',
    keyword: '',
    startDate: '',
    endDate: '',
    loading: false,
    orders: [] as Array<SalePayment | ServiceOrder>,
    page: 1,
    hasMore: true,
  },

  _loadToken: 0,

  onLoad() {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
  },

  onShow() {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    // 从详情页返回时刷新当前 Tab（状态可能已变）
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadOrders();
    }
  },

  reload() {
    this._loadToken += 1;
    this.setData({ page: 1, orders: [], hasMore: true, loading: false });
    return this.loadOrders();
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const tab = e.detail.name as Tab;
    if (tab === this.data.activeTab) return;
    this.setData({
      activeTab: tab,
      status: tab === 'sale' ? this.data.saleStatus : this.data.serviceStatus,
    });
    this.reload();
  },

  onStatusChange(e: WechatMiniprogram.CustomEvent) {
    const status = e.detail as unknown as Status;
    if (this.data.activeTab === 'sale') {
      if (this.data.saleStatus === status) return;
      this.setData({ saleStatus: status, status });
    } else {
      if (this.data.serviceStatus === status) return;
      this.setData({ serviceStatus: status, status });
    }
    this.reload();
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ searchInput: e.detail as unknown as string });
  },

  onSearch() {
    this.setData({ keyword: this.data.searchInput.trim() });
    this.reload();
  },

  onSearchClear() {
    this.setData({ searchInput: '', keyword: '' });
    this.reload();
  },

  onStartDateChange(e: WechatMiniprogram.PickerChange) {
    const startDate = e.detail.value as string;
    if (this.data.endDate && startDate > this.data.endDate) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    this.setData({ startDate });
    this.reload();
  },

  onEndDateChange(e: WechatMiniprogram.PickerChange) {
    const endDate = e.detail.value as string;
    if (this.data.startDate && endDate < this.data.startDate) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' });
      return;
    }
    this.setData({ endDate });
    this.reload();
  },

  clearDates() {
    this.setData({ startDate: '', endDate: '' });
    this.reload();
  },

  async loadOrders() {
    if (!requireManager()) return;
    if (this.data.loading) return;
    const loadToken = this._loadToken;
    this.setData({ loading: true });
    try {
      if (this.data.activeTab === 'sale') {
        const data = await callStaffApi<{ payments: SalePayment[] }>('allocation.pendingPayments', {
          page: this.data.page,
          pageSize: 20,
          allocationStatus: this.data.saleStatus,
          keyword: this.data.keyword || undefined,
          startDate: this.data.startDate || undefined,
          endDate: this.data.endDate || undefined,
        });
        if (loadToken !== this._loadToken) return;
        const list = data.payments || [];
        this.appendOrders(list.map(o => ({ ...o, time_display: this.formatTime(o.paid_at) })), list.length);
      } else {
        const data = await callStaffApi<{ orders: ServiceOrder[] }>('serviceCommission.pendingList', {
          page: this.data.page,
          pageSize: 20,
          commissionStatus: this.data.serviceStatus,
          keyword: this.data.keyword || undefined,
          startDate: this.data.startDate || undefined,
          endDate: this.data.endDate || undefined,
        });
        if (loadToken !== this._loadToken) return;
        const list = data.orders || [];
        this.appendOrders(list.map(o => ({ ...o, time_display: this.formatDate(o.service_date) })), list.length);
      }
    } catch (err: unknown) {
      if (loadToken !== this._loadToken) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      if (loadToken === this._loadToken) this.setData({ loading: false });
    }
  },

  appendOrders(formatted: Array<SalePayment | ServiceOrder>, count: number) {
    const orders = this.data.page === 1 ? formatted : [...this.data.orders, ...formatted];
    this.setData({
      orders,
      hasMore: count >= 20,
      page: this.data.page + 1,
    });
  },

  onTapOrder(e: WechatMiniprogram.TouchEvent) {
    if (!requireManager()) return;
    const id = e.currentTarget.dataset.id as string;
    if (this.data.activeTab === 'sale') {
      // 销售提成按回款逐笔分配：id = sale_payment_id
      wx.navigateTo({ url: `/packageOrder/revenue-allocation/revenue-allocation?salePaymentId=${id}` });
    } else {
      wx.navigateTo({ url: `/packageOrder/service-commission/service-commission?serviceOrderId=${id}` });
    }
  },

  formatTime(dateStr: string): string {
    const d = safeParseDate(dateStr);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  },

  formatDate(dateStr: string): string {
    const d = safeParseDate(dateStr);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },
});
