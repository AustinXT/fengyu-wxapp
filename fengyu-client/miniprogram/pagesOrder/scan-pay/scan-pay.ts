// pages/scan-pay/scan-pay.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
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
  // 2026-04-26 sale-order-domain-refactor:
  //   - paidAmount 字段（来自旧 paid_amount 列）已删除
  //   - 后端 scanDetail 现返回 received / refundedAmount / payableAmount
  payableAmount: number;
  received: number;
  refundedAmount: number;
  // admin 在线上分次开单写入；为 NULL 表示按剩余应付全额收
  firstPaymentAmount: number | null;
  paymentMethod: PayMethod;
  couponDiscount: number;
}

interface ScanOrderItem {
  saleItemId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  // 行应付总额（权威，会员价/多次卡已折算）；列表金额展示此字段，不用 unitPrice
  saleAmount: number;
  // 多次卡疗程数（>1 时用于"×N次"辅助提示）
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
    // 储值卡抵扣
    cardBalance: 0,
    useCard: false,
    prepaidCardAmount: 0,
    paidAmount: 0,
    couponDiscount: 0,
    totalAmount: 0,
    // 剩余应付（payable − 净到账）；回款场景作为储值卡抵扣基数
    remaining: 0,
    // 首付金额（admin 线上分次开单）；为 0 表示无约束（按剩余应付走）
    firstPaymentAmount: 0,
    // 当前扫码是否是首次扫（received === 0 && firstPaymentAmount > 0）
    isFirstPartialScan: false,
    // 回款（部分支付订单）：储值卡由店员先扣，顾客只付现金尾款 → 隐藏抵扣区+线下，方式限微信/支付宝
    isRepayment: false,
    showPayMethodGroup: true,
    // 2026-05-19 dirty-read 修复：余额版本号（来自 scanAdjust.balanceSnapshot.updatedAt）
    // confirmPrepaidFull 时回传，后端 FOR UPDATE 锁后比对，不一致 → CONFLICT
    balanceUpdatedAt: null as string | null,
    // 支付宝二维码弹窗（保留以兼容 wxml，但 §4.6 推荐路径仅微信/线下/全额抵扣）
    // 支付宝吱口令弹窗（聚合主扫 share_code 方案）
    showAlipayShare: false,
    alipayShareToken: '',
    alipayAmount: '0.00',
  },

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
      // 并行：订单详情 + 储值卡余额
      const [data, balanceData] = await Promise.all([
        callClientApi<{ order?: any; items?: any[]; statusMsg?: string }>('order.scanDetail', { saleOrderId }),
        callClientApi<{ balance: number; cardId: string | null }>('card.balance', {}).catch(() => ({ balance: 0, cardId: null })),
      ]);

      // 非待支付订单：显示状态提示
      if (data.statusMsg) {
        this.setData({ statusMsg: data.statusMsg });
        return;
      }

      const orderData = data.order || {};
      const totalAmount = Number(orderData.totalAmount || 0);
      const prepaid = Number(orderData.prepaidCardAmount || 0);
      // 2026-04-26 sale-order-domain-refactor:
      //   - paid_amount → received（已到账）；本次应付实金 = payable - 净到账
      //   - 兜底：payableAmount 缺失时按 total - prepaid 推算（与后端兜底逻辑一致）
      const received = Number(orderData.received || 0);
      const refundedAmount = Number(orderData.refundedAmount || 0);
      const payable = Number(orderData.payableAmount) > 0
        ? Number(orderData.payableAmount)
        : Math.round((totalAmount - prepaid) * 100) / 100;
      const netReceived = Math.round((received - refundedAmount) * 100) / 100;
      const remaining = Math.max(0, Math.round((payable - netReceived) * 100) / 100);
      const firstPaymentAmount = Number(orderData.firstPaymentAmount || 0);
      // 首次扫码（received === 0）且 admin 设置了 firstPaymentAmount：本次只收首付
      const isFirstPartialScan = firstPaymentAmount > 0 && received === 0;
      const paid = isFirstPartialScan
        ? Math.min(firstPaymentAmount, remaining)
        : remaining;
      const couponDiscount = Number(orderData.couponDiscount || 0);
      const validMethods: PayMethod[] = ['微信', '支付宝', '线下'];
      const restoredMethod = validMethods.includes(orderData.paymentMethod)
        ? (orderData.paymentMethod as PayMethod)
        : '微信';
      // 回款场景：部分支付订单（已有首付到账，扫码付剩余应付）。储值卡由店员先扣，顾客侧不再自选储值卡；方式限微信/支付宝
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

  /** 重算 prepaid/paid 并写回 setData，返回新值 */
  applyRecompute(useCard: boolean): { prepaidCardAmount: number; paidAmount: number } {
    const r = recomputeAmounts({
      totalAmount: this.data.totalAmount,
      couponDiscount: this.data.couponDiscount,
      cardBalance: this.data.cardBalance,
      useCard,
      // 回款场景储值卡只抵扣尾款（remaining），而非全额
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

  /** 同步当前抵扣方案到后端（不阻塞 UI）
   *  2026-05-19 dirty-read 修复：从 scanAdjust 响应中提取 balanceSnapshot.updatedAt 写入 data，供 confirmPrepaidFull 校验
   */
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

  /** 储值卡开关 */
  async onUseCardChange(e: WxEvent<boolean>) {
    const useCard = !!e.detail;
    if (useCard && this.data.cardBalance <= 0) {
      // 余额为 0：拦截开启
      return;
    }
    const { paidAmount } = this.applyRecompute(useCard);
    // 回款场景不走 scanAdjust（仅支持待支付）；储值卡抵扣随 order.repay 一次性提交
    if (this.data.isRepayment) return;
    await this.pushAdjust(useCard, paidAmount, this.data.paymentMethod).catch(() => {});
  },

  /** 支付方式选择 */
  async onPayMethodChange(e: WxEvent<string>) {
    const method = e.detail as PayMethod;
    this.setData({ paymentMethod: method });
    // 回款不预同步抵扣方案（不动部分支付订单的储值卡快照）；方式由 pay/alipayPay 自行落库
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

  /** 确认支付 */
  async onSubmit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      await this.executeConfirm();
    } catch (err: any) {
      const errorType = err?.errorType || '';
      const msg = err?.message || err?.errMsg || '';
      const lower = msg.toLowerCase();
      // 用户主动取消微信支付：订单仍 '待支付'，静默返回不报错
      if (lower.includes('requestpayment:fail') && lower.includes('cancel')) {
        return;
      }
      // 微信封禁/限制小程序支付能力（banned / 违反平台规则 / no permission / access denied）：
      // 引导改用「到店付款」，或让顾客在其本人小程序内用支付宝支付。
      if (['banned', 'platform rules', 'violated', '违规', '违反', 'no permission', 'access denied']
        .some((kw) => lower.includes(kw))) {
        wx.showModal({
          title: '微信支付暂不可用',
          content: '当前微信支付能力受限，请改用「到店付款」，或让顾客在其本人小程序内用支付宝支付。',
          showCancel: false,
        });
        return;
      }
      // 2026-05-19 dirty-read 修复：CONFLICT 优先于 INSUFFICIENT_BALANCE
      // CONFLICT 表示余额在 scanAdjust → confirmPrepaidFull 期间被改动，需要用户重选抵扣方案
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

  /** 根据当前 paid/method 路由到对应支付端点 */
  async executeConfirm(): Promise<void> {
    const { orderNo, paidAmount, paymentMethod, balanceUpdatedAt, firstPaymentAmount, isFirstPartialScan } = this.data;

    // 回款（部分支付）走 order.repay：支持储值卡抵扣尾款 + 微信/支付宝付差额（线下在回款隐藏）
    if (this.data.isRepayment) {
      await this.executeRepayConfirm();
      return;
    }

    const route = decideConfirmRoute(paidAmount, paymentMethod);

    if (route === 'confirmPrepaidFull') {
      // 2026-05-19 dirty-read 修复：回传版本号，让后端校验余额未变动
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
      // 聚合主扫支付宝：后端串调 preorder(41) + share_code 返回吱口令；订单状态由 payNotify 异步推进
      const aliData = await callClientApi<{ status?: string; reason?: string; alipayShareToken?: string; paidAmount?: number }>(
        'order.alipayPay', { saleOrderId: orderNo },
      );
      // 防御性短路：后端识别为全额储值卡抵扣 → 直接跳详情页
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

    // wechatPay：聚合主扫直接拿 wx.requestPayment 5 字段
    // 首付场景下显式传 payAmount，后端按约束扣款 + 清空 first_payment_amount；后续扫码默认按剩余应付走
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
    Toast.success('支付成功');
    setTimeout(() => {
      wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
    }, 1200);
  },

  /** 回款（部分支付订单）确认：统一走 order.repay
   *  - paid=0（储值卡覆盖全部尾款）→ 纯卡回款（同事务扣卡 + 推进状态）
   *  - paid>0 + 微信/支付宝 → 线上回款，可叠加 prepaidCardAmount 抵扣部分尾款
   *    （混合：order.repay 仅写「待支付储值卡抵扣」意向、不当场扣卡；扣卡与线上到账由 payNotify 同事务执行，
   *     线上支付取消/失败 → 储值卡分文不动、订单不推进，无需前端回滚）
   *  线下在回款场景隐藏（产品决策），故此处不含线下分支。
   */
  async executeRepayConfirm(): Promise<void> {
    const { orderNo, paidAmount, prepaidCardAmount, paymentMethod } = this.data;

    // 全额储值卡抵扣：无需线上付款
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

    // 支付宝：聚合主扫吱口令（可叠加储值卡抵扣）
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

    // 微信：聚合主扫 wx.requestPayment（可叠加储值卡抵扣）
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
    Toast.success('支付成功');
    setTimeout(() => {
      wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
    }, 1200);
  },

  /** 2026-05-19 dirty-read 修复：余额版本冲突
   *  scanAdjust 时读到的 balance 与 confirmPrepaidFull 时锁到的 balance 版本不一致
   *  → 重新拉余额 + 提示用户重新选择抵扣金额（不自动重试，让用户主动决定）
   */
  async handleBalanceConflict(_errMsg?: string): Promise<void> {
    try {
      const balanceData = await callClientApi<{ balance: number; cardId: string | null }>('card.balance', {});
      const newBalance = Number(balanceData?.balance || 0);
      this.setData({
        cardBalance: newBalance,
        // 旧版本号已失效，重置；用户重新调 pushAdjust 时会再写入
        balanceUpdatedAt: null,
      });
    } catch (_e) {
      // 拉余额失败时 UI 保留旧值，不阻塞提示
    }
    Toast.fail('储值卡余额已变动，请重新选择抵扣金额');
  },

  /** 余额不足：弹框 → 关抵扣重付 / 取消订单 */
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
      // 关闭抵扣 → scanAdjust(useCard=false) → 重新执行 confirm
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

  // 支付宝吱口令弹窗回调（聚合主扫 share_code 方案）
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
    wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${this.data.orderNo}` });
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
