












import { callStaffApi } from '../../utils/cloud'

interface HeldCard {
  saleItemId: string;
  sourceSaleOrderId: string;
  productName: string;
  productType: string;
  remainingSessions: number | null;
  remainingQuantity: number | null;
  unitRealPrice: string;
  deductibleAmount: string;
  
  selected?: boolean;
}

interface HeldCardsResponse {
  cards: HeldCard[];
}

type PaymentMethod = '微信' | '支付宝' | '线下';
const PAYMENT_METHODS: PaymentMethod[] = ['微信', '支付宝', '线下'];

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
    
    convertInAmount: {
      type: null,
      value: 0,
      observer(this: any) {
        this.recalcDiff();
      },
    },
    
    cardBalance: {
      type: Number,
      value: 0,
      observer(this: any, val: number) {
        
        
        
        if (!this._cardInit && Number(val) > 0) {
          this._cardInit = true;
          this.setData({ useCard: true });
        }
        this.recalcCard();
      },
    },
    
    cartItems: {
      type: null,
      value: [],
    },
  },

  data: {
    loading: false,
    cards: [] as HeldCard[],
    
    selectedIds: [] as string[],
    
    deductibleSum: 0,
    
    priceDiff: 0,
    
    priceDiffDisplay: '0.00',
    
    priceDiffAbs: '0.00',
    
    deductibleSumDisplay: '0.00',
    
    paymentMethod: null as null | PaymentMethod,
    errorMsg: '',
    
    isActivity: false,
    
    useCard: false,
    cardAmount: 0,
    cardAmountDisplay: '0.00',
    remaining: 0,
    remainingDisplay: '0.00',
  },

  
  lifetimes: {
    
    
    
    
    created(this: any) {
      this._requestSeq = 0;
      this._cardInit = false;
    },
  },

  methods: {
    async loadCards(this: any, clientUserId: string) {
      
      const seq = (this._requestSeq = (this._requestSeq || 0) + 1);
      this.setData({ loading: true, errorMsg: '' });
      try {
        const data = await callStaffApi<HeldCardsResponse>('order.customerHeldCards', {
          clientUserId,
        });
        
        if (seq !== this._requestSeq) return;
        
        const cards = (data?.cards || []).map((c) => ({ ...c, selected: false }));
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
      
      const cards = this.data.cards.map((c: HeldCard) => ({
        ...c,
        selected: selected.indexOf(c.saleItemId) >= 0,
      }));
      this.setData({
        cards,
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
      
      this.recalcCard();
    },

    
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
      
      if (remaining <= 0 && this.data.paymentMethod) {
        update.paymentMethod = null;
      }
      this.setData(update);
      this._emitChange();
    },

    
    onToggleUseCard(this: any, e: WechatMiniprogram.CustomEvent) {
      const next = !!e.detail;
      if (next === this.data.useCard) return;
      if (next && (Number(this.properties.cardBalance) || 0) <= 0) return;
      this.setData({ useCard: next });
      this.recalcCard();
    },

    
    onPaymentMethodTap(this: any, e: WechatMiniprogram.TouchEvent) {
      const method = e.currentTarget.dataset.method as string;
      if (!PAYMENT_METHODS.includes(method as PaymentMethod)) return;
      if (this.data.remaining <= 0) return;
      this.setData({ paymentMethod: method as PaymentMethod });
      this._emitChange();
    },

    
    onToggleActivity(this: any, e: WechatMiniprogram.CustomEvent) {
      const next = !!e.detail;
      this.setData({ isActivity: next });
      this._emitChange();
    },

    _emitChange() {
      this.triggerEvent('change', {
        selectedSaleItemIds: [...this.data.selectedIds],
        deductibleSum: this.data.deductibleSum,
        priceDiff: this.data.priceDiff,
        paymentMethod: this.data.paymentMethod,
        prepaidCardAmount: this.data.cardAmount,
        remaining: this.data.remaining,
        isActivity: this.data.isActivity,
      });
    },
  },
});
