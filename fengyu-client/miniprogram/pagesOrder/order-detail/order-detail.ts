// pages/order-detail/order-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { pollPaymentConfirm, PaymentPoller } from '../utils/payment-poll';
import { formatDateTimeShort, formatDate, calculateTriProgress } from '../../utils/format';
import { getTreatmentCardBusinessIdentity, groupTreatmentCards, sumGroupValue } from '../utils/treatment-card-group';

interface OrderDetailItem {
  sale_item_id: string;
  sale_item_group_id?: string | null;
  sale_order_id?: string;
  sku_id?: string | null;
  item_direction?: string;
  ref_sale_item_id?: string | null;
  product_name: string;
  product_type: string;
  session_count: number;
  unit: string;
  remaining_sessions: number | null;
  paid_sessions: number | null;
  unit_price: number;
  unit_real_price?: number;
  cover_image?: string | null;
  quantity: number;
  received: number;
  prepaid_card_received?: number;
  cash_received?: number;
  pending_received?: number;
  sale_amount: number;
  refunded_amount?: number;
  expire_date: string | null;
  remark?: string | null;
  sales_category?: string | null;
  picked_up_quantity?: number | null;
  // 视图字段（前端计算注入）
  used_sessions?: number;
  used_pct?: number;
  paid_unused_pct?: number;
  unpaid_pct?: number;
  // NULL 卡（paid_sessions 原始为 null）：wxml 据此把「已付 0」改显「已付 —」
  paid_sessions_null?: boolean;
  card_count?: number;
}

interface OrderDetailData {
  sale_order_id: string;
  status: string;
  sale_order_type: string;
  is_experience_conversion?: boolean;
  document_type?: string | null;
  legacy_source?: string | null;
  sale_order_datetime: string;
  paid_at?: string | null;
  store_id?: string | null;
  market_name?: string | null;
  store_name: string;
  total_amount: number;
  payment_method: string;
  preferred_employee_id: string | null;
  preferred_staff_name: string | null;
  coupon_id: string | null;
  coupon_discount: number;
  coupon_name: string | null;
  points_used?: number;
  points_discount?: number;
  expire_at: string | null;
  // 服务端算好的剩余毫秒（issue #215）。倒计时按它走，不拿设备时钟去比绝对时间。
  // 旧版本云函数不带这个字段，前端会回退到 expire_at（见 startCountdown）
  expire_in_ms?: number | null;
  // 服务端按东八区格式化好的截止时刻 HH:mm（issue #215）。
  // 不用本地 getHours() 推——那取的是设备时区
  expire_clock?: string | null;
  // Ticket 2026-04-26 sale-order-domain-refactor:
  //   - 字段 paid_amount → received（已到账金额聚合快照）
  //   - 新增 refunded_amount（已退款金额聚合快照）
  //   - 欠款额 = payable_amount - (received - refunded_amount)
  payable_amount?: number;
  received?: number;
  refunded_amount?: number;
  prepaid_card_amount?: number;
  pending_prepaid_card_amount?: number;
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
  '已退款':     { icon: 'close',     color: '#FF4D4F' },
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
    // 是否可继续支付（回款）：部分支付 且 存在未退未付清的行（行级口径，已退行不计入）
    canContinuePay: false,
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

