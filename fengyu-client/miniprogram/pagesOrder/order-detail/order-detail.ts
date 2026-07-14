// pages/order-detail/order-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { pollPaymentConfirm, PaymentPoller } from '../utils/payment-poll';
import { formatDateTimeShort, formatDate, calculateTriProgress } from '../../utils/format';

interface OrderDetailItem {
  sale_item_id: string;
  product_name: string;
  product_type: string;
  session_count: number;
  remaining_sessions: number | null;
  paid_sessions: number | null;
  unit_price: number;
  quantity: number;
  received: number;
  sale_amount: number;
  expire_date: string | null;
  // 视图字段（前端计算注入）
  used_sessions?: number;
  used_pct?: number;
  paid_unused_pct?: number;
  unpaid_pct?: number;
  // NULL 卡（paid_sessions 原始为 null）：wxml 据此把「已付 0」改显「已付 —」
  paid_sessions_null?: boolean;
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
  '部分支付':   { icon: 'clock-o',   color: '#D48806' },
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
    repayMethod: '微信' as '微信' | '支付宝' | '储值卡' | '线下',
    repayUseCard: false,
    cardBalance: 0,
    repaySubmitting: false,
    // 支付结果确认中（issue #37）：轮询期间隐藏待支付倒计时防频闪
    confirmingPayment: false,
  },

  _countdownTimer: null as ReturnType<typeof setInterval> | null,
  // 从列表「继续支付」跳入（?repay=1）：详情加载完成后自动唤起回款弹层，触发一次后清除
  _autoRepay: false,
  // 支付结果轮询器（issue #37）；onUnload/onHide 清理防泄漏
  _poller: null as PaymentPoller | null,
  // 从 scan-pay 支付完成跳入（?paid=1）：详情加载后若仍待支付，触发一次兜底轮询
  _needConfirm: false,

  onLoad(options) {
    // 读全局灰度开关（未配置默认 false）
    const app = getApp<IAppOption>();
    const enabled = !!(app.globalData as any).continuePayEnabled;
    this.setData({ continuePayEnabled: enabled });

    const { saleOrderId, orderNo, repay, paid } = options as { saleOrderId?: string; orderNo?: string; repay?: string; paid?: string };
    this._autoRepay = repay === '1';
    this._needConfirm = paid === '1';
    // 微信「订单中心」跳转会把 ${商品订单号} 替换成支付 out_trade_no = `${saleOrderId}_${时间戳}`，
    // 带后缀；订单号本身（FY-XSD-WX-...）无下划线，故剥 `_\d+$` 还原真实 saleOrderId（与 payNotify 同源）。
    const rawId = saleOrderId || orderNo;
    const id = rawId ? rawId.replace(/_\d+$/, '') : rawId;
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

      // 是否有可预约项目（已支付 + 至少一项"已付未用" > 0 + 非家居产品）
      // ticket 2026-05-19 paid_sessions：可消费门槛升级为"还有已付未用的次数"
      const hasAppointableItems = order.status === '已支付'
        && items.some(i => {
            if (i.product_type === '家居产品') return false;
            const total = Number(i.session_count ?? 0);
            const remaining = Number(i.remaining_sessions ?? 0);
            const paid = Number(i.paid_sessions ?? 0);
            const used = Math.max(0, total - remaining);
            return paid > 0 && (paid - used) > 0;
          });

      // 注入三段进度展示字段（已用 / 已付未用 / 未付）
      const itemsWithProgress: OrderDetailItem[] = items.map(i => {
        const total = Number(i.session_count ?? 0);
        const remaining = Number(i.remaining_sessions ?? 0);
        const paidNull = i.paid_sessions == null;
        const paid = Number(i.paid_sessions ?? 0);
        const used = Math.max(0, total - remaining);
        const { usedPct, paidUnusedPct, unpaidPct } = calculateTriProgress(total, remaining, paid);
        return {
          ...i,
          // expire_date 为原始 pg date（序列化成 UTC 串会偏移日期），格式化为 YYYY-MM-DD
          expire_date: i.expire_date ? formatDate(i.expire_date) : i.expire_date,
          paid_sessions: paid,
          // NULL 卡（0040 前未回填）：wxml 据此把「已付 0」改显「已付 —」
          paid_sessions_null: paidNull,
          used_sessions: used,
          used_pct: usedPct,
          paid_unused_pct: paidUnusedPct,
          unpaid_pct: unpaidPct,
        };
      });

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
          time_fmt: timeSrc ? formatDateTimeShort(timeSrc) : '',
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
          items: itemsWithProgress,
          order_time_fmt: formatDateTimeShort(order.sale_order_datetime),
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

      // 从列表「继续支付」跳入：自动唤起回款弹层（仅触发一次）
      if (this._autoRepay) {
        this._autoRepay = false;
        if (order.status === '部分支付' && this.data.continuePayEnabled && outstanding > 0) {
          this.onContinuePayTap();
        }
      }
      // 从 scan-pay 支付完成跳入（?paid=1）：回调延迟/丢失仍待支付时，兜底轮询确认（issue #37）
      if (this._needConfirm) {
        this._needConfirm = false;
        if (order.status === '待支付' || order.status === '部分支付') {
          this.confirmAndRefresh(order.sale_order_id);
        }
      }
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

  /**
   * 支付结果轮询确认 + 刷新（issue #37）。
   * 用于本页发起的回款支付成功后，或从 scan-pay 带 paid=1 跳入时的兜底确认。
   * 轮询期间置 confirmingPayment=true 隐藏待支付倒计时（防频闪）；完成或超时后 loadDetail 刷新。
   */
  async confirmAndRefresh(saleOrderId: string) {
    if (this._poller) return; // 防重入
    // 停止待支付倒计时，避免轮询期间每秒 setData 造成频闪
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    this.setData({ confirmingPayment: true, countdown: '' });
    const poller = pollPaymentConfirm(saleOrderId);
    this._poller = poller;
    try {
      await poller.promise;
      await this.loadDetail(saleOrderId);
      // 以刷新后的本地 status 为准（轮询结果可能因网络抖动过时），判断是否需要提示
      const finalStatus = this.data.order?.status;
      if (finalStatus !== '已支付' && finalStatus !== '部分支付') {
        // 超时仍未确认到账：提示用户稍后下拉刷新（订单已扣款，回调可能仍在补偿）
        Toast.fail('支付确认中，请稍后下拉刷新');
      }
    } finally {
      if (this._poller === poller) this._poller = null;
      this.setData({ confirmingPayment: false });
    }
  },

  onUnload() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer!);
      this._countdownTimer = null;
    }
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
    }
  },

  onHide() {
    // 页面隐藏（navigateTo 跳走 / tab 切换）停止轮询，避免后台继续请求
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
      this.setData({ confirmingPayment: false });
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
    const v = (fromDetail || fromDataset) as '微信' | '支付宝' | '储值卡' | '线下';
    if (v === '微信' || v === '支付宝' || v === '储值卡' || v === '线下') {
      // 顾客端继续支付强制全额：储值卡通道需余额 ≥ 全部欠款才可选
      if (v === '储值卡' && this.data.cardBalance + 0.001 < this.data.outstandingAmount) {
        Toast.fail('储值卡余额不足以付清全部欠款');
        return;
      }
      this.setData({
        repayMethod: v,
        // 强制全额：金额恒为欠款额，不可改小
        repayAmountInput: this.data.outstandingAmount.toFixed(2),
      });
    }
  },

  onRepayAmountInput() {
    // 顾客端继续支付强制全额：金额锁定为欠款额，忽略任何编辑
    this.setData({ repayAmountInput: this.data.outstandingAmount.toFixed(2) });
  },

  async onRepayConfirm() {
    if (this.data.repaySubmitting) return;
    const order = this.data.order;
    if (!order) return;

    // 顾客端继续支付强制全额：始终按全部欠款提交，不接受部分金额
    const outstanding = this.data.outstandingAmount;
    const amt = outstanding;
    if (!(amt > 0)) {
      Toast.fail('订单无欠款');
      return;
    }
    const method = this.data.repayMethod;
    if (method === '储值卡' && amt > this.data.cardBalance + 0.001) {
      Toast.fail('储值卡余额不足以付清全部欠款');
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
        alipayShareToken?: string;
      }>('order.repay', payload);

      // 四路径分发
      if (method === '储值卡') {
        this.setData({ repayModalVisible: false });
        Toast.success('回款成功');
        this.loadDetail(order.sale_order_id);
        return;
      }
      if (method === '线下') {
        // 线下仅标记意向，由店长确认收款落账；订单状态不变
        this.setData({ repayModalVisible: false });
        Toast.success('已提交，等待店长确认收款');
        this.loadDetail(order.sale_order_id);
        return;
      }
      if (method === '微信') {
        // 聚合主扫微信通道：直接拿 wx.requestPayment 5 字段
        const params = data?.paymentParams;
        if (!params || !params.paySign) {
          Toast.fail('支付参数获取失败');
          return;
        }
        try {
          await wx.requestPayment(params);
          this.setData({ repayModalVisible: false });
          // 轮询确认支付到账再刷新（issue #37）；confirmingPayment 态显示"支付结果确认中"
          await this.confirmAndRefresh(order.sale_order_id);
        } catch (err: any) {
          if (!(err?.errMsg || '').toLowerCase().includes('cancel')) {
            Toast.fail(err?.errMsg || '支付失败');
          }
          // 取消不退出弹层，用户可换支付方式
        }
        return;
      }
      // 支付宝：聚合主扫 share_code 返回吱口令；用 showModal 展示并提示复制
      const shareToken = data?.alipayShareToken;
      if (!shareToken) {
        Toast.fail('支付宝吱口令获取失败');
        return;
      }
      this.setData({ repayModalVisible: false });
      wx.setClipboardData({
        data: shareToken,
        success: () => {
          wx.showModal({
            title: '吱口令已复制',
            content: `${shareToken}\n\n打开支付宝 App → 自动识别后完成支付`,
            confirmText: '我已支付',
            showCancel: true,
            success: (res) => {
              if (res.confirm) {
                this.confirmAndRefresh(order.sale_order_id);
              }
            },
          });
        },
        fail: () => Toast.fail('复制失败'),
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
