// pages/orders/orders.ts
import Toast from '@vant/weapp/toast/toast';
import { getStatusClass, formatOrderDate } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

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
    const { status } = options as { status?: string };
    if (status) {
      this.setData({ activeTab: status });
    }
    // 不在此处加载，由 onShow 统一处理（避免首次进入双重请求）
  },

  onShow() {
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

  _mapOrders(orders: any[]) {
    return orders.map(item => {
      // 可预约判定：已支付 + 至少一项有"已付未用"次数（paid_sessions - used > 0）
      // ticket 2026-05-19 paid_sessions：可消费门槛由 remaining > 0 升级为"还有已付未用的次数"
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
      // 2026-04-26 sale-order-domain-refactor:
      //   - 已退款标签由 refunded_amount > 0 推导
      //   - 后端列表接口已返回 received / refunded_amount
      const hasRefund = Number(item.refunded_amount || 0) > 0;
      // 列表项三段次数展示（ticket 2026-05-19）
      const mappedItems = (item.items || []).map((i: any) => {
        const total = Number(i.session_count ?? 0);
        const remaining = Number(i.remaining_sessions ?? 0);
        const paid = Number(i.paid_sessions ?? 0);
        return {
          ...i,
          paid_sessions: paid,
          used_sessions: Math.max(0, total - remaining),
        };
      });
      return {
        ...item,
        items: mappedItems,
        statusClass: getStatusClass(item.status),
        order_time_fmt: formatOrderDate(item.sale_order_datetime),
        hasAppointable,
        itemCount,
        has_refund: hasRefund,
      };
    });
  },

  async loadOrders() {
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const payload: Record<string, any> = { page: 1, pageSize: PAGE_SIZE };
      if (this.data.activeTab !== 'all') {
        payload.status = this.data.activeTab;
      }
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
      const payload: Record<string, any> = { page: this._page, pageSize: PAGE_SIZE };
      if (this.data.activeTab !== 'all') {
        payload.status = this.data.activeTab;
      }
      const data = await callClientApi('order.list', payload);
      const orders: any[] = data?.orders || [];
      this.setData({
        list: [...this.data.list, ...this._mapOrders(orders)],
        hasMore: data?.hasMore ?? false,
      });
    } catch {
      // 加载更多失败，回退页码，用户可重试
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
    // 分享礼：被分享人进入首页而非分享者的订单列表
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御订单', path: `/pages/home/home${invSuffix}` };
  },
});
