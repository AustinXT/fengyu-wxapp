// packageOrder/card-recharge/card-recharge.ts — 店长替顾客充值
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

const app = getApp<IAppOption>();

/** 档位（来自 card.rechargeConfig，剥离 SKU 化后唯一标识改为 faceValue） */
interface Tier {
  faceValue: number;
  payAmount: number;
  discount: number;
}

interface TierVM extends Tier {
  bonus: number;
  discountLabel: string;
  payAmountLabel: string;
  bonusLabel: string;
}

/** 与 client/admin 同 shape：{ tiers, minAmount, maxAmount } */
interface RechargeConfig {
  tiers: Tier[];
  minAmount: number;
  maxAmount: number;
}

interface CustomerInfo {
  id: string | null;
  clientUserId: string;
  customerNo?: string | null;
  name: string;
  phone: string;
  phoneMasked?: string;
}

interface RechargeResponse {
  saleOrderId: string;
  saleItemId: string;
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

/**
 * 前端本地 tier 匹配（与三端后端 matchTier 字节同义）
 *
 * 精确命中 → 取 tier.payAmount；非命中 → 找最大 faceValue ≤ amount 的档位，按 payAmount/faceValue 比例算
 */
function matchTierLocal(amount: number, cfg: RechargeConfig): { discount: number; payAmount: number } | { error: string } {
  if (!Number.isFinite(amount)) return { error: '金额格式错误' };
  // 浮点容差：39.8 * 100 在 JS 里不是精确的 3980，严格 !== 会误判
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) return { error: '最多保留 2 位小数' };
  if (amount < cfg.minAmount) return { error: `最低 ¥${cfg.minAmount}` };
  if (amount > cfg.maxAmount) return { error: `上限 ¥${cfg.maxAmount}` };
  const hit = cfg.tiers.find(t => t.faceValue === amount);
  if (hit) {
    const discount = amount > 0 ? Math.round((hit.payAmount / amount) * 100) / 100 : 1;
    return { discount, payAmount: hit.payAmount };
  }
  let baseTier = cfg.tiers[0];
  for (const t of cfg.tiers) {
    if (amount >= t.faceValue) baseTier = t;
  }
  const ratio = baseTier.payAmount / baseTier.faceValue;
  const payAmount = Math.round(amount * ratio * 100) / 100;
  const discount = Math.round(ratio * 100) / 100;
  return { discount, payAmount };
}

Page({
  data: {
    configLoading: true,
    configLoadFailed: false,
    boundStoreName: '',
    boundStoreId: '',
    isManager: false, // 是否店长 — 仅店长可真正提交充值，非店长可浏览面值/折扣表

    // 顾客
    customerPhone: '',
    customerSearching: false,
    customerInfo: null as CustomerInfo | null,

    // 档位 + 自定义
    tiers: [] as TierVM[],
    minAmount: 500,
    maxAmount: 100000,

    selectedFaceValue: 0,    // 选中的档位面值（faceValue，剥离 SKU 化后唯一标识）
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

  _config: null as RechargeConfig | null,

  onLoad(query: Record<string, string>) {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreId: storeId, boundStoreName: storeName, isManager: isManager() });

    // 可选：从 URL 参数预填顾客
    if (query?.clientUserId && query?.customerName) {
      this.setData({
        customerInfo: {
          id: null,
          clientUserId: query.clientUserId,
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
      this.setData({ configLoading: true, configLoadFailed: false });
      const data = await callStaffApi<RechargeConfig>('card.rechargeConfig', {});
      if (!data || !Array.isArray(data.tiers) || !Number.isFinite(data.minAmount) || !Number.isFinite(data.maxAmount)) {
        throw new Error('档位配置返回为空');
      }
      this._config = data;
      const tiers: TierVM[] = data.tiers.map(t => ({
        ...t,
        bonus: Math.round((t.faceValue - t.payAmount) * 100) / 100,
        discountLabel: formatDiscountLabel(t.discount),
        payAmountLabel: formatAmount(t.payAmount),
        bonusLabel: formatAmount(Math.round((t.faceValue - t.payAmount) * 100) / 100),
      }));
      this.setData({
        tiers,
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        configLoading: false,
      });
      this.updateCta();
    } catch (err: any) {
      const msg = (err?.message || '加载档位失败').replace(/^[A-Z_]+:\s*/, '');
      this._config = null;
      this.setData({ configLoading: false, configLoadFailed: true });
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
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
      if (found && found.clientUserId) {
        this.setData({ customerInfo: found });
        this.updateCta();
      } else {
        wx.showModal({
          title: '顾客未绑定门店',
          content: '该手机号尚未绑定本系统门店，请先引导顾客本人登录小程序并绑定门店后再充值。',
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
    const faceValueRaw = e.currentTarget.dataset.faceValue;
    const faceValue = Number(faceValueRaw);
    if (!faceValue || !Number.isFinite(faceValue)) return;
    const tier = this.data.tiers.find(t => t.faceValue === faceValue);
    if (!tier) return;

    this.setData({
      selectedFaceValue: faceValue,
      customMode: false,
      customInput: '',
      customError: '',
      customPayAmount: 0,
    });
    this.updateCta();
  },

  // ============ 自定义金额 ============

  onCustomFocus() {
    this.setData({ customMode: true, selectedFaceValue: 0 });
  },

  onCustomInput(e: WechatMiniprogram.CustomEvent) {
    const raw = ((e.detail as { value?: string })?.value || '').trim();
    this.setData({ customInput: raw, customMode: true, selectedFaceValue: 0 });

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
    const config = this._config;
    if (!config) {
      // 配置未加载（loadConfig 失败）：显式 surface 错误，避免静默卡死在"请输入有效金额"
      this.setData({
        customError: '档位配置加载失败，请下拉刷新或重新进入页面',
        customPayAmount: 0,
        customDiscountLabel: '',
        customPayAmountLabel: '',
        customBonus: 0,
        customBonusLabel: '',
      });
      this.updateCta();
      return;
    }
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
    const { customerInfo, selectedFaceValue, customMode, customInput, customPayAmount, paymentMethod, tiers } = this.data;

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
    } else if (selectedFaceValue) {
      const tier = tiers.find(t => t.faceValue === selectedFaceValue);
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
    // 统一店长权限网关：非店长可浏览面值/折扣表，但不能提交充值
    if (!this.data.isManager) {
      wx.showToast({ title: '您无开单权限，请联系店长', icon: 'none', duration: 2500 });
      return;
    }
    const { customerInfo, selectedFaceValue, customMode, customInput, paymentMethod } = this.data;
    if (!customerInfo?.clientUserId) {
      wx.showToast({ title: '请选择顾客', icon: 'none' });
      return;
    }

    const faceValue = customMode ? Number(customInput) : selectedFaceValue;
    if (!faceValue || faceValue <= 0) {
      wx.showToast({ title: customMode ? '请输入充值金额' : '请选择档位', icon: 'none' });
      return;
    }

    const payload: Record<string, unknown> = {
      clientUserId: customerInfo.clientUserId,
      faceValue,
      paymentMethod,
    };

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
