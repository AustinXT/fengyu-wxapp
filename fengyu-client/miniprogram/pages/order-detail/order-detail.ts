// pages/order-detail/order-detail.ts
import Toast from '@vant/weapp/toast/toast';

const STATUS_ICON: Record<string, { icon: string; color: string }> = {
  '待支付':     { icon: 'clock-o',   color: '#FAAD14' },
  '待确认收款': { icon: 'clock-o',   color: '#C9986A' },
  '已支付':     { icon: 'passed',    color: '#52C41A' },
  '已完成':     { icon: 'success',   color: '#8C8C8C' },
  '支付失败':   { icon: 'close',     color: '#FF4D4F' },
  '已关闭':     { icon: 'close',     color: '#8C8C8C' },
};

Page({
  data: {
    order: null as any,
    statusIcon: 'clock-o',
    statusIconColor: '#FAAD14',
    hasAppointableItems: false,
    isLoading: true,
  },

  onLoad(options) {
    const { orderNo } = options as { orderNo: string };
    if (orderNo) this.loadDetail(orderNo);
  },

  onShow() {
    // 从预约页返回时刷新剩余次数
    if (this.data.order?.order_no) {
      this.loadDetail(this.data.order.order_no);
    }
  },

  onPullDownRefresh() {
    if (this.data.order?.order_no) {
      this.loadDetail(this.data.order.order_no).finally(() => wx.stopPullDownRefresh());
    }
  },

  async loadDetail(orderNo: string) {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'getOrderDetail', data: { orderNo } }) as any;
      const order = res.result?.data || {};
      const d = new Date(order.order_datetime);
      const iconMeta = STATUS_ICON[order.status] || STATUS_ICON['已关闭'];

      // 是否有可预约项目（已支付 + 剩余次数 > 0 + 非院装）
      const hasAppointableItems = order.status === '已支付'
        && (order.items || []).some((i: any) =>
            i.product_type !== '院装产品' && (i.remaining_sessions ?? 0) > 0
          );

      this.setData({
        order: {
          ...order,
          order_time_fmt: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
        },
        statusIcon: iconMeta.icon,
        statusIconColor: iconMeta.color,
        hasAppointableItems,
      });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onPay() {
    const { order_no } = this.data.order;
    wx.navigateTo({ url: `/pages/checkout/checkout?orderNo=${order_no}` });
  },

  onCreateAppointment() {
    const { order_no } = this.data.order;
    wx.navigateTo({ url: `/pages/appointment-create/appointment-create?orderNo=${order_no}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pages/orders/orders' };
  },
});
