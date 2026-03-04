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

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

Page({
  data: {
    order: null as any,
    statusIcon: 'clock-o',
    statusIconColor: '#FAAD14',
    hasAppointableItems: false,
    isLoading: true,
    countdown: '',
  },

  _countdownTimer: null as any,

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
      const data = await callClientApi('order.detail', { orderNo });
      const order = data?.order || {};
      const items = data?.items || [];
      const d = new Date(order.order_datetime);
      const iconMeta = STATUS_ICON[order.status] || STATUS_ICON['已关闭'];

      // 是否有可预约项目（已支付 + 剩余次数 > 0 + 非院装）
      const hasAppointableItems = order.status === '已支付'
        && items.some((i: any) =>
            i.product_type !== '院装产品' && (i.remaining_sessions ?? 0) > 0
          );

      // 格式化支付到期时间
      let expireTimeFmt = '';
      if (order.status === '待支付' && order.expire_at) {
        const ed = new Date(order.expire_at);
        expireTimeFmt = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
      }

      this.setData({
        order: {
          ...order,
          items,
          order_time_fmt: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
          expire_time_fmt: expireTimeFmt,
        },
        statusIcon: iconMeta.icon,
        statusIconColor: iconMeta.color,
        hasAppointableItems,
      });

      // 启动倒计时
      this.startCountdown(order);
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  startCountdown(order: any) {
    // 清理旧定时器
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }

    if (order.status !== '待支付' || !order.expire_at) {
      this.setData({ countdown: '' });
      return;
    }

    const tick = () => {
      const remaining = new Date(order.expire_at).getTime() - Date.now();
      if (remaining <= 0) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        this.setData({ countdown: '' });
        // 超时刷新页面
        this.loadDetail(order.order_no);
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      this.setData({
        countdown: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
      });
    };

    tick();
    this._countdownTimer = setInterval(tick, 1000);
  },

  onUnload() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  onPay() {
    const { order_no } = this.data.order;
    wx.navigateTo({ url: `/pagesOrder/checkout/checkout?orderNo=${order_no}` });
  },

  async onCancel() {
    const { order_no } = this.data.order;
    try {
      await wx.showModal({
        title: '确认取消',
        content: '确定要取消该订单吗？取消后无法恢复。',
        confirmText: '确定取消',
        confirmColor: '#FF4D4F',
      }).then(res => {
        if (!res.confirm) throw new Error('USER_CANCELLED');
      });

      Toast.loading({ message: '取消中...', forbidClick: true, duration: 0 });
      await callClientApi('order.cancel', { orderNo: order_no });
      Toast.success('订单已取消');
      this.loadDetail(order_no);
    } catch (err: any) {
      if (err.message !== 'USER_CANCELLED') {
        Toast.fail(err.message || '取消失败');
      }
    }
  },

  onBackToHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  onCreateAppointment() {
    const { order_no } = this.data.order;
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?orderNo=${order_no}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pagesOrder/orders/orders' };
  },
});
