// pages/scan-pay/scan-pay.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { pollPaymentConfirm, PaymentPoller } from '../utils/payment-poll';
import {
  recomputeAmounts,
  decideConfirmRoute,
  restorePendingPrepaid,
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
  pendingPrepaidCardAmount: number;
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
  isExperienceConversion: boolean;
  // #214：是否存在本人可续付的支付场次（布尔，不含凭据）
  hasResumablePaymentIntent?: boolean;
  // 可续付场次的权威金额/方式/待扣卡额（不含凭据）；前端不再自行推算，避免口径分歧
  resumablePayAmount?: number | null;
  resumablePaymentMethod?: PayMethod | null;
  resumablePrepaidCardAmount?: number | null;
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
  unit: string;
  received: number;
  coverImage: string;
}

interface WechatPaymentAttempt {
  key: string;
  paymentParams: any;
}

interface AlipayPaymentAttempt {
  key: string;
  shareToken: string;
  amount: string;
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
    // 回款（部分支付订单）：普通回款可选卡；员工冻结金额的受限回款禁卡，方式限微信/支付宝。
    isRepayment: false,
    // #214：订单上是否已有本人可续付的支付场次（由 scanDetail 下发，不含任何凭据）。
    // 为 true 时普通回款也走 pay/alipayPay 以复用场次，否则会撞 PAYMENT_INTENT_ACTIVE。
    hasResumablePaymentIntent: false,
    // 有可续付场次时锁死抵扣与支付方式：那笔渠道单的金额/方式已定，服务端也有守卫，
    // 让顾客以为能改、改完付的还是老方案，就是展示与资金结果不一致的来源
    intentLocked: false,
    // 员工冻结 first_payment_amount 的受限回款：本场次不允许顾客再选储值卡。
    isRestrictedRepayment: false,
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

