// components/conversion-panel/conversion-panel.ts
// PR-C §C3 — 转换单折抵面板
// props:
//   clientUserId: string（必填，由主页 Step 0 保证）
//   convertInAmount: string | number（转入项金额 = cartTotal）
// 行为:
//   - observer(clientUserId) 首次有效 → 调 order.customerHeldCards 拉卡列表
//   - 每张卡 checkbox 多选；底部显示差额 = 转入 − 已选折抵总额
//   - 差额>0 时显示支付方式 picker（微信/线下）
//   - onChange 事件：{ selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod }
//
// 不依赖父组件重渲染：props 变化由 observer 触发 loadCards

import { callStaffApi } from '../../utils/cloud'

interface HeldCard {
  saleItemId: string;
  sourceSaleOrderId: string;
  productName: string;
  skuSpecName: string;
  productType: string;
  remainingSessions: number | null;
  remainingQuantity: number | null;
  unitRealPrice: string;
  deductibleAmount: string;
}

interface HeldCardsResponse {
  cards: HeldCard[];
}

type PaymentMethod = '微信' | '线下';
const PAYMENT_METHODS: PaymentMethod[] = ['微信', '线下'];

Component({
  properties: {
    clientUserId: {
      type: String,
      value: '',
      observer(this: any, val: string) {
        if (val) {
          this.loadCards(val);
        } else {
          this.setData({
            cards: [],
            selectedIds: [],
            deductibleSum: 0,
            deductibleSumDisplay: '0.00',
            priceDiff: 0,
            priceDiffDisplay: '0.00',
            priceDiffAbs: '0.00',
          });
        }
      },
    },
    /** 转入项金额（cartTotal 字符串或数字均可） */
    convertInAmount: {
      type: null,
      value: 0,
      observer(this: any) {
        this.recalcDiff();
      },
    },
    /** 顾客储值卡余额（跨店统一）；> 0 时在补差额场景渲染抵扣开关 */
    cardBalance: {
      type: Number,
      value: 0,
      observer(this: any, val: number) {
        // 余额「首次 > 0」时默认开启抵扣（与销售单"能抵多少抵多少"口径一致）；
        // 仅在 val>0 时 init，避免余额异步加载前以 0 触发 observer 把默认开锁死。
        // 之后尊重店长手动开关（_cardInit 已置 true 不再覆盖）。
        if (!this._cardInit && Number(val) > 0) {
          this._cardInit = true;
          this.setData({ useCard: true });
        }
        this.recalcCard();
      },
    },
  },

  data: {
    loading: false,
    cards: [] as HeldCard[],
    /** 已选 saleItemId 列表 */
    selectedIds: [] as string[],
    /** 已选卡的折抵总额 */
    deductibleSum: 0,
    /** 差额 = convertInAmount − deductibleSum */
    priceDiff: 0,
    /** 正差额展示值（保留 2 位小数；priceDiff > 0 时使用） */
    priceDiffDisplay: '0.00',
    /** 负差额绝对值（WXML 展示"充入储值卡"金额） */
    priceDiffAbs: '0.00',
    /** 折抵总额展示值（保留 2 位小数） */
    deductibleSumDisplay: '0.00',
    /** 支付方式（抵扣后仍需补现金时必选） */
    paymentMethod: null as null | PaymentMethod,
    paymentMethodOptions: PAYMENT_METHODS as unknown as string[],
    showPaymentPicker: false,
    errorMsg: '',
    /** 充值卡抵扣（仅补差额 > 0 时可用）：开关 + 实际抵扣额 + 抵扣后应付 */
    useCard: false,
    cardAmount: 0,
    cardAmountDisplay: '0.00',
    remaining: 0,
    remainingDisplay: '0.00',
  },

  /**
   * PR-D3.3 — race 保护：实例级单调递增计数器
   * 快速切换 clientUserId 或 tab 重挂时，旧请求回包不应覆盖新状态
   * 不放在 data 里（避免触发 observer/渲染）
   */
  lifetimes: {
    attached(this: any) {
      this._requestSeq = 0;
      this._cardInit = false;
    },
  },

  methods: {
    async loadCards(this: any, clientUserId: string) {
      const seq = ++this._requestSeq;
      this.setData({ loading: true, errorMsg: '' });
      try {
        const data = await callStaffApi<HeldCardsResponse>('order.customerHeldCards', {
          clientUserId,
        });
        // 旧回包丢弃（已有更新请求发出）
        if (seq !== this._requestSeq) return;
        const cards = data?.cards || [];
        this.setData({
          cards,
          selectedIds: [],
          deductibleSum: 0,
          deductibleSumDisplay: '0.00',
          loading: false,
        });
        this.recalcDiff();
      } catch (err: unknown) {
        if (seq !== this._requestSeq) return;
        const msg = err instanceof Error ? err.message : '加载折抵卡失败';
        this.setData({ cards: [], loading: false, errorMsg: msg });
      }
    },

    onToggleCard(e: WechatMiniprogram.TouchEvent) {
      const saleItemId = e.currentTarget.dataset.id as string;
      const selected = [...this.data.selectedIds];
      const idx = selected.indexOf(saleItemId);
      if (idx >= 0) {
        selected.splice(idx, 1);
      } else {
        selected.push(saleItemId);
      }
      const sum = this._calcDeductibleSum(selected);
      this.setData({
        selectedIds: selected,
        deductibleSum: sum,
        deductibleSumDisplay: sum.toFixed(2),
      });
      this.recalcDiff(sum);
    },

    _calcDeductibleSum(selectedIds: string[]): number {
      const map = new Map<string, HeldCard>();
      for (const c of this.data.cards) map.set(c.saleItemId, c);
      let sum = 0;
      for (const id of selectedIds) {
        const c = map.get(id);
        if (c) sum += Number(c.deductibleAmount) || 0;
      }
      return Math.round(sum * 100) / 100;
    },

    /** 父传 convertInAmount 可能是字符串 '12.34' 或数字，统一 Number 解析 */
    _parseConvertInAmount(): number {
      const raw = this.data.convertInAmount as unknown;
      if (raw == null) return 0;
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    },

    recalcDiff(deductibleSum?: number) {
      const inAmount = this._parseConvertInAmount();
      const sum = deductibleSum != null ? deductibleSum : this.data.deductibleSum;
      const diff = Math.round((inAmount - sum) * 100) / 100;
      this.setData({
        priceDiff: diff,
        priceDiffDisplay: Math.max(0, diff).toFixed(2),
        priceDiffAbs: Math.abs(diff).toFixed(2),
      });
      // 充值卡抵扣 + 剩余应付随差额变化重算（recalcCard 内统一 setData + emit）
      this.recalcCard();
    },

    /**
     * 重算充值卡抵扣额（仅补差额 priceDiff > 0 时生效）：
     *   card = useCard && balance > 0 ? min(balance, priceDiff) : 0（能抵多少抵多少）
     *   remaining = priceDiff - card（抵扣后仍需付现金）
     * remaining <= 0（全额抵扣）时清空 paymentMethod（无需选）。
     */
    recalcCard(this: any) {
      const diff = this.data.priceDiff as number;
      const balance = Number(this.properties.cardBalance) || 0;
      const card = (diff > 0 && this.data.useCard && balance > 0)
        ? Math.min(balance, diff)
        : 0;
      const cardRounded = Math.round(card * 100) / 100;
      const remaining = Math.max(0, Math.round((Math.max(0, diff) - cardRounded) * 100) / 100);
      const update: Record<string, any> = {
        cardAmount: cardRounded,
        cardAmountDisplay: cardRounded.toFixed(2),
        remaining,
        remainingDisplay: remaining.toFixed(2),
      };
      // 抵扣后无需付现金 → 清空支付方式
      if (remaining <= 0 && this.data.paymentMethod) {
        update.paymentMethod = null;
      }
      this.setData(update);
      this._emitChange();
    },

    /** 切换充值卡抵扣开关 */
    onToggleUseCard(this: any, e: WechatMiniprogram.CustomEvent) {
      const next = !!e.detail;
      if (next === this.data.useCard) return;
      if (next && (Number(this.properties.cardBalance) || 0) <= 0) return;
      this.setData({ useCard: next });
      this.recalcCard();
    },

    onOpenPaymentPicker() {
      if (this.data.remaining <= 0) return;
      this.setData({ showPaymentPicker: true });
    },

    onPaymentPickerClose() {
      this.setData({ showPaymentPicker: false });
    },

    onPaymentPickerConfirm(e: WechatMiniprogram.CustomEvent) {
      const picked = (e.detail?.value ?? '') as string;
      if (PAYMENT_METHODS.includes(picked as PaymentMethod)) {
        this.setData({ paymentMethod: picked as PaymentMethod, showPaymentPicker: false });
        this._emitChange();
      } else {
        this.setData({ showPaymentPicker: false });
      }
    },

    _emitChange() {
      this.triggerEvent('change', {
        selectedSaleItemIds: [...this.data.selectedIds],
        deductibleSum: this.data.deductibleSum,
        priceDiff: this.data.priceDiff,
        paymentMethod: this.data.paymentMethod,
        prepaidCardAmount: this.data.cardAmount,
        remaining: this.data.remaining,
      });
    },
  },
});
