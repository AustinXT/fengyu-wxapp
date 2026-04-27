// pages/order-detail/order-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatDateTime } from '../../utils/format';

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
  // Ticket 2026-04-26 sale-order-domain-refactor:
  //   - 字段 paid_amount → received（已到账金额聚合快照）
  //   - 新增 refunded_amount（已退款金额聚合快照）
  //   - 欠款额 = payable_amount - (received - refunded_amount)
  payable_amount?: number;
  received?: number;
  refunded_amount?: number;
  prepaid_card_amount?: number;
  items?: OrderDetailItem[];
  order_time_fmt?: string;
  expire_time_fmt?: string;
  outstanding_fmt?: string;
  refunded_fmt?: string;
  has_refund?: boolean;
}

interface OrderPayment {
  change_type: string;
  amount: number;
  payment_method: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  note: string | null;
  refund_reason?: string | null;
  audit_at?: string | null;
  audit_remark?: string | null;
}

interface OrderPaymentView {
  change_type: string;
  amount: number;
  amount_abs_fmt: string;
  is_refund: boolean;
  payment_method: string;
  status: string;
  time_fmt: string;
  note: string | null;
  refund_reason: string | null;
  audit_remark: string | null;
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
    payments: [] as OrderPaymentView[],
    outstandingAmount: 0,
    // Ticket 2026-04-24 PR-C：继续支付灰度开关（由 app.globalData.continuePayEnabled 控制）
    continuePayEnabled: false,
    // 回款弹层
    repayModalVisible: false,
    repayAmountInput: '' as string,
    repayMethod: '微信' as '微信' | '支付宝' | '储值卡',
    repayUseCard: false,
    cardBalance: 0,
    repaySubmitting: false,
  },

  _countdownTimer: null as ReturnType<typeof setInterval> | null,

  onLoad(options) {
    // 读全局灰度开关（未配置默认 false）
    const app = getApp<IAppOption>();
    const enabled = !!(app.globalData as any).continuePayEnabled;
    this.setData({ continuePayEnabled: enabled });

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
      const paymentsRaw: OrderPayment[] = (data as any)?.payments || [];
      const iconMeta = STATUS_ICON[order.status] || STATUS_ICON['已关闭'];

      // 是否有可预约项目（已支付 + 剩余次数 > 0 + 非家居产品）
      const hasAppointableItems = order.status === '已支付'
        && items.some(i =>
            i.product_type !== '家居产品' && (i.remaining_sessions ?? 0) > 0
          );

      // 格式化支付到期时间（仅时间 HH:mm）
      let expireTimeFmt = '';
      if (order.status === '待支付' && order.expire_at) {
        const rawExp = String(order.expire_at);
        const ed = new Date(rawExp.includes('T') ? rawExp : rawExp.replace(/-/g, '/'));
        expireTimeFmt = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
      }

      // 款项流水视图（退款标红、金额绝对值显示）
      // 2026-04-26 sale-order-domain-refactor: 退款流水来自 sale_order_payments[change_type='退款']
      // 不再从独立的 sale_order_type='退款单' 行聚合
      const payments: OrderPaymentView[] = paymentsRaw.map((p) => {
        const amt = Number(p.amount) || 0;
        const isRefund = amt < 0 || p.change_type === '退款';
        const absAmt = Math.abs(amt);
        const timeSrc = p.paid_at || p.created_at;
        return {
          change_type: p.change_type,
          amount: amt,
          amount_abs_fmt: (Math.round(absAmt * 100) / 100).toFixed(2),
          is_refund: isRefund,
          payment_method: p.payment_method,
          status: p.status,
          time_fmt: timeSrc ? formatDateTime(timeSrc) : '',
          note: p.note,
          refund_reason: p.refund_reason ?? null,
          audit_remark: p.audit_remark ?? null,
        };
      });

      // 欠款额 = payable_amount - 净到账（received - refunded_amount）
      // 2026-04-26 sale-order-domain-refactor:
      //   - paid_amount 列已 DROP；接口现返回 received / refunded_amount
      //   - 净到账 = received - refunded_amount（与 backend invariant 对齐）
      const payable = Number(order.payable_amount ?? 0) > 0
        ? Number(order.payable_amount)
        : Math.round((Number(order.total_amount || 0) - Number(order.prepaid_card_amount || 0)) * 100) / 100;
      const received = Number(order.received ?? 0);
      const refundedAmount = Number(order.refunded_amount ?? 0);
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      const outstanding = Math.max(0, Math.round((payable - netReceived) * 100) / 100);
      const refundedFmt = refundedAmount.toFixed(2);
      const hasRefund = refundedAmount > 0;

      this.setData({
        order: {
          ...order,
          items,
          order_time_fmt: formatDateTime(order.sale_order_datetime),
          expire_time_fmt: expireTimeFmt,
          outstanding_fmt: outstanding.toFixed(2),
          refunded_fmt: refundedFmt,
          has_refund: hasRefund,
        },
        statusIcon: iconMeta.icon,
        statusIconColor: iconMeta.color,
        hasAppointableItems,
        payments,
        outstandingAmount: outstanding,
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

  onViewTreatmentCards() {
    wx.navigateTo({ url: '/pagesOrder/treatment-cards/treatment-cards' });
  },

  onShareAppMessage() {
    // 分享礼：被分享人进入首页而非分享者的订单页
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御订单', path: `/pages/home/home${invSuffix}` };
  },

  // ========== 继续支付（多次回款，Ticket 2026-04-24 PR-C） ==========

  async onContinuePayTap() {
    if (!this.data.order) return;
    const outstanding = this.data.outstandingAmount;
    if (!(outstanding > 0)) {
      Toast.fail('订单无欠款');
      return;
    }
    // 加载储值卡余额
    let balance = 0;
    try {
      const b = await callClientApi<{ balance: number }>('card.balance', {});
      balance = Number(b?.balance || 0);
    } catch {
      balance = 0;
    }
    this.setData({
      repayModalVisible: true,
      repayAmountInput: outstanding.toFixed(2),
      repayMethod: '微信',
      repayUseCard: false,
      cardBalance: balance,
    });
  },

  onRepayModalClose() {
    this.setData({ repayModalVisible: false });
  },

  onRepayMethodChange(e: any) {
    // 两种来源：
    //   1) van-radio-group bind:change → e.detail = name 字符串
    //   2) van-cell bindtap（data-name） → e.currentTarget.dataset.name
    const fromDetail = typeof e?.detail === 'string' ? e.detail : (e?.detail?.value || '');
    const fromDataset = e?.currentTarget?.dataset?.name || '';
    const v = (fromDetail || fromDataset) as '微信' | '支付宝' | '储值卡';
    if (v === '微信' || v === '支付宝' || v === '储值卡') {
      // 储值卡余额不足则禁用
      if (v === '储值卡' && this.data.cardBalance <= 0) return;
      this.setData({
        repayMethod: v,
        // 切到储值卡时，输入额度=min(欠款, 余额)；其他方式=欠款额
        repayAmountInput:
          v === '储值卡'
            ? Math.min(this.data.outstandingAmount, this.data.cardBalance).toFixed(2)
            : this.data.outstandingAmount.toFixed(2),
      });
    }
  },

  onRepayAmountInput(e: any) {
    // van-field bind:change → e.detail 直接是字符串值
    const detail = e?.detail;
    const v = (typeof detail === 'string' ? detail : detail?.value) as string;
    this.setData({ repayAmountInput: v || '' });
  },

  async onRepayConfirm() {
    if (this.data.repaySubmitting) return;
    const order = this.data.order;
    if (!order) return;

    const amt = Number(this.data.repayAmountInput);
    const outstanding = this.data.outstandingAmount;
    if (!(amt > 0)) {
      Toast.fail('请输入有效金额');
      return;
    }
    if (amt > outstanding + 0.001) {
      Toast.fail('金额超过欠款');
      return;
    }
    const method = this.data.repayMethod;
    if (method === '储值卡' && amt > this.data.cardBalance + 0.001) {
      Toast.fail('储值卡余额不足');
      return;
    }

    this.setData({ repaySubmitting: true });
    try {
      const payload = method === '储值卡'
        ? { saleOrderId: order.sale_order_id, paymentMethod: '储值卡', repayAmount: 0, prepaidCardAmount: amt }
        : { saleOrderId: order.sale_order_id, paymentMethod: method, repayAmount: amt, prepaidCardAmount: 0 };
      const data = await callClientApi<{
        repaymentOrderId: string;
        status: string;
        paymentParams?: any;
        qrCodeUrl?: string;
      }>('order.repay', payload);

      // 三路径分发
      if (method === '储值卡') {
        this.setData({ repayModalVisible: false });
        Toast.success('回款成功');
        this.loadDetail(order.sale_order_id);
        return;
      }
      if (method === '微信') {
        const params = data?.paymentParams || {};
        try {
          await wx.requestPayment(params);
          this.setData({ repayModalVisible: false });
          Toast.success('支付已发起');
          // 留少量时间等 payNotify 回调，再刷新
          setTimeout(() => this.loadDetail(order.sale_order_id), 1200);
        } catch (err: any) {
          if (!(err?.errMsg || '').toLowerCase().includes('cancel')) {
            Toast.fail(err?.errMsg || '支付失败');
          }
          // 取消不退出弹层，用户可换支付方式
        }
        return;
      }
      // 支付宝：mock 方式展示二维码（最简实现，保持与 checkout 相同交互：toast 提示用户扫码后人工刷新）
      this.setData({ repayModalVisible: false });
      wx.showModal({
        title: '请使用支付宝扫码',
        content: data?.qrCodeUrl || '(mock qr)',
        confirmText: '我已完成',
        showCancel: true,
        success: (res) => {
          if (res.confirm) {
            this.loadDetail(order.sale_order_id);
          }
        },
      });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('INSUFFICIENT_BALANCE')) {
        Toast.fail('储值卡余额不足');
      } else if (msg.includes('INVALID_PARAMS')) {
        Toast.fail(msg.replace(/^INVALID_PARAMS:\s*/, ''));
      } else {
        Toast.fail(msg || '回款失败');
      }
    } finally {
      this.setData({ repaySubmitting: false });
    }
  },
});