  // 支付结果轮询器（issue #37）；onUnload 清理防内存泄漏
  _poller: null as PaymentPoller | null,
  // 同一页面内复用已创建的第三方支付场次。微信支付面板被用户取消并不代表
  // 拉卡拉 preorder 失效，重复请求后端只会命中 PAYMENT_INTENT_ACTIVE。
  _wechatAttempt: null as WechatPaymentAttempt | null,
  _alipayAttempt: null as AlipayPaymentAttempt | null,

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
    this._wechatAttempt = null;
    this._alipayAttempt = null;
    this.setData({ isLoading: true, errorMsg: '', statusMsg: '' });
    try {
      // 并行读取；余额失败时不能把“不可信”当 0 后继续调起第三方渠道。
      const [data, balanceData] = await Promise.all([
        callClientApi<{ order?: any; items?: any[]; statusMsg?: string }>('order.scanDetail', { saleOrderId }),
        callClientApi<{ balance: number; cardId: string | null }>('card.balance', {}),
      ]);

      // 非待支付订单：显示状态提示
      if (data.statusMsg) {
        this.setData({ statusMsg: data.statusMsg });
        return;
      }

      const orderData = data.order || {};
      const totalAmount = Number(orderData.totalAmount || 0);
      const actualPrepaid = Number(orderData.prepaidCardAmount || 0);
      let pendingPrepaid = Number(orderData.pendingPrepaidCardAmount || 0);
      const cardBalance = Number(balanceData.balance || 0);
      let balanceUpdatedAt: string | null = null;

      // 历史 pending 只能按 min(pending, 当前余额) 恢复。余额下降时立即同步服务端，
      // 确保随后现金应付额和 payNotify 待扣卡额来自同一份新快照。
      const restoredPending = restorePendingPrepaid(pendingPrepaid, cardBalance);
      // #214（round-9）：有可续付场次时**不能**自动回写抵扣方案——意图活跃期改抵扣有服务端
      // 守卫，scanAdjust 会抛 PAYMENT_INTENT_ACTIVE，整页落进「无法获取订单」的错误态，
      // 连新加的取消入口都一起消失，顾客彻底没有出路。
      // 这种场景（预留卡额后余额又降了）保留原方案只读展示，提交时由服务端按真实余额判定。
      const skipAutoAdjust = orderData.hasResumablePaymentIntent === true
      if (!skipAutoAdjust
          && orderData.status === '待支付'
          && pendingPrepaid > 0
          && Math.round(restoredPending * 100) !== Math.round(pendingPrepaid * 100)) {
        const validMethods: PayMethod[] = ['微信', '支付宝', '线下'];
        const syncMethod: PayMethod = validMethods.includes(orderData.paymentMethod)
          ? orderData.paymentMethod as PayMethod
          : '微信';
        const adjusted = await callClientApi<{
          prepaidCardAmount: number;
          paidAmount: number;
          paymentMethod: PayMethod;
          balanceSnapshot?: { updatedAt?: string } | null;
        }>('order.scanAdjust', {
          saleOrderId,
          useCard: restoredPending > 0,
          prepaidCardAmount: restoredPending > 0 ? restoredPending : undefined,
          paymentMethod: syncMethod,
        });
        pendingPrepaid = Number(adjusted.prepaidCardAmount || 0);
        orderData.pendingPrepaidCardAmount = pendingPrepaid;
        orderData.payableAmount = Number(adjusted.paidAmount || 0);
        orderData.paymentMethod = adjusted.paymentMethod;
        balanceUpdatedAt = adjusted.balanceSnapshot?.updatedAt || null;
      }

      // 待支付阶段恢复预选抵扣；真正扣卡后才读实际储值卡实付。
      const prepaid = pendingPrepaid > 0 ? pendingPrepaid : actualPrepaid;
      // 2026-04-26 sale-order-domain-refactor:
      //   - paid_amount → received（已到账）；本次应付实金 = payable - 净到账
      //   - 兜底：payableAmount 缺失时按 total - 实际储值卡 - 待扣储值卡推算
      const received = Number(orderData.received || 0);
      const refundedAmount = Number(orderData.refundedAmount || 0);
      const payable = orderData.payableAmount != null && Number.isFinite(Number(orderData.payableAmount))
        ? Number(orderData.payableAmount)
        : Math.round((totalAmount - actualPrepaid - pendingPrepaid) * 100) / 100;
      // 回款（部分支付）用行级口径：已退行不计入，只有「未退且未付清」的行可继续支付；
      // 首次支付（待支付）无退款，沿用订单级 payable - 净到账（行级 Σ 未扣储值卡意向，首次场景不适用）
      const isRepayment = orderData.status === '部分支付';
      // #214：订单上是否已有本人可续付的支付场次（后端只下发布尔，不含凭据）
      const hasResumableIntent = orderData.hasResumablePaymentIntent === true;
      let remaining;
      if (isRepayment) {
        if (orderData.orderType === '转换单') {
          remaining = Math.max(0, Math.round((totalAmount - received + refundedAmount) * 100) / 100);
        } else {
          const scanItems: any[] = Array.isArray(data.items) ? data.items : [];
          if (scanItems.length === 0) {
            // 明细暂未返回时使用订单级净应付兜底，避免把仍有欠款的订单误算为 0。
            remaining = Math.max(0, Math.round((payable - received + refundedAmount) * 100) / 100);
          } else {
            let sum = 0;
            for (const i of scanItems) {
              if (Number(i.refundedAmount || 0) > 0) continue;
              sum += Math.max(0, Number(i.saleAmount || 0) - Number(i.received || 0));
            }
            remaining = Math.round(sum * 100) / 100;
          }
        }
      } else {
        const netReceived = Math.round((received - refundedAmount) * 100) / 100;
        remaining = Math.max(0, Math.round((payable - netReceived) * 100) / 100);
      }
      const firstPaymentAmount = Number(orderData.firstPaymentAmount || 0);
      // first_payment_amount 是服务端冻结的本次在线收款上限：既用于首次首付，
      // 也用于员工在部分支付转换单上发起的订单级部分回款。
      const isFirstPartialScan = firstPaymentAmount > 0 && received === 0;
      const isRestrictedRepayment = isRepayment && firstPaymentAmount > 0;
      // #214：有可续付场次时，金额/方式/待扣卡额一律以**后端下发的快照口径**为准。
      // 前端自己推算会和快照对不上（round-8/9 连着两轮栽在这里）：本地 remaining 是
      // 退款感知的行级口径，而快照存的是预下单当时定死的线上金额。
      const resumablePay = hasResumableIntent && Number.isFinite(Number(orderData.resumablePayAmount))
        ? Number(orderData.resumablePayAmount)
        : null;
      const resumableCard = hasResumableIntent && Number.isFinite(Number(orderData.resumablePrepaidCardAmount))
        ? Number(orderData.resumablePrepaidCardAmount)
        : null;
      const paid = resumablePay != null
        ? resumablePay
        : (firstPaymentAmount > 0 ? Math.min(firstPaymentAmount, remaining) : remaining);
      const couponDiscount = Number(orderData.couponDiscount || 0);
      const validMethods: PayMethod[] = ['微信', '支付宝', '线下'];
      const restoredMethod = validMethods.includes(orderData.paymentMethod)
        ? (orderData.paymentMethod as PayMethod)
        : '微信';
      // 回款场景：部分支付订单（已有首付到账，扫码付剩余应付）；受限回款由 isRestrictedRepayment 禁卡。
      // （isRepayment 已在上方 remaining 计算前定义）
      const baseMethod: PayMethod = isRepayment && restoredMethod === '线下' ? '微信' : restoredMethod;
      // 复用场次的支付方式必须与快照一致（复用判据之一），直接采用后端下发值
      const effectiveMethod: PayMethod = (hasResumableIntent
        && orderData.resumablePaymentMethod
        && validMethods.includes(orderData.resumablePaymentMethod))
        ? (orderData.resumablePaymentMethod as PayMethod)
        : baseMethod;

      this.setData({
        order: {
          ...orderData,
          totalAmount,
          prepaidCardAmount: actualPrepaid,
          pendingPrepaidCardAmount: pendingPrepaid,
          payableAmount: payable,
          received,
          refundedAmount,
          firstPaymentAmount: firstPaymentAmount > 0 ? firstPaymentAmount : null,
          paymentMethod: restoredMethod,
          couponDiscount,
        },
        items: data.items || [],
        cardBalance,
        // #214：有可续付场次时严格按**该场次的**待扣卡额展示。
        // 不能用 `prepaid`（它带 `pendingPrepaid > 0 ? pendingPrepaid : actualPrepaid` 的兜底）：
        // 订单早期若有已结算的卡扣，而复用的场次本身不带卡计划，会误显示「使用储值卡 ¥80」
        // ——开关还被锁死，顾客无法纠正（round-9 两个谱系都指到这里）。
        useCard: resumableCard != null
          ? resumableCard > 0
          : (isRepayment ? false : prepaid > 0),
        prepaidCardAmount: resumableCard != null
          ? resumableCard
          : (isRepayment ? 0 : prepaid),
        paidAmount: paid,
        paymentMethod: effectiveMethod,
        couponDiscount,
        totalAmount,
        remaining,
        firstPaymentAmount,
        isFirstPartialScan,
        isRepayment,
        isRestrictedRepayment,
        // #214：后端只下发布尔标识，不含任何支付凭据
        hasResumablePaymentIntent: hasResumableIntent,
        intentLocked: hasResumableIntent,
        showPayMethodGroup: paid > 0,
        balanceUpdatedAt,
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
  async pushAdjust(
    useCard: boolean,
    paidAmount: number,
    paymentMethod: PayMethod,
    prepaidCardAmount?: number,
  ): Promise<void> {
    try {
      const res = await callClientApi<{ balanceSnapshot?: { updatedAt?: string } | null }>('order.scanAdjust', {
        saleOrderId: this.data.orderNo,
        useCard,
        ...(useCard && prepaidCardAmount != null ? { prepaidCardAmount } : {}),
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
    // #214：与支付方式同理——wxml 上的 disabled 只是 UI 层，handler 自己也要挡。
    // 复用场次的抵扣方案已经定死在那笔渠道单里（服务端改抵扣也有守卫），
    // 这里若放行，顾客改完看到的金额和实际扣款就对不上了。
    if (this.data.intentLocked) {
      Toast('本次支付已在进行中，如需调整抵扣请先取消订单');
      return;
    }
    if (this.data.isRestrictedRepayment) {
      this.setData({ useCard: false, prepaidCardAmount: 0 });
      return;
    }
    const useCard = !!e.detail;
    if (useCard && this.data.cardBalance <= 0) {
      // 余额为 0：拦截开启
      return;
    }
    if (useCard !== this.data.useCard) {
      this._wechatAttempt = null;
      this._alipayAttempt = null;
    }
    const { paidAmount, prepaidCardAmount } = this.applyRecompute(useCard);
    // 回款场景不走 scanAdjust（仅支持待支付）；储值卡抵扣随 order.repay 一次性提交
    if (this.data.isRepayment) return;
    await this.pushAdjust(useCard, paidAmount, this.data.paymentMethod, prepaidCardAmount).catch(() => {});
  },

  /** 支付方式选择 */
  async onPayMethodChange(e: WxEvent<string>) {
    const method = e.detail as PayMethod;
    // #214（round-9）：锁不能只加在 onPayMethodTap —— van-radio-group 的 change 事件
    // 可以直接改值、绕过单元格点击那条路；改完提交会因方式与快照不符撞 PAYMENT_INTENT_ACTIVE。
    if (this.data.intentLocked) {
      if (method !== this.data.paymentMethod) {
        Toast('本次支付已在进行中，如需更换方式请先取消订单');
        this.setData({ paymentMethod: this.data.paymentMethod });
      }
      return;
    }
    if (method !== this.data.paymentMethod) {
      this._wechatAttempt = null;
      this._alipayAttempt = null;
    }
    this.setData({ paymentMethod: method });
    // 回款不预同步抵扣方案（不动部分支付订单的储值卡快照）；方式由 pay/alipayPay 自行落库
    if (!this.data.isRepayment && this.data.paidAmount > 0) {
      await this.pushAdjust(this.data.useCard, this.data.paidAmount, method, this.data.prepaidCardAmount).catch(() => {});
    }
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: PayMethod };
    // #214（round-8）：有可续付场次时支付方式已经定死在那笔渠道单里（复用判据要求方式一致，
    // 服务端改抵扣/改方式也都有守卫）。让顾客以为能改、改完付的还是老方案，是展示与资金
    // 结果不一致的来源。
    if (this.data.intentLocked && method !== this.data.paymentMethod) {
      Toast('本次支付已在进行中，如需更换方式请先取消订单');
      return;
    }
    if (method !== this.data.paymentMethod) {
      this._wechatAttempt = null;
      this._alipayAttempt = null;
    }
    this.setData({ paymentMethod: method });
    if (!this.data.isRepayment && this.data.paidAmount > 0) {
      this.pushAdjust(this.data.useCard, this.data.paidAmount, method, this.data.prepaidCardAmount).catch(() => {});
    }
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  /**
   * 支付成功后轮询确认订单状态再跳转（issue #37）。
   * payNotify 异步回调有延迟且偶发丢失，立即跳转会显示"待支付"。
   * 轮询 order.confirmPayment（后端主动对账+补偿入账）直到已支付/部分支付或超时。
   */
  async confirmAndRedirect(orderNo: string) {
    Toast.loading({ message: '支付结果确认中', forbidClick: true, duration: 0 });
    const poller = pollPaymentConfirm(orderNo, {
      baselineReceived: Number(this.data.order?.received || 0),
      expectedFirstPaymentAmount: this.data.firstPaymentAmount > 0
        ? this.data.firstPaymentAmount
        : undefined,
    });
    this._poller = poller;
    try {
      const r = await poller.promise;
      Toast.clear();
      if (r.sessionCompleted) {
        Toast.success('支付成功');
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${orderNo}` });
        }, 800);
      } else {
        // 超时仍未确认：跳详情页（带 paid=1 触发兜底轮询），提示稍后刷新
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
    // 页面隐藏（切后台 / navigateTo 跳走）停止轮询，避免后台继续请求
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
    }
  },

  /**
   * 取消订单（issue #214）
   *
   * 扫码页此前没有取消入口，顾客要取消只能绕回订单详情页；而未付款的在线支付意图
   * 又会让取消被拒，实测要等约 20 分钟。云函数侧现在会先向渠道关单再取消，这里
   * 只需把入口补上。失败文案直接透传云函数（「支付已成功」/「请稍后重试」都是它判的）。
   */
  async onCancelOrder() {
    const { orderNo, submitting } = this.data;
    if (!orderNo || submitting) return;

    // 防抖必须在弹窗**之前**置位：await showModal 期间页面仍可响应点击，
    // 置位放在 await 之后的话连点两次会弹两个确认框、发两次取消请求，
    // 第二次撞上已关闭的单，顾客刚看到「订单已取消」又吃一记红 Toast。
    this.setData({ submitting: true });

    const confirmRes = await wx.showModal({
      title: '确认取消',
      content: '确定要取消该订单吗？取消后无法恢复。',
      confirmText: '确定取消',
      confirmColor: '#FF4D4F',
    });
    if (!confirmRes.confirm) {
      this.setData({ submitting: false });
      return;
    }

    try {
      Toast.loading({ message: '取消中...', forbidClick: true, duration: 0 });
      await callClientApi('order.cancel', { saleOrderId: orderNo });
      Toast.clear();
      Toast.success('订单已取消');
      this.setData({ statusMsg: '该订单已关闭' });
    } catch (err: any) {
      Toast.clear();
      Toast.fail(err?.message || '取消失败');
    } finally {
      this.setData({ submitting: false });
    }
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
      if (errorType === 'PAYMENT_INTENT_CARD_BALANCE_BLOCKED') {
        Toast.fail(msg || '储值卡余额不足，当前支付场次已保留');
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

  /**
   * 复用已创建的渠道场次前重新确认待扣卡余额。这里只阻止调起渠道，不修改订单支付计划，
   * 因而余额恢复后仍可继续复用同一 paymentParams / share token。
   */
  async assertCachedAttemptCardBalance(pendingAmount: number): Promise<void> {
    const expected = Math.round(Math.max(0, Number(pendingAmount) || 0) * 100) / 100;
    if (expected <= 0) return;

    let balanceData: { balance: number; cardId: string | null };
    try {
      balanceData = await callClientApi<{ balance: number; cardId: string | null }>('card.balance', {});
    } catch (_err) {
      const err: any = new Error('储值卡余额暂时无法确认，当前支付场次已保留，请稍后重试');
      err.errorType = 'PAYMENT_INTENT_CARD_BALANCE_BLOCKED';
      throw err;
    }
    const current = Math.round(Math.max(0, Number(balanceData?.balance) || 0) * 100) / 100;
    this.setData({ cardBalance: current });
    if (current + 0.001 < expected) {
      const err: any = new Error(`储值卡余额不足（需 ¥${expected.toFixed(2)}），当前支付场次已保留`);
      err.errorType = 'PAYMENT_INTENT_CARD_BALANCE_BLOCKED';
      throw err;
    }
  },

  /** 根据当前 paid/method 路由到对应支付端点 */
  async executeConfirm(): Promise<void> {
    const { orderNo, paidAmount, paymentMethod, balanceUpdatedAt, firstPaymentAmount } = this.data;

    // 普通回款走 order.repay；员工已冻结 first_payment_amount 的转换单部分回款
    // 改走 pay/alipayPay，复用其服务端硬上限并允许本次金额小于整笔剩余欠款。
    //
    // #214 例外：订单上已有本人的可续付场次时，普通回款也改走 pay/alipayPay。
    // order.repay 对活动意图是 fail-fast 的（它的 pending 作废与 payable 回写在预下单前
    // 已提交，无法与渠道意图 CAS 原子化），顾客退出后重新扫码只会撞 PAYMENT_INTENT_ACTIVE
    // ——回款场景下原样复现本 issue 的症状。pay 路径能复用同一笔场次继续付。
    // 意图活跃时抵扣方案改不了（服务端有守卫），所以本次金额与快照一致，复用判据能命中。
    const canResumeViaPay = this.data.hasResumablePaymentIntent === true;
    if (this.data.isRepayment && firstPaymentAmount <= 0 && !canResumeViaPay) {
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
      const aliAmount = firstPaymentAmount > 0 ? firstPaymentAmount : paidAmount;
      const attemptKey = `order.alipayPay|${orderNo}|${aliAmount}`;
      let aliData: { status?: string; reason?: string; alipayShareToken?: string; paidAmount?: number };
      if (this._alipayAttempt?.key === attemptKey) {
        await this.assertCachedAttemptCardBalance(Number(this.data.order?.pendingPrepaidCardAmount || 0));
        aliData = {
          alipayShareToken: this._alipayAttempt.shareToken,
          paidAmount: Number(this._alipayAttempt.amount),
        };
      } else {
        aliData = await callClientApi(
          'order.alipayPay', {
            saleOrderId: orderNo,
            // 回款必须显式传金额：前端的 remaining 是**退款感知的行级口径**（已退款行不计），
            // 而后端 reserve 走订单级 total-received，会把退款额加回去。不传的话，有退款行的
            // 订单两边算出的金额对不上，复用判据直接失败 → 又撞 PAYMENT_INTENT_ACTIVE
            // （双谱系评审 round-8）。
            ...(firstPaymentAmount > 0
              ? { payAmount: firstPaymentAmount }
              : (this.data.isRepayment ? { payAmount: paidAmount } : {})),
          },
        );
      }
      // 防御性短路：后端识别为全额储值卡抵扣 → 直接跳详情页
      if (aliData?.status === '已支付' || aliData?.reason === 'prepaid_card_full') {
        this._alipayAttempt = null;
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
      this._alipayAttempt = {
        key: attemptKey,
        shareToken,
        amount: Number(aliData?.paidAmount || paidAmount).toFixed(2),
      };
      this.setData({
        showAlipayShare: true,
        alipayShareToken: shareToken,
        alipayAmount: this._alipayAttempt.amount,
      });
      return;
    }

    // wechatPay：聚合主扫直接拿 wx.requestPayment 5 字段
    // 首付场景下显式传 payAmount，后端按约束扣款 + 清空 first_payment_amount；后续扫码默认按剩余应付走
    const payPayload: { saleOrderId: string; payAmount?: number } = { saleOrderId: orderNo };
    if (firstPaymentAmount > 0) {
      payPayload.payAmount = firstPaymentAmount;
    } else if (this.data.isRepayment) {
      // 同支付宝分支：回款走 pay 时必须显式传行级口径的金额，否则有退款行的订单
      // 会因前后端算法不一致而复用失败（双谱系评审 round-8）
      payPayload.payAmount = paidAmount;
    }
    const attemptAmount = firstPaymentAmount > 0 ? firstPaymentAmount : paidAmount;
    const attemptKey = `order.pay|${orderNo}|${attemptAmount}`;
    const cachedWechatAttempt = this._wechatAttempt?.key === attemptKey ? this._wechatAttempt : null;
    const reusingWechatAttempt = !!cachedWechatAttempt;
    let payParams = cachedWechatAttempt?.paymentParams || null;
    if (!payParams) {
      const data = await callClientApi<{ paymentParams?: any }>('order.pay', payPayload);
      payParams = data.paymentParams;
      if (payParams?.paySign) {
        this._wechatAttempt = { key: attemptKey, paymentParams: payParams };
      }
    }
    if (!payParams || !payParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    if (reusingWechatAttempt) {
      await this.assertCachedAttemptCardBalance(Number(this.data.order?.pendingPrepaidCardAmount || 0));
    }
    await wx.requestPayment(payParams);
    this._wechatAttempt = null;
    await this.confirmAndRedirect(orderNo);
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
      const attemptKey = `order.repay.alipay|${orderNo}|${paidAmount}|${prepaidCardAmount}`;
      let aliData: { alipayShareToken?: string };
      if (this._alipayAttempt?.key === attemptKey) {
        await this.assertCachedAttemptCardBalance(prepaidCardAmount);
        aliData = { alipayShareToken: this._alipayAttempt.shareToken };
      } else {
        aliData = await callClientApi<{ alipayShareToken?: string }>('order.repay', {
          saleOrderId: orderNo,
          paymentMethod: '支付宝',
          repayAmount: paidAmount,
          prepaidCardAmount,
        });
      }
      const shareToken = aliData?.alipayShareToken;
      if (!shareToken) {
        Toast.fail('支付宝吱口令获取失败');
        return;
      }
      this._alipayAttempt = {
        key: attemptKey,
        shareToken,
        amount: Number(paidAmount).toFixed(2),
      };
      this.setData({
        showAlipayShare: true,
        alipayShareToken: shareToken,
        alipayAmount: Number(paidAmount).toFixed(2),
      });
      return;
    }

    // 微信：聚合主扫 wx.requestPayment（可叠加储值卡抵扣）
    const attemptKey = `order.repay.wechat|${orderNo}|${paidAmount}|${prepaidCardAmount}`;
    const cachedWechatAttempt = this._wechatAttempt?.key === attemptKey ? this._wechatAttempt : null;
    const reusingWechatAttempt = !!cachedWechatAttempt;
    let payParams = cachedWechatAttempt?.paymentParams || null;
    if (!payParams) {
      const data = await callClientApi<{ paymentParams?: any }>('order.repay', {
        saleOrderId: orderNo,
        paymentMethod: '微信',
        repayAmount: paidAmount,
        prepaidCardAmount,
      });
      payParams = data.paymentParams;
      if (payParams?.paySign) {
        this._wechatAttempt = { key: attemptKey, paymentParams: payParams };
      }
    }
    if (!payParams || !payParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    if (reusingWechatAttempt) {
      await this.assertCachedAttemptCardBalance(prepaidCardAmount);
    }
    await wx.requestPayment(payParams);
    this._wechatAttempt = null;
    await this.confirmAndRedirect(orderNo);
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
      this._wechatAttempt = null;
      this._alipayAttempt = null;
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
      this._wechatAttempt = null;
      this._alipayAttempt = null;
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
    this._alipayAttempt = null;
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
