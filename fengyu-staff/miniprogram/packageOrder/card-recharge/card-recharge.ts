// packageOrder/card-recharge/card-recharge.ts — 店长替顾客充值
import { callStaffApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

/** 档位 SKU（来自 card.rechargeSkus，沿用 product_skus 现状） */
interface TierSku {
  skuId: string;
  productName: string;
  specName: string;
  faceValue: number;
  payAmount: number;
  bonus: number;
  discount: number;
  productType: string;
  categoryId: string;
  categoryName: string;
}

interface TierVM extends TierSku {
  discountLabel: string;
  payAmountLabel: string;
  bonusLabel: string;
}

interface TierBreakpoint {
  faceValue: number;
  discount: number;
  payAmount: number;
}

interface CustomConfig {
  minAmount: number;
  maxAmount: number;
  tierBreakpoints: TierBreakpoint[];
}

interface RechargeSkusResponse {
  tiers: TierSku[];
  customConfig: CustomConfig;
}

interface CustomerInfo {
  id: string;
  name: string;
  phone: string;
  phoneMasked?: string;
}

interface RechargeResponse {
  saleOrderId: string;
  saleItemId: string;
  skuId: string;
  faceValue: number;
  payAmount: number;
  paymentMethod: '线下' | '微信';
  status: string;
}

/** 格式化小数（去尾 0） */
function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 100) / 100).toString();
}

/** 折扣 0.99 → "9.9 折"；0.95 → "9.5 折" */
function formatDiscountLabel(d: number): string {
  const t = d * 10;
  return t.toFixed(1).replace(/\.0$/, '') + ' 折';
}

/** 前端本地 tier 匹配（逻辑与后端 matchTier 一致，用 customConfig.tierBreakpoints 作断点） */
function matchTierLocal(amount: number, config: CustomConfig): { discount: number; payAmount: number } | { error: string } {
  if (!Number.isFinite(amount)) return { error: '金额格式错误' };
  if (Math.round(amount * 100) !== amount * 100) return { error: '最多保留 2 位小数' };
  if (amount < config.minAmount) return { error: `最低 ¥${config.minAmount}` };
  if (amount > config.maxAmount) return { error: `上限 ¥${config.maxAmount}` };
  const breakpoints = [...(config.tierBreakpoints || [])].sort((a, b) => a.faceValue - b.faceValue);
  let discount = breakpoints.length > 0 ? breakpoints[0].discount : 1;
  for (const tier of breakpoints) {
    if (amount >= tier.faceValue) discount = tier.discount;
  }
  const payAmount = Math.round(amount * discount * 100) / 100;
  return { discount, payAmount };
}

