
import Toast from '@vant/weapp/toast/toast';
import { getStatusClass, formatOrderDate } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';
import { ORDERS_ENTRY_ENABLED } from '../../utils/feature-flags';

const PAGE_SIZE = 20;

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
    loadingMore: false,
    loadError: false,
    hasMore: true,
  },

  _page: 1,

  onLoad(options) {
    
    
    if (!ORDERS_ENTRY_ENABLED) {
      wx.showToast({ title: '订单功能即将开放', icon: 'none' });
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    const { status } = options as { status?: string };
    if (status) {
      this.setData({ activeTab: status });
    }
    
  },

  onShow() {
    
    if (!ORDERS_ENTRY_ENABLED) return;
    this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
    this.setData({ activeTab: e.detail.name });
    this.loadOrders();
  },

  
  
  _buildListPayload(page: number): Record<string, any> {
    const payload: Record<string, any> = { page, pageSize: PAGE_SIZE };
    const tab = this.data.activeTab;
    if (tab === '待支付') {
      payload.statuses = ['待支付', '部分支付'];
    } else if (tab !== 'all') {
      payload.status = tab;
    }
    return payload;
  },

  _mapOrders(orders: any[]) {
    return orders.map(item => {
      
      
      const hasAppointable = item.status === '已支付'
        && (item.items || []).some((i: any) => {
          if (i.product_type === '家居产品') return false;
          const total = Number(i.session_count ?? 0);
          const remaining = Number(i.remaining_sessions ?? 0);
          const paid = Number(i.paid_sessions ?? 0);
          const used = Math.max(0, total - remaining);
          return paid > 0 && (paid - used) > 0;
        });
      const itemCount = (item.items || []).reduce((sum: number, i: any) => sum + (i.quantity || 1), 0);
      
      
      
      const hasRefund = Number(item.refunded_amount || 0) > 0;
      
      const mappedItems = (item.items || []).map((i: any) => {
        const total = Number(i.session_count ?? 0);
        const remaining = Number(i.remaining_sessions ?? 0);
        const paidNull = i.paid_sessions == null;
        const paid = Number(i.paid_sessions ?? 0);
        return {
          ...i,
          paid_sessions: paid,
          // NULL 卡（0040 前未回填）：wxml 据此把「已付 0」改显「已付 —」
          paid_sessions_null: paidNull,
          used_sessions: Math.max(0, total - remaining),
        };
      });
      
      
      const isPartialPay = item.status === '部分支付';
      let outstanding = 0;
      if (isPartialPay) {
        const payable = Number(item.payable_amount ?? 0) > 0
          ? Number(item.payable_amount)
          : Math.round((Number(item.total_amount || 0) - Number(item.prepaid_card_amount || 0)) * 100) / 100;
        const net = Math.round((Number(item.received ?? 0) - Number(item.refunded_amount ?? 0)) * 100) / 100;
        outstanding = Math.max(0, Math.round((payable - net) * 100) / 100);
      }
      return {
        ...item,
        items: mappedItems,
        statusClass: getStatusClass(item.status),
        order_time_fmt: formatOrderDate(item.sale_order_datetime),
        hasAppointable,
        itemCount,
        has_refund: hasRefund,
        isRecharge: item.sale_order_type === '充值单',
        isPartialPay,
        outstanding_fmt: outstanding.toFixed(2),
      };
    });
  },

  async loadOrders() {
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const payload = this._buildListPayload(1);
      const data = await callClientApi('order.list', payload);
      const orders: any[] = data?.orders || [];
      this.setData({
        list: this._mapOrders(orders),
        hasMore: data?.hasMore ?? false,
      });
    } catch {
      Toast.fail('加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async loadMore() {
    this._page += 1;
    this.setData({ loadingMore: true });
    try {
      const payload = this._buildListPayload(this._page);
      const data = await callClientApi('order.list', payload);
      const orders: any[] = data?.orders || [];
      this.setData({
        list: [...this.data.list, ...this._mapOrders(orders)],
        hasMore: data?.hasMore ?? false,
      });
    } catch {
      
      this._page -= 1;
      Toast.fail('加载更多失败');
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onOrderTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
  },

  onPayTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/checkout/checkout?saleOrderId=${saleOrderId}` });
  },

  
  onContinuePayTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}&repay=1` });
  },

  async onCancelTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    try {
      const res = await wx.showModal({
        title: '确认取消',
        content: '确定要取消该订单吗？取消后无法恢复。',
        confirmText: '确定取消',
        confirmColor: '#FF4D4F',
      });
      if (!res.confirm) return;
      Toast.loading({ message: '取消中...', forbidClick: true, duration: 0 });
      await callClientApi('order.cancel', { saleOrderId });
      Toast.success('订单已取消');
      this.loadOrders();
    } catch (err: any) {
      Toast.fail(err.message || '取消失败');
    }
  },

  onAppointmentTap(e: WechatMiniprogram.TouchEvent) {
    const { saleOrderId } = e.currentTarget.dataset as { saleOrderId: string };
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleOrderId=${saleOrderId}` });
  },

  onShareAppMessage() {
    
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御订单', path: `/pages/home/home${invSuffix}` };
  },
});