  _countdownTimer: null as ReturnType<typeof setTimeout> | null,
  // 从列表「继续支付」跳入（?repay=1）：详情加载完成后自动唤起回款弹层，触发一次后清除
  _autoRepay: false,
  // 支付结果轮询器（issue #37）；onUnload/onHide 清理防泄漏
  _poller: null as PaymentPoller | null,
  // 从 scan-pay 支付完成跳入（?paid=1）：详情加载后若仍待支付，触发一次兜底轮询
  _needConfirm: false,
  // single-flight：在途的那次加载（含它的尾随刷新）。触发源有 5 条
  // （onLoad / onShow / 下拉 / 倒计时归零 / 支付回调），让它们根本不并行，
  // 「旧响应盖掉新响应」就不可能发生。详见 loadDetail 的注释。
  _loadPromise: null as Promise<void> | null,
  _loadQueued: false,
  // 页面已卸载（issue #215）。onUnload 之后仍可能有在途请求回来：
  // confirmAndRefresh 里 `poller.clear()` 会 resolve 掉那个 promise，后面紧跟着
  // 一句 loadDetail —— 不拦就会在死实例上重新装表，孤儿定时器每秒对它 setData。
  _destroyed: false,
  // 页面处于隐藏态（onHide → onShow 之间）。与 _destroyed 不能合并：隐藏是可逆的，
  // onShow 会重新 loadDetail 并重建倒计时；卸载是终态。
  _hidden: false,
  // 倒计时的本地截止点（`Date.now() + 剩余量`，设备相对时间，issue #215）。
  // onHide 只停表不丢它，onShow 据此立刻恢复计时、随后的 loadDetail 只负责校准 ——
  // 不留这个的话，onShow 那次请求一失败，页面就只剩「请完成支付」且到期不会自动刷新。
  _countdownDeadlineAt: 0,
  // 最近一次 loadDetail 的实测往返耗时。expire_in_ms 是服务端生成响应那一刻的剩余量，
  // 传到手上已经过去一段了；不扣的话倒计时会比真实关单时刻晚一个 RTT。
  _lastLoadRttMs: 0,
  // 已经因「非权威的剩余量归零」重载过的订单号（issue #215）。
  //
  // 权威口径（`expire_in_ms`）那条路是**结构性收敛**的：服务端说 0 就蕴含它已经试过关单，
  // 不需要任何标记。但发版过渡期的回退口径（旧云函数只给 `expire_at`）没这个保证 ——
  // 旧后端对员工单、有在途意图的自助单**永远关不掉**却照发已过期的 expire_at，
  // 于是「归零 → 重载 → 还是归零」每个 RTT 转一圈，正是本 issue 要消灭的那个循环。
  // 回退路径按订单号只放行一次重载，之后退成静态的「请完成支付」——
  // 与旧后端的真实语义一致（那些单在旧后端本来就能付）。
  _fallbackZeroReloadedOrderId: null as string | null,
  // onHide 那一刻观测到的墙钟。隐藏期间被系统校时往回拨的话，tick 里的回拨检测
  // 看不见（onShow 恢复时 lastTickAt 用的已是调整后的时间），截止点会被凭空延长。
  _hiddenAtWallClock: 0,

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
    this._hidden = false;
    // 先按本地截止点恢复倒计时，再让下面的 loadDetail 去校准（issue #215）——
    // 反过来（等请求回来才恢复）的话，这次请求一失败倒计时就永远回不来了
    this.resumeCountdown();
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

  /**
   * 加载详情。**single-flight**：同一时刻最多一个在途请求，期间再来的请求合并成
   * 一次「尾随刷新」，并且所有调用方都能 await 到最终完成（issue #215）。
   *
   * 原先用单调 token「后发起者获胜」，但那保证的是**发起顺序**赢，不是**数据新旧**赢：
   * 先发起的请求完全可能后到服务端、因而读到更新的快照，却被判废。于是一张刚支付成功的
   * 单子可能被画回「待支付」。让请求根本不并行，这个问题就不存在了；顺带把
   * onShow / 归零重载 / 下拉同时触发的那一串合并成一次。
   */
  loadDetail(saleOrderId: string): Promise<void> {
    if (this._destroyed) return Promise.resolve();
    if (this._loadPromise) {
      // 已有在途请求：合并成一次尾随刷新，并让本次调用等到那一次也跑完
      this._loadQueued = true;
      return this._loadPromise;
    }
    const run = (async () => {
      try {
        do {
          this._loadQueued = false;
          await this._fetchDetail(saleOrderId);
        } while (this._loadQueued && !this._destroyed);
      } finally {
        this._loadPromise = null;
        this._loadQueued = false;
      }
    })();
    this._loadPromise = run;
    return run;
  },

