// pages/orders/orders.ts
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
    // 临时关闭：订单列表入口兜底拦截（业务平稳后恢复）。见 utils/feature-flags.ts
    // 显式入口已隐藏，此处防遗漏/直达；订单列表纯主动查看，无支付闭环依赖
    if (!ORDERS_ENTRY_ENABLED) {
      wx.showToast({ title: '订单功能即将开放', icon: 'none' });
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    const { status } = options as { status?: string };
    if (status) {
      this.setData({ activeTab: status });
    }
    // 不在此处加载，由 onShow 统一处理（避免首次进入双重请求）
  },

  onShow() {
    // 临时关闭期间不发起列表请求（见 utils/feature-flags.ts）
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

  // 构造 order.list 请求参数：「待支付」Tab 同时纳入 部分支付（statuses 数组），
  // 其余 Tab 走单值 status，「全部」不带过滤
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
      // 可预约判定：有效收款状态 + 至少一项有"已付未用"次数（paid_sessions - used > 0）
      // ticket 2026-05-19 paid_sessions：可消费门槛由 remaining > 0 升级为"还有已付未用的次数"
      const appointableStatus = ['已支付', '部分支付', '已完成'].includes(item.status);
      const hasAppointable = appointableStatus
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
      const hasRefund = Number(item.refunded_amount || 0) > 0 && item.status !== '已退款';
      // 列表项三段次数展示（ticket 2026-05-19）
      const mappedItems = (item.items || []).map((i: any) => {
        const total = Number(i.session_count ?? 0);
        const remaining = Number(i.remaining_sessions ?? 0);
        const paidNull = i.paid_sessions == null;
        const paid = Number(i.paid_sessions ?? 0);
        return {
          ...i,
          unit: i.unit || (i.product_type === '家居产品' ? '盒' : '次'),
          paid_sessions: paid,
          // NULL 卡（0040 前未回填）：wxml 据此把「已付 0」改显「已付 —」
          paid_sessions_null: paidNull,
          used_sessions: Math.max(0, total - remaining),
        };
      });
      // 行级口径待付额（与 order-detail.ts 一致）：已退行不计入，只有「未退且未付清」的行可继续支付。
      // sale_items.received 为行净额；未退行 received净 = received毛。
      const isPartialPay = item.status === '部分支付';
      let outstanding = 0;
      if (isPartialPay) {
        let sum = 0;
        for (const i of mappedItems) {
          const refunded = Number(i.refunded_amount || 0);
          if (refunded > 0) continue;
          sum += Math.max(0, Number(i.sale_amount || 0) - Number(i.received || 0));
        }
        outstanding = Math.round(sum * 100) / 100;
      }
      const canContinuePay = isPartialPay && outstanding > 0;
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
        canContinuePay,
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

  // 部分支付订单回款：跳详情页并自动唤起回款弹层（复用 order-detail 已有流程）
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
    // 分享礼：被分享人进入首页而非分享者的订单列表
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御订单', path: `/pages/home/home${invSuffix}` };
  },
});
