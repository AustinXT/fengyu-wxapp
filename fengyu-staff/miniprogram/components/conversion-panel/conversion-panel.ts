// components/conversion-panel/conversion-panel.ts
// PR-C §C3 — 转换单折抵面板
// props:
//   clientUserId: string（必填，由主页 Step 0 保证）
//   convertInAmount: string | number（转入应付金额 = 父页面 payableTotal）
// 行为:
//   - observer(clientUserId) 首次有效 → 调 order.customerHeldCards 拉卡列表
//   - 每张卡 checkbox 多选；底部显示差额 = 转入 − 已选折抵总额
//   - 差额>0 时显示支付方式 picker（微信/支付宝/线下）
//   - onChange 事件：{ selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod }
//   - amountchange 事件：{ skuId, value }，父页面负责校验并重算 cart
//
// 不依赖父组件重渲染：props 变化由 observer 触发 loadCards

import { callStaffApi } from '../../utils/cloud'
import { groupTreatmentCards, selectGroupSourceIds, sumGroupValue } from '../../utils/treatment-card-group'

interface HeldCard {
  saleItemId: string;
  saleItemGroupId?: string | null;
  sourceSaleOrderId: string;
  saleOrderDatetime?: string | null;
  paidAt?: string | null;
  orderStatus?: string;
  saleOrderType?: string;
  documentType?: string | null;
  marketName?: string;
  legacySource?: string | null;
  storeId?: string;
  skuId?: string | null;
  itemDirection?: string;
  refSaleItemId?: string | null;
  productName: string;
  productType: string;
  unit: string;
  remainingSessions: number | null;
  remainingQuantity: number | null;
  unitRealPrice: string;
  deductibleAmount: string;
  quantity?: number;
  sessionCount?: number | null;
  paidSessions?: number | null;
  unitPrice?: string | null;
  saleAmount?: string | null;
  received?: string | null;
  pendingReceived?: string | null;
  expireDate?: string | null;
  remark?: string | null;
  salesCategory?: string | null;
  pickedUpQuantity?: number | null;
  /** 一级品项（product_categories.product_kind） */
  productKind?: string;
  /** 二级品项 ID（历史无分类卡为空） */
  categoryId?: string;
  /** 二级品项名称 */
  categoryName?: string;
  /** 渲染用选中标记：WXML {{}} 不支持 selectedIds.indexOf()，选中态必须落到每张卡上 */
  selected?: boolean;
  selectedQuantity?: number;
  groupKey?: string;
  cardCount?: number;
  sourceItems?: HeldCard[];
}