Page({
  data: {
    configLoading: true,
    boundStoreName: '',
    boundStoreId: '',

    // 顾客
    customerPhone: '',
    customerSearching: false,
    customerInfo: null as CustomerInfo | null,

    // 档位 + 自定义
    tiers: [] as TierVM[],
    minAmount: 500,
    maxAmount: 100000,

    selectedSkuId: '',       // 选中的档位 SKU id
    customMode: false,       // 是否处于自定义金额模式
    customInput: '',
    customPayAmount: 0,
    customDiscountLabel: '',
    customPayAmountLabel: '',
    customBonus: 0,
    customBonusLabel: '',
    customError: '',

    // 支付方式
    paymentMethod: '线下' as '线下' | '微信',

    // CTA
    ctaText: '请选择充值金额',
    ctaDisabled: true,

    // 提交态
    submitting: false,
  },

  _customConfig: null as CustomConfig | null,

  onLoad(query: Record<string, string>) {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreId: storeId, boundStoreName: storeName });

    // 可选：从 URL 参数预填顾客
    if (query?.clientUserId && query?.customerName) {
      this.setData({
        customerInfo: {
          id: query.clientUserId,
          name: query.customerName,
          phone: query.customerPhone || '',
          phoneMasked: query.customerPhone ? query.customerPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '',
        },
      });
    }

    this.loadConfig();
  },

  onShow() {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    if (storeId !== this.data.boundStoreId || storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreId: storeId, boundStoreName: storeName });
    }
  },

  async loadConfig() {
    try {
      this.setData({ configLoading: true });
      const data = await callStaffApi<RechargeSkusResponse>('card.rechargeSkus', {});
      const tiers: TierVM[] = (data?.tiers || []).map(t => ({
        ...t,
        discountLabel: formatDiscountLabel(t.discount),
        payAmountLabel: formatAmount(t.payAmount),
        bonusLabel: formatAmount(t.bonus),
      }));
      this._customConfig = data?.customConfig || {
        minAmount: 500,
        maxAmount: 100000,
        tierBreakpoints: [],
      };
      this.setData({
        tiers,
        minAmount: this._customConfig.minAmount,
        maxAmount: this._customConfig.maxAmount,
        configLoading: false,
      });
      this.updateCta();
    } catch (err: any) {
      this.setData({ configLoading: false });
      wx.showToast({ title: err?.message || '加载档位失败', icon: 'none' });
    }
  },

  // ============ 顾客选择 ============

  onCustomerPhoneInput(e: WechatMiniprogram.CustomEvent) {
    const value = (e.detail as { value?: string })?.value || '';
    this.setData({ customerPhone: value });
  },

  async onSearchCustomer() {
    const phone = (this.data.customerPhone || '').trim();
    if (!phone || phone.length < 11 || this.data.customerSearching) return;

    this.setData({ customerSearching: true });
    try {
      const results = await callStaffApi<CustomerInfo[]>('customer.search', { phone });
      const found = results && results[0];
      if (found && found.id) {
        this.setData({ customerInfo: found });
        this.updateCta();
      } else {
        wx.showModal({
          title: '顾客未注册',
          content: '充值需顾客已注册小程序，请先引导顾客注册后再充值。',
          showCancel: false,
          confirmColor: '#C0322A',
        });
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message || '查询失败', icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onClearCustomer() {
    this.setData({ customerInfo: null, customerPhone: '' });
    this.updateCta();
  },

  // ============ 档位 ============

  onTierTap(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    if (!skuId) return;
    const tier = this.data.tiers.find(t => t.skuId === skuId);
    if (!tier) return;

    this.setData({
      selectedSkuId: skuId,
      customMode: false,
      customInput: '',
      customError: '',
      customPayAmount: 0,
    });
    this.updateCta();
  },

  // ============ 自定义金额 ============

  onCustomFocus() {
    this.setData({ customMode: true, selectedSkuId: '' });
  },

  onCustomInput(e: WechatMiniprogram.CustomEvent) {
    const raw = ((e.detail as { value?: string })?.value || '').trim();
    this.setData({ customInput: raw, customMode: true, selectedSkuId: '' });

    if (!raw) {
      this.setData({
        customError: '',
        customPayAmount: 0,
        customDiscountLabel: '',
        customPayAmountLabel: '',
        customBonus: 0,
        customBonusLabel: '',
      });
      this.updateCta();
      return;
    }

    const amount = Number(raw);
    const config = this._customConfig;
    if (!config) return;
    const result = matchTierLocal(amount, config);
    if ('error' in result) {
      this.setData({
        customError: result.error,
        customPayAmount: 0,
        customDiscountLabel: '',
        customPayAmountLabel: '',
        customBonus: 0,
        customBonusLabel: '',
      });
      this.updateCta();
      return;
    }
    const bonus = Math.round((amount - result.payAmount) * 100) / 100;
    this.setData({
      customError: '',
      customPayAmount: result.payAmount,
      customDiscountLabel: formatDiscountLabel(result.discount),
      customPayAmountLabel: formatAmount(result.payAmount),
      customBonus: bonus,
      customBonusLabel: formatAmount(bonus),
    });
    this.updateCta();
  },

  // ============ 支付方式 ============

  onPaymentMethodChange(e: WechatMiniprogram.CustomEvent) {
    const next = (e.detail as unknown) as '线下' | '微信';
    if (next !== '线下' && next !== '微信') return;
    this.setData({ paymentMethod: next });
    this.updateCta();
  },

  onPaymentOptionTap(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.method as '线下' | '微信';
    if (next !== '线下' && next !== '微信') return;
    if (next === this.data.paymentMethod) return;
    this.setData({ paymentMethod: next });
    this.updateCta();
  },

  // ============ CTA 文案 ============

  updateCta() {
    const { customerInfo, selectedSkuId, customMode, customInput, customPayAmount, paymentMethod, tiers } = this.data;

    if (!customerInfo) {
      this.setData({ ctaText: '请先选择顾客', ctaDisabled: true });
      return;
    }

    let faceValue = 0;
    let payAmount = 0;
    if (customMode) {
      const amt = Number(customInput);
      if (!amt || customPayAmount <= 0) {
        this.setData({ ctaText: '请输入有效充值金额', ctaDisabled: true });
        return;
      }
      faceValue = amt;
      payAmount = customPayAmount;
    } else if (selectedSkuId) {
      const tier = tiers.find(t => t.skuId === selectedSkuId);
      if (!tier) {
        this.setData({ ctaText: '请选择档位', ctaDisabled: true });
        return;
      }
      faceValue = tier.faceValue;
      payAmount = tier.payAmount;
    } else {
      this.setData({ ctaText: '请选择充值档位', ctaDisabled: true });
      return;
    }

    const methodLabel = paymentMethod === '微信' ? '生成支付二维码' : '确认充值';
    this.setData({
      ctaText: `${methodLabel} · 面值 ¥${formatAmount(faceValue)} · 实付 ¥${formatAmount(payAmount)}`,
      ctaDisabled: false,
    });
  },

  // ============ 提交 ============

  async onSubmit() {
    if (this.data.submitting || this.data.ctaDisabled) return;
    const { customerInfo, selectedSkuId, customMode, customInput, paymentMethod } = this.data;
    if (!customerInfo?.id) {
      wx.showToast({ title: '请选择顾客', icon: 'none' });
      return;
    }

    const payload: Record<string, unknown> = {
      clientUserId: customerInfo.id,
      paymentMethod,
    };
    if (customMode) {
      const amt = Number(customInput);
      if (!amt || amt <= 0) {
        wx.showToast({ title: '请输入充值金额', icon: 'none' });
        return;
      }
      payload.customAmount = amt;
    } else {
      if (!selectedSkuId) {
        wx.showToast({ title: '请选择档位', icon: 'none' });
        return;
      }
      payload.skuId = selectedSkuId;
    }

    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<RechargeResponse>('card.recharge', payload);
      if (!res?.saleOrderId) throw new Error('创建充值订单失败');
      wx.showToast({ title: '开单成功', icon: 'success', duration: 800 });
      setTimeout(() => {
        // 统一跳 order-qrcode（与 order.create 后续流程一致）
        // - 微信：展示小程序码供顾客扫码支付
        // - 线下：展示确认收款按钮
        wx.redirectTo({
          url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}`,
        });
      }, 600);
    } catch (err: any) {
      const msg = (err?.message || '').replace(/^[A-Z_]+:\s*/, '');
      if (err?.data?.pendingOrderNo) {
        wx.showModal({
          title: '顾客已有待支付订单',
          content: '请先完成或关闭原订单后再充值',
          confirmText: '去查看',
          cancelText: '我知道了',
          confirmColor: '#C0322A',
          success: (r) => {
            if (r.confirm) {
              wx.redirectTo({
                url: `/packageOrder/order-detail/order-detail?id=${err.data.pendingOrderNo}`,
              });
            }
          },
        });
      } else {
        wx.showToast({ title: msg || '充值开单失败', icon: 'none' });
      }
      this.setData({ submitting: false });
    }
  },
});
