
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
    
    continuePayEnabled: false,
    
    repayModalVisible: false,
    repayAmountInput: '' as string,
    repayMethod: '微信' as '微信' | '支付宝' | '储值卡' | '线下',
    repayUseCard: false,
    cardBalance: 0,
    repaySubmitting: false,
    
    confirmingPayment: false,
  },

  _countdownTimer: null as ReturnType<typeof setInterval> | null,
  
  _autoRepay: false,
  
  _poller: null as PaymentPoller | null,
  
  _needConfirm: false,

  onLoad(options) {
    
    const app = getApp<IAppOption>();
    const enabled = !!(app.globalData as any).continuePayEnabled;
    this.setData({ continuePayEnabled: enabled });

    const { saleOrderId, orderNo, repay, paid } = options as { saleOrderId?: string; orderNo?: string; repay?: string; paid?: string };
    this._autoRepay = repay === '1';
    this._needConfirm = paid === '1';
    
    
    const rawId = saleOrderId || orderNo;
    const id = rawId ? rawId.replace(/_\d+$/, '') : rawId;
    if (id) this.loadDetail(id);
  },

  onShow() {
    
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

      
      
      const hasAppointableItems = order.status === '已支付'
        && items.some(i => {
            if (i.product_type === '家居产品') return false;
            const total = Number(i.session_count ?? 0);
            const remaining = Number(i.remaining_sessions ?? 0);
            const paid = Number(i.paid_sessions ?? 0);
            const used = Math.max(0, total - remaining);
            return paid > 0 && (paid - used) > 0;
          });

      
      const itemsWithProgress: OrderDetailItem[] = items.map(i => {
        const total = Number(i.session_count ?? 0);
        const remaining = Number(i.remaining_sessions ?? 0);
        const paidNull = i.paid_sessions == null;
        const paid = Number(i.paid_sessions ?? 0);
        const used = Math.max(0, total - remaining);
        const { usedPct, paidUnusedPct, unpaidPct } = calculateTriProgress(total, remaining, paid);
        return {
          ...i,
          
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

      
      let expireTimeFmt = '';
      if (order.status === '待支付' && order.expire_at) {
        const rawExp = String(order.expire_at);
        const ed = new Date(rawExp.includes('T') ? rawExp : rawExp.replace(/-/g, '/'));
        expireTimeFmt = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
      }

      
      
      
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

      
      this.startCountdown(order);

      
      if (this._autoRepay) {
        this._autoRepay = false;
        if (order.status === '部分支付' && this.data.continuePayEnabled && outstanding > 0) {
          this.onContinuePayTap();
        }
      }
      
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

  
  async confirmAndRefresh(saleOrderId: string) {
    if (this._poller) return; 
    
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
      
      const finalStatus = this.data.order?.status;
      if (finalStatus !== '已支付' && finalStatus !== '部分支付') {
        
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
    
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御订单', path: `/pages/home/home${invSuffix}` };
  },

  

  async onContinuePayTap() {
    if (!this.data.order) return;
    const outstanding = this.data.outstandingAmount;
    if (!(outstanding > 0)) {
      Toast.fail('订单无欠款');
      return;
    }
    
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
    
    
    
    const fromDetail = typeof e?.detail === 'string' ? e.detail : (e?.detail?.value || '');
    const fromDataset = e?.currentTarget?.dataset?.name || '';
    const v = (fromDetail || fromDataset) as '微信' | '支付宝' | '储值卡' | '线下';
    if (v === '微信' || v === '支付宝' || v === '储值卡' || v === '线下') {
      
      if (v === '储值卡' && this.data.cardBalance + 0.001 < this.data.outstandingAmount) {
        Toast.fail('储值卡余额不足以付清全部欠款');
        return;
      }
      this.setData({
        repayMethod: v,
        
        repayAmountInput: this.data.outstandingAmount.toFixed(2),
      });
    }
  },

  onRepayAmountInput() {
    
    this.setData({ repayAmountInput: this.data.outstandingAmount.toFixed(2) });
  },

  async onRepayConfirm() {
    if (this.data.repaySubmitting) return;
    const order = this.data.order;
    if (!order) return;

    
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

      
      if (method === '储值卡') {
        this.setData({ repayModalVisible: false });
        Toast.success('回款成功');
        this.loadDetail(order.sale_order_id);
        return;
      }
      if (method === '线下') {
        
        this.setData({ repayModalVisible: false });
        Toast.success('已提交，等待店长确认收款');
        this.loadDetail(order.sale_order_id);
        return;
      }
      if (method === '微信') {
        
        const params = data?.paymentParams;
        if (!params || !params.paySign) {
          Toast.fail('支付参数获取失败');
          return;
        }
        try {
          await wx.requestPayment(params);
          this.setData({ repayModalVisible: false });
          
          await this.confirmAndRefresh(order.sale_order_id);
        } catch (err: any) {
          if (!(err?.errMsg || '').toLowerCase().includes('cancel')) {
            Toast.fail(err?.errMsg || '支付失败');
          }
          
        }
        return;
      }
      
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
