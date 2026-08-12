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
  commission_status: string;
  time_display?: string;
}

type Tab = 'sale' | 'service';
type Status = '待分配' | '已分配';

Page({
  data: {
    activeTab: 'sale' as Tab,
    saleStatus: '待分配' as Status,
    serviceStatus: '待分配' as Status,
    loading: false,
    orders: [] as Array<SalePayment | ServiceOrder>,
    page: 1,
    hasMore: true,
  },

  onLoad() {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    this.loadOrders();
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
    this.setData({ page: 1, orders: [], hasMore: true });
    return this.loadOrders();
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const tab = e.detail.name as Tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    this.reload();
  },

  onStatusChange(e: WechatMiniprogram.TouchEvent) {
    const status = e.currentTarget.dataset.status as Status;
    if (this.data.activeTab === 'sale') {
      if (this.data.saleStatus === status) return;
      this.setData({ saleStatus: status });
    } else {
      if (this.data.serviceStatus === status) return;
      this.setData({ serviceStatus: status });
    }
    this.reload();
  },

  async loadOrders() {
    if (!requireManager()) return;
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      if (this.data.activeTab === 'sale') {
        const data = await callStaffApi<{ payments: SalePayment[] }>('allocation.pendingPayments', {
          page: this.data.page,
          pageSize: 20,
          allocationStatus: this.data.saleStatus,
        });
        const list = data.payments || [];
        this.appendOrders(list.map(o => ({ ...o, time_display: this.formatTime(o.paid_at) })), list.length);
      } else {
        const data = await callStaffApi<{ orders: ServiceOrder[] }>('serviceCommission.pendingList', {
          page: this.data.page,
          pageSize: 20,
          commissionStatus: this.data.serviceStatus,
        });
        const list = data.orders || [];
        this.appendOrders(list.map(o => ({ ...o, time_display: this.formatDate(o.service_date) })), list.length);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
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