  async _fetchDetail(saleOrderId: string) {
    if (this._destroyed) return;
    this.setData({ isLoading: true });
    const sentAt = Date.now();
    try {
      const data = await callClientApi('order.detail', { saleOrderId });
      if (this._destroyed) return;
      const order = (data?.order || {}) as OrderDetailData;
      // 记下实测往返耗时，交给 startCountdown 去扣（issue #215）。
      // ⚠️ 不能就地把 expire_in_ms 减掉 —— 那样「服务端说剩 0」和「服务端说剩 50ms、
      // 被本地扣成 0」就分不开了，而这两者的处理完全相反（前者不重载、后者必须重载）。
      // 扣整个 RTT 而不是一半，是往「显示得更少」的方向偏，安全侧。
      this._lastLoadRttMs = Math.max(0, Date.now() - sentAt);
      const items: OrderDetailItem[] = data?.items || [];
      const paymentsRaw: OrderPayment[] = (data as any)?.payments || [];
      const iconMeta = STATUS_ICON[order.status] || STATUS_ICON['已关闭'];

      // 是否有可预约项目（有效收款状态 + 至少一项"已付未用" > 0 + 非家居产品）
      // ticket 2026-05-19 paid_sessions：可消费门槛升级为"还有已付未用的次数"
      const appointableStatus = ['已支付', '部分支付', '已完成'].includes(order.status);
      const hasAppointableItems = appointableStatus
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
          unit: i.unit || (i.product_type === '家居产品' ? '盒' : '次'),
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

      // 疗程卡仅在完整业务快照一致时合并；非疗程商品始终按原始行隔离。
      // 原始 itemsWithProgress 仍用于金额/预约判断，不改变任何后续业务计算或提交参数。
      const displayItems = groupTreatmentCards(itemsWithProgress, {
        getId: (item) => item.sale_item_id,
        getQuantity: (item) => item.quantity,
        preserveNonUnitQuantity: false,
        getIdentity: (item) => {
          const identity = getTreatmentCardBusinessIdentity(item);
          return item.product_type === '疗程卡' ? identity : { ...identity, sourceId: item.sale_item_id };
        },
      }).map((group) => {
        const primary = group.primary;
        const aggregate = {
          ...primary,
          quantity: sumGroupValue(group, (item) => item.quantity),
          sale_amount: sumGroupValue(group, (item) => item.sale_amount),
          received: sumGroupValue(group, (item) => item.received),
          pending_received: sumGroupValue(group, (item) => item.pending_received),
          refunded_amount: sumGroupValue(group, (item) => item.refunded_amount),
          picked_up_quantity: sumGroupValue(group, (item) => item.picked_up_quantity),
          card_count: group.cardCount,
        };
        if (primary.product_type !== '疗程卡') return aggregate;

        const sessionCount = sumGroupValue(group, (item) => item.session_count);
        const remainingSessions = sumGroupValue(group, (item) => item.remaining_sessions);
        const paidSessionsNull = !!primary.paid_sessions_null;
        const paidSessions = paidSessionsNull
          ? 0
          : sumGroupValue(group, (item) => item.paid_sessions);
        const usedSessions = sumGroupValue(group, (item) => item.used_sessions);
        const { usedPct, paidUnusedPct, unpaidPct } = calculateTriProgress(
          sessionCount,
          remainingSessions,
          paidSessions,
        );

        return {
          ...aggregate,
          sale_item_id: group.groupKey,
          session_count: sessionCount,
          remaining_sessions: remainingSessions,
          paid_sessions: paidSessions,
          paid_sessions_null: paidSessionsNull,
          used_sessions: usedSessions,
          used_pct: usedPct,
          paid_unused_pct: paidUnusedPct,
          unpaid_pct: unpaidPct,
          card_count: group.cardCount,
        };
      });

      // 支付到期时刻（HH:mm）。优先用服务端按东八区格式化好的 expire_clock（issue #215）——
      // 本地 `getHours()` 取的是**设备时区**，顾客出境或改过时区时，同一行会变成
      // 「请在 03:15 前完成支付（剩余 09:30）」这种自相矛盾的句子：剩余量已经是服务端
      // 同源下发的，绝对时刻却还在本地推。回退分支同样是给发版过渡期留的。
      let expireTimeFmt = '';
      if (order.status === '待支付' && order.expire_at) {
        if (order.expire_clock) {
          expireTimeFmt = order.expire_clock;
        } else {
          const rawExp = String(order.expire_at);
          const ed = new Date(rawExp.includes('T') ? rawExp : rawExp.replace(/-/g, '/'));
          expireTimeFmt = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
        }
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

      // 行级口径待付额：已退行不计入（已退款不可再支付），只有「未退且未付清」的行可继续支付。
      // sale_items.received 为行净额（STEP 1.5 已扣该行退款）；未退行 received净 = received毛。
      // 2026-04-26 sale-order-domain-refactor: received/refunded_amount 替代已 DROP 的 paid_amount。
      let outstandingSum = 0;
      if (order.sale_order_type === '转换单') {
        outstandingSum = Math.max(
          0,
          Number(order.total_amount || 0) - Number(order.received || 0) + Number(order.refunded_amount || 0),
        );
      } else {
        for (const it of itemsWithProgress) {
          const refunded = Number(it.refunded_amount ?? 0);
          if (refunded > 0) continue;
          outstandingSum += Math.max(0, Number(it.sale_amount || 0) - Number(it.received || 0));
        }
      }
      const outstanding = Math.round(outstandingSum * 100) / 100;
      const refundedAmount = Number(order.refunded_amount ?? 0);
      const refundedFmt = refundedAmount.toFixed(2);
      const hasRefund = refundedAmount > 0 && order.status !== '已退款';
      // 可继续支付（回款）：部分支付 且 存在未退未付清的行
      const canContinuePay = order.status === '部分支付'
        && outstanding > 0
        && !order.is_experience_conversion;

      this.setData({
        order: {
          ...order,
          items: displayItems,
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
        canContinuePay,
      });

      // 启动倒计时
      this.startCountdown(order);

      // 从列表「继续支付」跳入：自动唤起回款弹层（仅触发一次）
      if (this._autoRepay) {
        this._autoRepay = false;
        if (canContinuePay && this.data.continuePayEnabled) {
          this.onContinuePayTap();
        }
      }
      // 从 scan-pay 支付完成跳入（?paid=1）：回调延迟/丢失仍待支付时，兜底轮询确认（issue #37）
      // 隐藏态下不启动轮询，**也不消耗这个意图**——下一次 onShow 的 loadDetail 会再走到这里
      if (this._needConfirm && !this._hidden && !this._destroyed) {
        this._needConfirm = false;
        if (order.status === '待支付' || order.status === '部分支付') {
          this.confirmAndRefresh(order.sale_order_id);
        }
      }
    } catch {
      // 卸载后、或隐藏期间才失败的那次不弹 Toast：
      // 前者是对着死实例弹，后者会让用户切回来时看到一条陈旧的错误提示
      if (!this._destroyed && !this._hidden) Toast.fail('加载失败');
    } finally {
      if (!this._destroyed) this.setData({ isLoading: false });
    }
  },

  /** 停表（不动 countdown 文案，调用方按需自己清） */
  _stopCountdown() {
    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  /**
   * 待支付倒计时。
   *
   * 「归零重载」这条链原本会死循环：loadDetail → startCountdown → 归零 → loadDetail，
   * 靠「后端把 status 改成已关闭」才能终止，对关不掉的订单就按网络 RTT 空转。
   *
   * 断点不是加一个「只重载一次」的标记，而是**区分装表时机**（issue #215）：
   *   - 装表时就已经过期 → 只清 UI，**不重载**。这次 detail 响应本身就刚跑过服务端的
   *     懒清理，再打一次拿到的还是同一个答案。
   *   - 走着走着归零 → 重载一次取回懒清理后的状态。重载回来 `expire_at` 必已过期，
   *     必然落进上一条 → **两跳内收敛，不需要任何状态**。
   */
  startCountdown(order: OrderDetailData) {
    this._stopCountdown();

    if (order.status !== '待支付' || !order.expire_at) {
      this._countdownDeadlineAt = 0;
      this.setData({ countdown: '' });
      return;
    }

    // 计时基准优先用服务端算好的剩余毫秒（issue #215）。
    // 只比绝对时间的话，手机时钟快几分钟就会把一个刚下发的未来时限判成「已过期」，
    // 自助单于是彻底看不到倒计时。这里只用设备时钟量**相对流逝**，不用它判绝对先后。
    // 回退分支是为发版过渡期留的：旧云函数不带 expire_in_ms，退回绝对时间口径。
    // ⚠️ 必须判 `typeof === 'number'`：`Number(null)` 是 0 且 isFinite，
    // 会把「服务端没下发这个字段」静默当成「剩余 0」，而不是回退到绝对时间口径。
    //
    // `authoritative` 记的是「这个剩余量是不是服务端亲口说的」——下面判「0」时要用。
    let serverRemaining: number;
    let authoritative: boolean;
    if (typeof order.expire_in_ms === 'number' && Number.isFinite(order.expire_in_ms)) {
      serverRemaining = order.expire_in_ms;
      authoritative = true;
    } else {
      const rawExpire = String(order.expire_at);
      const expireMs = new Date(
        rawExpire.includes('T') ? rawExpire : rawExpire.replace(/-/g, '/'),
      ).getTime();
      if (!Number.isFinite(expireMs)) {
        // 解析不出来就别装表——否则每秒推一个 "NaN:NaN"
        this._countdownDeadlineAt = 0;
        this.setData({ countdown: '' });
        return;
      }
      // 绝对时间这条回退路径本来就是按「此刻」算的，传输耗时已经含在里面了，
      // 下面不能再扣一次 RTT
      serverRemaining = expireMs - Date.now();
      authoritative = false;
    }

    // ⚠️ 必须区分两种「0」（双谱系评审 round-3 / round-4）：
    //   - **服务端权威**地说 0 → 它已经试过关单了（那边补关复检与剩余量计算共用同一个
    //     nowMs，严格保证这点）→ 只清 UI，不重载。这是死循环的结构性断点。
    //   - 其它任何算出来的 0（旧云函数的绝对时间回退、扣掉 RTT 之后归零）→
    //     服务端**还没试过关**，必须当成「走着走着归零」重载一次让它去关。
    //     混为一谈，页面就会永久停在「待支付 / 请完成支付 / 去支付」。
    if (authoritative && serverRemaining <= 0) {
      this._countdownDeadlineAt = 0;
      this.setData({ countdown: '' });
      return;
    }

    const remainingAt0 = authoritative ? serverRemaining - this._lastLoadRttMs : serverRemaining;
    if (remainingAt0 <= 0) {
      this._countdownDeadlineAt = 0;
      this.setData({ countdown: '' });
      // 非权威（旧云函数回退）那条路没有「服务端已试过关单」的保证，重载回来大概率
      // 还是同一个答案 —— 按订单号只放行一次，否则就是每个 RTT 一圈的无界循环。
      // 权威路径不受此限：它的收敛由服务端侧的补关保证（见上面的注释）。
      if (!authoritative) {
        if (this._fallbackZeroReloadedOrderId === order.sale_order_id) return;
        this._fallbackZeroReloadedOrderId = order.sale_order_id;
      }
      // 隐藏/已卸载时不发这一次后台请求；onShow 必定 loadDetail，不会漏刷新
      if (!this._hidden && !this._destroyed) this.loadDetail(order.sale_order_id);
      return;
    }

    this._installCountdown(Date.now() + remainingAt0, order.sale_order_id);
  },

  /**
   * 按本地截止点装表。deadline 是**设备相对时间**（`Date.now() + 剩余量`），
   * 只用来量流逝，不参与任何绝对先后判断。
   * 单独抽出来是为了让 onShow 能在不依赖网络的情况下恢复计时（见 resumeCountdown）。
   */
  _installCountdown(deadlineAt: number, saleOrderId: string) {
    this._stopCountdown();
    this._countdownDeadlineAt = deadlineAt;

    // 隐藏态记下截止点但不装表（issue #215）：隐藏页拿着 1Hz 定时器会在用户
    // 看不见时归零并发一次后台请求。onShow 会据 _countdownDeadlineAt 恢复。
    if (this._hidden || this._destroyed) {
      this.setData({ countdown: '' });
      return;
    }

    let lastTickAt = Date.now();
    const tick = () => {
      this._countdownTimer = null;
      const now = Date.now();
      // 系统校时/用户手动改时间会让墙钟往回跳，截止点就被凭空延长了 —— 服务端那边
      // 早关单了，页面还显示着剩余时间，顾客点「去支付」才被拒（issue #215）。
      // 小程序没有可靠的单调时钟，退而求其次：察觉明显回拨就回服务端重新校准。
      if (now - lastTickAt < -2000) {
        this._stopCountdown();
        this._countdownDeadlineAt = 0;
        this.setData({ countdown: '' });
        if (!this._hidden && !this._destroyed) this.loadDetail(saleOrderId);
        return;
      }
      lastTickAt = now;
      const remaining = this._countdownDeadlineAt - now;
      if (remaining <= 0) {
        this._stopCountdown();
        this._countdownDeadlineAt = 0;
        this.setData({ countdown: '' });
        // 与上面回拨分支同款守卫。当前 onHide/onUnload 都已停表所以不可达，
        // 但停表逻辑一旦改松，这里就是漏点（双谱系评审 round-6 P3）
        if (!this._hidden && !this._destroyed) this.loadDetail(saleOrderId);
        return;
      }
      // 必须 ceil：floor 会让 (0, 1000) 毫秒这一拍显示 "00:00"，
      // 而订单此刻仍是待支付、「去支付」照样能点 —— 正是本 issue 要消灭的矛盾态
      const totalSecs = Math.ceil(remaining / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      const next = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      // 同值不重复推：setData 跨线程
      if (next !== this.data.countdown) this.setData({ countdown: next });

      // ⚠️ 不能用固定 1000ms 的 setInterval（双谱系评审 round-5）：截止点几乎从不落在
      // 整秒边界上，最后一拍就会晚到最多 999ms —— 那段时间页面还显示着「剩余 00:01」
      // 而订单已经过期，点「去支付」直接被后端拒。改成算准下一次**显示值该变**的时刻，
      // 最后一拍就恰好落在截止点上。
      this._countdownTimer = setTimeout(tick, Math.max(0, remaining - (totalSecs - 1) * 1000));
    };

    tick();
  },

  /**
   * onShow 时先按本地截止点恢复计时，再让 loadDetail 去校准（issue #215）。
   *
   * 不恢复的话，onHide → onShow 那次 loadDetail 一旦失败（弱网），页面就只剩
   * 「请完成支付」，到期也不会自动刷新 —— 自助单从此看不到时限。
   */
  resumeCountdown() {
    if (this._countdownDeadlineAt <= 0) return;
    if (this.data.order?.status !== '待支付') {
      this._countdownDeadlineAt = 0;
      return;
    }
    // 隐藏期间墙钟被往回拨过 → 这个截止点已经不可信了（tick 里的回拨检测看不见
    // 隐藏期发生的跳变）。丢掉它，等紧随其后的 loadDetail 从服务端重新校准。
    if (this._hiddenAtWallClock > 0 && Date.now() < this._hiddenAtWallClock - 2000) {
      this._countdownDeadlineAt = 0;
      this.setData({ countdown: '' });
      return;
    }
    // 已经过了截止点就别在这里发请求：紧跟着的 onShow loadDetail 会刷新，
    // 在这儿再发一次只是白打一个必定被 token 判废的请求
    if (this._countdownDeadlineAt - Date.now() <= 0) {
      this._countdownDeadlineAt = 0;
      this.setData({ countdown: '' });
      return;
    }
    this._installCountdown(this._countdownDeadlineAt, this.data.order.sale_order_id);
  },

  /**
   * 支付结果轮询确认 + 刷新（issue #37）。
   * 用于本页发起的回款支付成功后，或从 scan-pay 带 paid=1 跳入时的兜底确认。
   * 轮询期间置 confirmingPayment=true 隐藏待支付倒计时（防频闪）；完成或超时后 loadDetail 刷新。
   */
  async confirmAndRefresh(saleOrderId: string) {
    if (this._poller) return; // 防重入
    // 停止待支付倒计时，避免轮询期间每秒 setData 造成频闪
    this._stopCountdown();
    this.setData({ confirmingPayment: true, countdown: '' });
    const poller = pollPaymentConfirm(saleOrderId, {
      baselineReceived: Number(this.data.order?.received || 0),
    });
    this._poller = poller;
    try {
      const paymentResult = await poller.promise;
      // onUnload / onHide 里的 `poller.clear()` 会 resolve 掉这个 promise（不是 reject），
      // 所以卸载和隐藏也会走到这里。不拦的话会在看不见的页面上继续请求、弹 Toast（issue #215）。
      // ⚠️ 隐藏导致的中断要把「待确认」意图还回去：渠道可能已经扣款而回调延迟，
      // 意图丢了就再也不会主动对账，顾客端会一直显示待支付（双谱系评审 round-4）。
      if (this._hidden && !this._destroyed) this._needConfirm = true;
      if (this._destroyed || this._hidden) return;
      await this.loadDetail(saleOrderId);
      if (this._destroyed || this._hidden) return;
      // 以刷新后的本地 status 为准（轮询结果可能因网络抖动过时），判断是否需要提示
      const finalStatus = this.data.order?.status;
      if (finalStatus !== '已支付' && !paymentResult.sessionCompleted) {
        // 超时仍未确认到账：提示用户稍后下拉刷新（订单已扣款，回调可能仍在补偿）
        Toast.fail('支付确认中，请稍后下拉刷新');
      }
    } finally {
      if (this._poller === poller) this._poller = null;
      if (!this._destroyed) this.setData({ confirmingPayment: false });
    }
  },

  onUnload() {
    // 置 destroyed 后，在途 loadDetail 回来时会在入口早退，不再落 setData、不再装表
    // —— 否则孤儿定时器每秒对死实例 setData，最长烧到 expire_at 到点（issue #215）
    this._destroyed = true;
    this._stopCountdown();
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
    }
  },

  onHide() {
    this._hidden = true;
    this._hiddenAtWallClock = Date.now();
    // 页面隐藏（navigateTo 跳走 / tab 切换）停止轮询，避免后台继续请求
    if (this._poller) {
      this._poller.clear();
      this._poller = null;
      this.setData({ confirmingPayment: false });
    }
    // 倒计时同样停掉（issue #215）：隐藏期间 1Hz 的 setData 是纯浪费，
    // 更要紧的是它会在用户看不见的时候归零并发一次后台重载。
    // ⚠️ 只停表，**不清 `_countdownDeadlineAt`** —— onShow 靠它恢复计时。
    this._stopCountdown();
    if (this.data.countdown) this.setData({ countdown: '' });
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
