
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { pollPaymentConfirm, PaymentPoller } from '../utils/payment-poll';
import {
  recomputeAmounts,
  decideConfirmRoute,
  PayMethod,
} from './scan-pay.logic';

interface ScanOrder {
  orderNo: string;
  status: string;
  storeId: string;
  storeName: string;
  openerName: string;
  orderType: string;
  totalAmount: number;
  prepaidCardAmount: number;
  
  
  
  payableAmount: number;
  received: number;
  refundedAmount: number;
  
  firstPaymentAmount: number | null;
  paymentMethod: PayMethod;
  couponDiscount: number;
}

interface ScanOrderItem {
  saleItemId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  
  saleAmount: number;
  
  sessionCount: number | null;
  received: number;
  coverImage: string;
}

Page({
  data: {
    order: null as ScanOrder | null,
    items: [] as ScanOrderItem[],
    orderNo: '',
    paymentMethod: '微信' as PayMethod,
    isLoading: true,
    errorMsg: '',
    statusMsg: '',
    submitting: false,
    
    cardBalance: 0,
    useCard: false,
    prepaidCardAmount: 0,
    paidAmount: 0,
    couponDiscount: 0,
    totalAmount: 0,
    
    remaining: 0,
    
    firstPaymentAmount: 0,
    
    isFirstPartialScan: false,
    
    isRepayment: false,
    showPayMethodGroup: true,
    
    
    balanceUpdatedAt: null as string | null,
    
    
    showAlipayShare: false,
    alipayShareToken: '',
    alipayAmount: '0.00',
  },

  
  _poller: null as PaymentPoller | null,

  onLoad(options) {
    const { scene, orderNo, saleOrderId } = options as { scene?: string; orderNo?: string; saleOrderId?: string };
    let targetOrderNo = saleOrderId || orderNo;
    if (scene) {
      targetOrderNo = decodeURIComponent(scene);
    }
    if (!targetOrderNo) {
      this.setData({ isLoading: false, errorMsg: '无效的二维码' });
      return;
    }
    this.setData({ orderNo: targetOrderNo });
    this.loadOrder(targetOrderNo);
  },

  async loadOrder(saleOrderId: string) {
    this.setData({ isLoading: true, errorMsg: '', statusMsg: '' });
    try {
      
      const [data, balanceData] = await Promise.all([
        callClientApi<{ order?: any; items?: any[]; statusMsg?: string }>('order.scanDetail', { saleOrderId }),
        callClientApi<{ balance: number; cardId: string | null }>('card.balance', {}).catch(() => ({ balance: 0, cardId: null })),
      ]);

      
      if (data.statusMsg) {
        this.setData({ statusMsg: data.statusMsg });
        return;
      }

      const orderData = data.order || {};
      const totalAmount = Number(orderData.totalAmount || 0);
      const prepaid = Number(orderData.prepaidCardAmount || 0);
      
      
      
      const received = Number(orderData.received || 0);
      const refundedAmount = Number(orderData.refundedAmount || 0);
      const payable = Number(orderData.payableAmount) > 0
        ? Number(orderData.payableAmount)
        : Math.round((totalAmount - prepaid) * 100) / 100;
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      const remaining = Math.max(0, Math.round((payable - netReceived) * 100) / 100);
      const firstPaymentAmount = Number(orderData.firstPaymentAmount || 0);
      
      const isFirstPartialScan = firstPaymentAmount > 0 && received === 0;
      const paid = isFirstPartialScan
        ? Math.min(firstPaymentAmount, remaining)
        : remaining;
      const couponDiscount = Number(orderData.couponDiscount || 0);
      const validMethods: PayMethod[] = ['微信', '支付宝', '线下'];
      const restoredMethod = validMethods.includes(orderData.paymentMethod)
        ? (orderData.paymentMethod as PayMethod)
        : '微信';
      
      const isRepayment = orderData.status === '部分支付';
      const effectiveMethod: PayMethod = isRepayment && restoredMethod === '线下' ? '微信' : restoredMethod;

      this.setData({
        order: {
          ...orderData,
          totalAmount,
          prepaidCardAmount: prepaid,
          payableAmount: payable,
          received,
          refundedAmount,
          firstPaymentAmount: firstPaymentAmount > 0 ? firstPaymentAmount : null,
          paymentMethod: restoredMethod,
          couponDiscount,
        },
        items: data.items || [],
        cardBalance: Number(balanceData?.balance || 0),
        useCard: isRepayment ? false : prepaid > 0,
        prepaidCardAmount: isRepayment ? 0 : prepaid,
        paidAmount: paid,
        paymentMethod: effectiveMethod,
        couponDiscount,
        totalAmount,
        remaining,
        firstPaymentAmount,
        isFirstPartialScan,
        isRepayment,
        showPayMethodGroup: paid > 0,
      });
    } catch (err: any) {
      this.setData({ errorMsg: err.message || '加载订单信息失败，请稍后重试' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  
  applyRecompute(useCard: boolean): { prepaidCardAmount: number; paidAmount: number } {
    const r = recomputeAmounts({
      totalAmount: this.data.totalAmount,
      couponDiscount: this.data.couponDiscount,
      cardBalance: this.data.cardBalance,
      useCard,
      
      payableBase: this.data.isRepayment ? this.data.remaining : undefined,
    });
    this.setData({
      useCard,
      prepaidCardAmount: r.prepaidCardAmount,
      paidAmount: r.paidAmount,
      showPayMethodGroup: r.paidAmount > 0,
    });
    return r;
  },

  
  async pushAdjust(useCard: boolean, paidAmount: number, paymentMethod: PayMethod): Promise<void> {
    try {
      const res = await callClientApi<{ balanceSnapshot?: { updatedAt?: string } | null }>('order.scanAdjust', {
        saleOrderId: this.data.orderNo,
        useCard,
        paymentMethod: paidAmount > 0 ? paymentMethod : undefined,
      });
      const updatedAt = res && res.balanceSnapshot ? res.balanceSnapshot.updatedAt || null : null;
      this.setData({ balanceUpdatedAt: updatedAt });
    } catch (err: any) {
      Toast.fail(err?.message || '调整失败');
      throw err;
    }
  },

  
  async onUseCardChange(e: WxEvent<boolean>) {
    const useCard = !!e.detail;
    if (useCard && this.data.cardBalance <= 0) {
      
      return;
    }
    const { paidAmount } = this.applyRecompute(useCard);
    
    if (this.data.isRepayment) return;
    await this.pushAdjust(useCard, paidAmount, this.data.paymentMethod).catch(() => {});
  },

  
  async onPayMethodChange(e: WxEvent<string>) {
    const method = e.detail as PayMethod;
    this.setData({ paymentMethod: method });
    
    if (!this.data.isRepayment && this.data.paidAmount > 0) {
      await this.pushAdjust(this.data.useCard, this.data.paidAmount, method).catch(() => {});
    }
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: PayMethod };
    this.setData({ paymentMethod: method });
    if (!this.data.isRepayment && this.data.paidAmount > 0) {
      this.pushAdjust(this.data.useCard, this.data.paidAmount, method).catch(() => {});
    }
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  
  async confirmAndRedirect(orderNo: string) {
    Toast.loading({ message: '支付结果确认中', forbidClick: true, duration: 0 });
    const poller = pollPaymentConfirm(orderNo);
    this._poller = poller;
    try {
      const r = await poller.promise;
      Toast.clear();
      if (r.status === '已支付' || r.status === '部分支付') {
        Toast.success('支付成功');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
        }, 800);
      } else {
        
        Toast.fail('支付确认中，请稍后下拉刷新');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}&paid=1` });
        }, 1200);
      }
    } catch (_e) {
      Toast.clear();
      wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}&paid=1` });
    } finally {
      if (this._poller === poller) this._poller = null;
    }
  },

  onUnload() {
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
    }
  },

  onHide() {
    
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
    }
  },

  
  async onSubmit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      await this.executeConfirm();
    } catch (err: any) {
      const errorType = err?.errorType || '';
      const msg = err?.message || err?.errMsg || '';
      const lower = msg.toLowerCase();
      
      if (lower.includes('requestpayment:fail') && lower.includes('cancel')) {
        return;
      }
      
      
      if (['banned', 'platform rules', 'violated', '违规', '违反', 'no permission', 'access denied']
        .some((kw) => lower.includes(kw))) {
        wx.showModal({
          title: '微信支付暂不可用',
          content: '当前微信支付能力受限，请改用「到店付款」，或让顾客在其本人小程序内用支付宝支付。',
          showCancel: false,
        });
        return;
      }
      
      
      if (errorType === 'CONFLICT' || /CONFLICT/.test(msg)) {
        await this.handleBalanceConflict(msg);
      } else if (msg.includes('INSUFFICIENT_BALANCE')) {
        await this.handleInsufficientBalance();
      } else {
        Toast.fail(msg || '支付失败，请重试');
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  
  async executeConfirm(): Promise<void> {
    const { orderNo, paidAmount, paymentMethod, balanceUpdatedAt, firstPaymentAmount, isFirstPartialScan } = this.data;

    
    if (this.data.isRepayment) {
      await this.executeRepayConfirm();
      return;
    }

    const route = decideConfirmRoute(paidAmount, paymentMethod);

    if (route === 'confirmPrepaidFull') {
      
      await callClientApi('order.confirmPrepaidFull', {
        saleOrderId: orderNo,
        expectedBalanceUpdatedAt: balanceUpdatedAt || undefined,
      });
      Toast.success('支付成功');
      setTimeout(() => {
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
      }, 1200);
      return;
    }

    if (route === 'offlinePay') {
      await callClientApi('order.offlinePay', { saleOrderId: orderNo });
      Toast.success('已提交，等待店长确认收款');
      setTimeout(() => {
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
      }, 1500);
      return;
    }

    if (route === 'alipayPay') {
      
      const aliData = await callClientApi<{ status?: string; reason?: string; alipayShareToken?: string; paidAmount?: number }>(
        'order.alipayPay', { saleOrderId: orderNo },
      );
      
      if (aliData?.status === '已支付' || aliData?.reason === 'prepaid_card_full') {
        Toast.success('已使用储值卡支付');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
        }, 1200);
        return;
      }
      const shareToken = aliData?.alipayShareToken;
      if (!shareToken) {
        Toast.fail('支付宝吱口令获取失败');
        return;
      }
      this.setData({
        showAlipayShare: true,
        alipayShareToken: shareToken,
        alipayAmount: Number(aliData?.paidAmount || paidAmount).toFixed(2),
      });
      return;
    }

    
    
    const payPayload: { saleOrderId: string; payAmount?: number } = { saleOrderId: orderNo };
    if (isFirstPartialScan && firstPaymentAmount > 0) {
      payPayload.payAmount = firstPaymentAmount;
    }
    const data = await callClientApi<{ paymentParams?: any }>('order.pay', payPayload);
    const payParams = data.paymentParams;
    if (!payParams || !payParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    await wx.requestPayment(payParams);
    await this.confirmAndRedirect(orderNo);
  },

  
  async executeRepayConfirm(): Promise<void> {
    const { orderNo, paidAmount, prepaidCardAmount, paymentMethod } = this.data;

    
    if (paidAmount <= 0) {
      await callClientApi('order.repay', {
        saleOrderId: orderNo,
        paymentMethod: '储值卡',
        repayAmount: 0,
        prepaidCardAmount,
      });
      Toast.success('支付成功');
      setTimeout(() => {
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
      }, 1200);
      return;
    }

    
    if (paymentMethod === '支付宝') {
      const aliData = await callClientApi<{ alipayShareToken?: string }>('order.repay', {
        saleOrderId: orderNo,
        paymentMethod: '支付宝',
        repayAmount: paidAmount,
        prepaidCardAmount,
      });
      const shareToken = aliData?.alipayShareToken;
      if (!shareToken) {
        Toast.fail('支付宝吱口令获取失败');
        return;
      }
      this.setData({
        showAlipayShare: true,
        alipayShareToken: shareToken,
        alipayAmount: Number(paidAmount).toFixed(2),
      });
      return;
    }

    
    const data = await callClientApi<{ paymentParams?: any }>('order.repay', {
      saleOrderId: orderNo,
      paymentMethod: '微信',
      repayAmount: paidAmount,
      prepaidCardAmount,
    });
    const payParams = data.paymentParams;
    if (!payParams || !payParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    await wx.requestPayment(payParams);
    await this.confirmAndRedirect(orderNo);
  },

  
  async handleBalanceConflict(_errMsg?: string): Promise<void> {
    try {
      const balanceData = await callClientApi<{ balance: number; cardId: string | null }>('card.balance', {});
      const newBalance = Number(balanceData?.balance || 0);
      this.setData({
        cardBalance: newBalance,
        
        balanceUpdatedAt: null,
      });
    } catch (_e) {
      
    }
    Toast.fail('储值卡余额已变动，请重新选择抵扣金额');
  },

  
  async handleInsufficientBalance(): Promise<void> {
    const res = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>((resolve) => {
      wx.showModal({
        title: '储值卡余额不足',
        content: '您的储值卡余额已不足以完成本次抵扣。请选择：',
        confirmText: '关闭抵扣重付',
        cancelText: '取消订单',
        success: resolve,
        fail: () => resolve({ confirm: false, cancel: true } as any),
      });
    });

    if (res.confirm) {
      
      const { paidAmount } = this.applyRecompute(false);
      await this.pushAdjust(false, paidAmount, this.data.paymentMethod).catch(() => {});
      await this.executeConfirm();
    } else if (res.cancel) {
      try {
        await callClientApi('order.cancel', { saleOrderId: this.data.orderNo });
        Toast.success('订单已取消');
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 1200);
      } catch (err: any) {
        Toast.fail(err?.message || '取消失败');
      }
    }
  },

  
  onAlipayShareCopy() {
    const token: string = this.data.alipayShareToken;
    if (!token) return;
    wx.setClipboardData({
      data: token,
      success: () => Toast.success('吱口令已复制，请打开支付宝粘贴'),
      fail: () => Toast.fail('复制失败'),
    });
  },

  onAlipayShareDone() {
    this.setData({ showAlipayShare: false });
    this.confirmAndRedirect(this.data.orderNo);
  },

  onAlipayShareClose() {
    this.setData({ showAlipayShare: false });
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御收款', path: `/pages/home/home${invSuffix}` };
  },
});
