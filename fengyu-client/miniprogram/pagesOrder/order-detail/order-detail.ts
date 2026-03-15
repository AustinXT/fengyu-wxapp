// pages/order-detail/order-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';

interface OrderDetailItem {
  sale_item_id: string;
  product_name: string;
  sku_spec_name: string;
  product_type: string;
  session_count: number;
  remaining_sessions: number | null;
  unit_price: number;
  quantity: number;
  received: number;
  expire_date: string | null;
}

interface OrderDetailData {
  sale_order_id: string;
  status: string;
  sale_order_type: string;
  sale_order_datetime: string;
  store_name: string;
  total_amount: number;
  payment_method: string;
  preferred_employee_id: string | null;
  preferred_staff_name: string | null;
  coupon_id: string | null;
  coupon_discount: number;
  coupon_name: string | null;
  expire_at: string | null;
  items?: OrderDetailItem[];
  order_time_fmt?: string;
  expire_time_fmt?: string;
}

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
    order: null as OrderDetailData | null,
    statusIcon: 'clock-o',
    statusIconColor: '#FAAD14',
    hasAppointableItems: false,
    isLoading: true,
    countdown: '',
  },

  _countdownTimer: null as number | null,

  onLoad(options) {
    const { saleOrderId, orderNo } = options as { saleOrderId?: string; orderNo?: string };
    const id = saleOrderId || orderNo;
    if (id) this.loadDetail(id);
  },

  onShow() {
    // 从预约页返回时刷新剩余次数
    if (this.data.order?.sale_order_id) {
      this.loadDetail(this.data.order.sale_order_id);
    }
  },

  onPullDownRefresh() {
    if (this.data.order?.sale_order_id) {
      this.loadDetail(this.data.order.sale_order_id).finally(() => wx.stopPullDownRefresh());
    }
  },

  async loadDetail(saleOrderId: string) {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('order.detail', { saleOrderId });
      const order = (data?.order || {}) as OrderDetailData;
      const items: OrderDetailItem[] = data?.items || [];
      const rawDt = String(order.sale_order_datetime);
      const d = new Date(rawDt.includes('T') ? rawDt : rawDt.replace(/-/g, '/'));
      const iconMeta = STATUS_ICON[order.status] || STATUS_ICON['已关闭'];

      // 是否有可预约项目（已支付 + 剩余次数 > 0 + 非院装）
      const hasAppointableItems = order.status === '已支付'
        && items.some(i =>
            i.product_type !== '院装产品' && (i.remaining_sessions ?? 0) > 0
          );

      // 格式化支付到期时间
      let expireTimeFmt = '';
      if (order.status === '待支付' && order.expire_at) {
        const rawExp = String(order.expire_at);
        const ed = new Date(rawExp.includes('T') ? rawExp : rawExp.replace(/-/g, '/'));
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

  startCountdown(order: OrderDetailData) {
    // 清理旧定时器
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer!);
      this._countdownTimer = null;
    }

    if (order.status !== '待支付' || !order.expire_at) {
      this.setData({ countdown: '' });
      return;
    }

    const tick = () => {
      const rawExpire = String(order.expire_at);
      const remaining = new Date(rawExpire.includes('T') ? rawExpire : rawExpire.replace(/-/g, '/')).getTime() - Date.now();
      if (remaining <= 0) {
        clearInterval(this._countdownTimer!);
        this._countdownTimer = null;
        this.setData({ countdown: '' });
        // 超时刷新页面
        this.loadDetail(order.sale_order_id);
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
      clearInterval(this._countdownTimer!);
      this._countdownTimer = null;
    }
  },

  onCopyOrderNo() {
    const id = this.data.order?.sale_order_id;
    if (!id) return;
    wx.setClipboardData({
      data: id,
      success: () => Toast.success('已复制订单号'),
    });
  },

  onPay() {
    if (!this.data.order?.sale_order_id) return;
    const { sale_order_id } = this.data.order;
    wx.navigateTo({ url: `/pagesOrder/checkout/checkout?saleOrderId=${sale_order_id}` });
  },

  async onCancel() {
    if (!this.data.order?.sale_order_id) return;
    const { sale_order_id } = this.data.order;
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
      await callClientApi('order.cancel', { saleOrderId: sale_order_id });
      Toast.success('订单已取消');
      this.loadDetail(sale_order_id);
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
    if (!this.data.order?.sale_order_id) return;
    const { sale_order_id } = this.data.order;
    wx.navigateTo({ url: `/pagesAppointment/appointment-create/appointment-create?saleOrderId=${sale_order_id}` });
  },

  onShareAppMessage() {
    return { title: '凤御订单', path: '/pagesOrder/orders/orders' };
  },
});