interface CardFilterOption {
  value: string;
  label: string;
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
          this.setData({
            useCard: false,
            cardAmountInput: '0.00',
            cardAmount: 0,
            cardAmountDisplay: '0.00',
            cardMaxDisplay: '0.00',
            remaining: 0,
            remainingDisplay: '0.00',
          });
          this.loadCards(val);
        } else {
          this._allCards = [];
          this.setData({
            cards: [],
            allCardCount: 0,
            selectedIds: [],
            deductibleSum: 0,
            deductibleSumDisplay: '0.00',
            priceDiff: 0,
            priceDiffDisplay: '0.00',
            priceDiffAbs: '0.00',
            cardProductKind: '',
            cardCategoryId: '',
            cardNameQuery: '',
            cardProductKindOptions: [],
            cardCategoryOptions: [],
            cardProductKindLabel: '全部一级品项',
            cardCategoryLabel: '全部二级品项',
            hasCardFilter: false,
            useCard: false,
            cardAmountInput: '0.00',
            cardAmount: 0,
            cardAmountDisplay: '0.00',
            cardMaxDisplay: '0.00',
            remaining: 0,
            remainingDisplay: '0.00',
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
      observer(this: any) {
        this.recalcCard();
      },
    },
    /** 转入商品清单（cart 数组，只读展示商品明细 + 疗程卡规定次数） */
    cartItems: {
      type: null,
      value: [],
    },
  },

  data: {
    loading: false,
    cards: [] as HeldCard[],
    allCardCount: 0,
    cardProductKind: '',
    cardCategoryId: '',
    cardNameQuery: '',
    cardProductKindOptions: [] as CardFilterOption[],
    cardCategoryOptions: [] as CardFilterOption[],
    cardProductKindLabel: '全部一级品项',
    cardCategoryLabel: '全部二级品项',
    hasCardFilter: false,
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
    errorMsg: '',
    /** 活动勾选（panel 内自管，change 事件上报主页） */
    isActivity: false,
    /** 充值卡抵扣（仅补差额 > 0 时可用）：开关 + 实际抵扣额 + 抵扣后应付 */
    useCard: false,
    cardAmountInput: '0.00',
    cardAmount: 0,
    cardAmountDisplay: '0.00',
    cardMaxDisplay: '0.00',
    remaining: 0,
    remainingDisplay: '0.00',
  },

  /**
   * PR-D3.3 — race 保护：实例级单调递增计数器
   * 快速切换 clientUserId 或 tab 重挂时，旧请求回包不应覆盖新状态
   * 不放在 data 里（避免触发 observer/渲染）
   */
  lifetimes: {
    // 必须在 created 初始化：properties observer 在初始赋值时触发，
    // 时机早于 attached。若放 attached，首次 clientUserId observer 调 loadCards 时
    // this._requestSeq 还是 undefined → ++ 得 NaN，回包时 NaN !== 0 被当旧回包丢弃，
    // loading 永不复位，折抵卡列表永久卡在「加载顾客折抵卡」。
    created(this: any) {
      this._requestSeq = 0;
      this._allCards = [];
    },
  },

  methods: {
    async loadCards(this: any, clientUserId: string) {
      // 防御：不依赖外部初始化，即使 _requestSeq 未初始化也不会产生 NaN
      const seq = (this._requestSeq = (this._requestSeq || 0) + 1);
      this.setData({ loading: true, errorMsg: '' });
      try {
        const data = await callStaffApi<HeldCardsResponse>('order.customerHeldCards', {
          clientUserId,
        });
        // 旧回包丢弃（已有更新请求发出）
        if (seq !== this._requestSeq) return;
        // 仅把相同业务快照的疗程卡合并为展示行；selectedIds 始终保留原始 saleItemId。
        const cards = groupTreatmentCards(data?.cards || [], {
          getId: (card) => card.saleItemId,
          getQuantity: (card) => card.quantity,
      getIdentity: (card) => card.saleItemGroupId
        ? { saleItemGroupId: card.saleItemGroupId }
        : ({
            sourceSaleOrderId: card.sourceSaleOrderId,
            saleOrderDatetime: card.saleOrderDatetime,
            paidAt: card.paidAt,
            orderStatus: card.orderStatus,
            saleOrderType: card.saleOrderType,
            documentType: card.documentType,
            marketName: card.marketName,
            legacySource: card.legacySource,
            storeId: card.storeId,
            skuId: card.skuId,
            itemDirection: card.itemDirection,
            refSaleItemId: card.refSaleItemId,
            productName: card.productName,
            productType: card.productType,
            unit: card.unit,
            remainingSessions: card.remainingSessions,
            remainingQuantity: card.remainingQuantity,
            sessionCount: card.sessionCount,
            paidSessions: card.paidSessions,
            unitPrice: card.unitPrice,
            unitRealPrice: card.unitRealPrice,
            saleAmount: card.saleAmount,
            received: card.received,
            pendingReceived: card.pendingReceived,
            deductibleAmount: card.deductibleAmount,
            expireDate: card.expireDate,
            remark: card.remark,
            salesCategory: card.salesCategory,
            pickedUpQuantity: card.pickedUpQuantity,
            productKind: card.productKind,
            categoryId: card.categoryId,
            categoryName: card.categoryName,
        quantity: card.quantity ?? 1,
      }),
        }).map((group) => {
          const primary = group.primary;
          return {
            ...primary,
            saleItemId: group.groupKey,
            groupKey: group.groupKey,
            sourceItems: group.sourceItems,
            cardCount: group.cardCount,
            quantity: sumGroupValue(group, (card) => card.quantity ?? 1),
            remainingSessions: sumGroupValue(group, (card) => card.remainingSessions),
            remainingQuantity: sumGroupValue(group, (card) => card.remainingQuantity),
            deductibleAmount: sumGroupValue(group, (card) => Number(card.deductibleAmount)).toFixed(2),
            selected: false,
            selectedQuantity: 0,
          };
        });
        this.applyCardFilters(cards, {
          productKind: '',
          categoryId: '',
          nameQuery: '',
        });
        this.setData({
          allCardCount: cards.reduce((total, card) => total + (card.cardCount || 1), 0),
          selectedIds: [],
          deductibleSum: 0,
          deductibleSumDisplay: '0.00',
          loading: false,
        });
        this.recalcDiff();
      } catch (err: unknown) {
        if (seq !== this._requestSeq) return;
        const msg = err instanceof Error ? err.message : '加载折抵卡失败';
        this._allCards = [];
        this.setData({
          cards: [],
          allCardCount: 0,
          loading: false,
          errorMsg: msg,
          cardProductKind: '',
          cardCategoryId: '',
          cardNameQuery: '',
          cardProductKindOptions: [],
          cardCategoryOptions: [],
          cardProductKindLabel: '全部一级品项',
          cardCategoryLabel: '全部二级品项',
          hasCardFilter: false,
        });
      }
    },

    applyCardFilters(
      this: any,
      cards: HeldCard[] = this._allCards || [],
      filters: { productKind?: string; categoryId?: string; nameQuery?: string } = {},
    ) {
      this._allCards = cards;
      const productKind = filters.productKind ?? this.data.cardProductKind;
      const categoryId = filters.categoryId ?? this.data.cardCategoryId;
      const nameQuery = filters.nameQuery ?? this.data.cardNameQuery;
      const productKindOptions: CardFilterOption[] = [
        { value: '', label: '全部一级品项' },
        ...Array.from(new Set(cards.map((card) => card.productKind).filter((value): value is string => Boolean(value))))
          .map((value) => ({ value, label: value })),
      ];
      const categoryOptions: CardFilterOption[] = [
        { value: '', label: productKind ? '全部二级品项' : '请先选择一级品项' },
        ...Array.from(
          new Map(
            cards
              .filter((card) => card.categoryId && card.categoryName && productKind && card.productKind === productKind)
              .map((card) => [card.categoryId!, { value: card.categoryId!, label: card.categoryName! }]),
          ).values(),
        ),
      ];
      const query = nameQuery.trim().toLocaleLowerCase();
      const filteredCards = cards.filter((card) => {
        if (productKind && card.productKind !== productKind) return false;
        if (categoryId && card.categoryId !== categoryId) return false;
        return !query || card.productName.toLocaleLowerCase().includes(query);
      });
      this.setData({
        cards: filteredCards,
        cardProductKind: productKind,
        cardCategoryId: categoryId,
        cardNameQuery: nameQuery,
        cardProductKindOptions: productKindOptions,
        cardCategoryOptions: categoryOptions,
        cardProductKindLabel: productKind || '全部一级品项',
        cardCategoryLabel: categoryOptions.find((option) => option.value === categoryId)?.label || categoryOptions[0].label,
        hasCardFilter: Boolean(productKind || categoryId || nameQuery),
      });
    },

    onCardProductKindChange(this: any, e: WechatMiniprogram.CustomEvent) {
      const index = Number(e.detail.value);
      const productKind = this.data.cardProductKindOptions[index]?.value || '';
      this.applyCardFilters(this._allCards || [], {
        productKind,
        categoryId: '',
        nameQuery: this.data.cardNameQuery,
      });
    },

    onCardCategoryChange(this: any, e: WechatMiniprogram.CustomEvent) {
      const index = Number(e.detail.value);
      const categoryId = this.data.cardCategoryOptions[index]?.value || '';
      this.applyCardFilters(this._allCards || [], { categoryId });
    },

    onCardNameChange(this: any, e: WechatMiniprogram.CustomEvent) {
      const detail = e.detail as unknown as string | { value?: string };
      const nameQuery = typeof detail === 'string' ? detail : detail?.value || '';
      this.applyCardFilters(this._allCards || [], { nameQuery });
    },

    onToggleCard(this: any, e: WechatMiniprogram.TouchEvent) {
      const groupId = e.currentTarget.dataset.id as string;
      const card = (this._allCards || []).find((item: HeldCard) => item.saleItemId === groupId);
      if (!card) return;
      const sources = card.sourceItems?.length ? card.sourceItems : [card];
      const selectedInGroup = sources.filter((source: HeldCard) => this.data.selectedIds.includes(source.saleItemId));
      this._setGroupSelection(card, selectedInGroup.length > 0 ? 0 : 1);
    },

    onCardQuantityChange(this: any, e: WechatMiniprogram.CustomEvent) {
      const groupId = e.currentTarget.dataset.id as string;
      const card = (this._allCards || []).find((item: HeldCard) => item.saleItemId === groupId);
      if (!card) return;
      this._setGroupSelection(card, Number(e.detail) || 0);
    },

    preventBubble() {},

    _setGroupSelection(this: any, card: HeldCard, count: number) {
      const sources = card.sourceItems?.length ? card.sourceItems : [card];
      const sourceIds = new Set(sources.map((source) => source.saleItemId));
      const otherIds = this.data.selectedIds.filter((id: string) => !sourceIds.has(id));
      const selectedForGroup = selectGroupSourceIds(
        {
          groupKey: card.groupKey || card.saleItemId,
          primary: card,
          sourceItems: sources,
          cardCount: card.cardCount || 1,
        },
        count,
        (source) => source.saleItemId,
      );
      const selectedIds = [...otherIds, ...selectedForGroup];
      const selectedSet = new Set(selectedIds);
      const cards = (this._allCards || []).map((item: HeldCard) => {
        const itemSources = item.sourceItems?.length ? item.sourceItems : [item];
        const selectedQuantity = itemSources.filter((source) => selectedSet.has(source.saleItemId)).length;
        return { ...item, selected: selectedQuantity > 0, selectedQuantity };
      });
      const sum = this._calcDeductibleSum(selectedIds, cards);
      this.applyCardFilters(cards);
      this.setData({
        selectedIds,
        deductibleSum: sum,
        deductibleSumDisplay: sum.toFixed(2),
      });
      this.recalcDiff(sum);
    },

    _calcDeductibleSum(this: any, selectedIds: string[], cards: HeldCard[] = this._allCards || this.data.cards): number {
      const map = new Map<string, HeldCard>();
      for (const card of cards) {
        for (const source of card.sourceItems?.length ? card.sourceItems : [card]) {
          map.set(source.saleItemId, source);
        }
      }
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
     *   card = useCard ? min(手填金额, balance, priceDiff) : 0
     *   remaining = priceDiff - card（抵扣后仍需付现金）
     * remaining <= 0（全额抵扣）时清空 paymentMethod（无需选）。
     */
    recalcCard(this: any) {
      const diff = this.data.priceDiff as number;
      const balance = Math.max(0, Number(this.properties.cardBalance) || 0);
      const maxCard = Math.round(Math.min(balance, Math.max(0, diff)) * 100) / 100;
      const requested = Number(this.data.cardAmountInput);
      const requestedAmount = Number.isFinite(requested) ? Math.max(0, requested) : 0;
      const card = this.data.useCard ? Math.min(requestedAmount, maxCard) : 0;
      const cardRounded = Math.round(card * 100) / 100;
      const remaining = Math.max(0, Math.round((Math.max(0, diff) - cardRounded) * 100) / 100);
      const update: Record<string, any> = {
        cardAmount: cardRounded,
        cardAmountDisplay: cardRounded.toFixed(2),
        cardMaxDisplay: maxCard.toFixed(2),
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
      this.setData({ useCard: next, cardAmountInput: '0.00' });
      this.recalcCard();
    },

    /** 保持输入受控，实时更新实际抵扣额。 */
    onCardAmountInput(this: any, e: WechatMiniprogram.CustomEvent) {
      this.setData({ cardAmountInput: String(e.detail?.value ?? e.detail ?? '') });
      this.recalcCard();
    },

    /** 失焦时钳制金额并保留两位小数。 */
    onCardAmountBlur(this: any) {
      const diff = Math.max(0, Number(this.data.priceDiff) || 0);
      const balance = Math.max(0, Number(this.properties.cardBalance) || 0);
      const maxCard = Math.min(balance, diff);
      const requested = Number(this.data.cardAmountInput);
      const amount = Number.isFinite(requested) ? Math.max(0, Math.min(requested, maxCard)) : 0;
      this.setData({ cardAmountInput: amount.toFixed(2) });
      this.recalcCard();
    },

    /** 支付方式卡片组点击（替代原 picker，对齐销售单 order-type-cards 样式） */
    onPaymentMethodTap(this: any, e: WechatMiniprogram.TouchEvent) {
      const method = e.currentTarget.dataset.method as string;
      if (!PAYMENT_METHODS.includes(method as PaymentMethod)) return;
      if (this.data.remaining <= 0) return;
      this.setData({ paymentMethod: method as PaymentMethod });
      this._emitChange();
    },

    /** 转入项目店长特价输入：只上报父页面，金额重算由 order-create 统一处理 */
    onSaleAmountChange(this: any, e: WechatMiniprogram.CustomEvent) {
      const skuId = e.currentTarget.dataset.skuId as string;
      if (!skuId) return;
      this.triggerEvent('amountchange', {
        skuId,
        value: String(e.detail?.value ?? ''),
      });
    },

    /** 活动勾选开关 */
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
