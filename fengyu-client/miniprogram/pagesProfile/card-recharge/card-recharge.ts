
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { matchTier, formatAmount, RechargeConfig } from './recharge';

const app = getApp<IAppOption>();

interface TierVM {
  faceValue: number;
  discount: number;
  payAmount: number;
  discountLabel: string;
  payAmountLabel: string;
  bonusLabel: string;
}


function formatDiscountLabel(d: number): string {
  return (d * 10).toFixed(1).replace(/\.0$/, '') + ' 折';
}

Page({
  data: {
    configLoading: true,
    boundStoreName: '',
    boundStoreId: '',

    tiers: [] as TierVM[],
    minAmount: 500,
    maxAmount: 100000,

    selectedTier: 0,        
    customMode: false,      
    customInput: '',
    customPayAmount: 0,
    customDiscountLabel: '',
    customPayAmountLabel: '',
    customBonus: 0,
    customBonusLabel: '',
    customError: '',

    
    ctaText: '请选择充值金额',
    ctaDisabled: true,

    
    submitting: false,

    
    showPhoneBind: false,
  },

  _config: null as RechargeConfig | null,
  _pendingFaceValue: 0,    

  onLoad() {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreId: storeId, boundStoreName: storeName });
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
      const data = await callClientApi<RechargeConfig>('card.rechargeConfig', {});
      if (!data || !Array.isArray(data.tiers) || !Number.isFinite(data.minAmount) || !Number.isFinite(data.maxAmount)) {
        throw new Error('档位配置返回为空');
      }
      this._config = data;
      const tiers: TierVM[] = data.tiers.map(t => ({
        faceValue: t.faceValue,
        discount: t.discount,
        payAmount: t.payAmount,
        discountLabel: formatDiscountLabel(t.discount),
        payAmountLabel: formatAmount(t.payAmount),
        bonusLabel: formatAmount(t.faceValue - t.payAmount),
      }));
      this.setData({
        tiers,
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        configLoading: false,
      });
    } catch (err: any) {
      this._config = null;
      this.setData({ configLoading: false });
      Toast.fail((err?.message || '加载档位失败').replace(/^[A-Z_]+:\s*/, ''));
    }
  },

  

  onTierTap(e: WechatMiniprogram.TouchEvent) {
    const faceValue = Number(e.currentTarget.dataset.faceValue);
    if (!faceValue) return;
    const tier = this.data.tiers.find(t => t.faceValue === faceValue);
    if (!tier) return;

    this.setData({
      selectedTier: faceValue,
      customMode: false,
      customInput: '',
      customError: '',
      customPayAmount: 0,
    });
    this.updateCta();
  },

  

  onCustomFocus() {
    this.setData({ customMode: true, selectedTier: 0 });
    this.updateCta();
  },

  onCustomInput(e: WechatMiniprogram.InputEvent) {
    const raw = (e.detail.value || '').trim();
    this.setData({ customInput: raw, customMode: true, selectedTier: 0 });

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
    const cfg = this._config;
    if (!cfg) {
      this.setData({
        customError: '档位配置加载失败，请下拉刷新',
        customPayAmount: 0,
        customDiscountLabel: '',
        customPayAmountLabel: '',
        customBonus: 0,
        customBonusLabel: '',
      });
      this.updateCta();
      return;
    }
    try {
      const { discount, payAmount } = matchTier(amount, cfg);
      const bonus = Math.round((amount - payAmount) * 100) / 100;
      this.setData({
        customError: '',
        customPayAmount: payAmount,
        customDiscountLabel: formatDiscountLabel(discount),
        customPayAmountLabel: formatAmount(payAmount),
        customBonus: bonus,
        customBonusLabel: formatAmount(bonus),
      });
    } catch (err: any) {
      const msg = (err?.message || '').replace(/^INVALID_PARAMS:\s*/, '') || '金额不合法';
      this.setData({
        customError: msg,
        customPayAmount: 0,
        customDiscountLabel: '',
        customPayAmountLabel: '',
        customBonus: 0,
        customBonusLabel: '',
      });
    }
    this.updateCta();
  },

  
  updateCta() {
    const { customMode, customInput, customPayAmount, customError, selectedTier, tiers } = this.data;

    let payAmount = 0;
    if (customMode) {
      if (!customInput) {
        this.setData({ ctaText: '请输入充值金额', ctaDisabled: true });
        return;
      }
      if (customError || customPayAmount <= 0) {
        this.setData({ ctaText: '请输入有效金额', ctaDisabled: true });
        return;
      }
      payAmount = customPayAmount;
    } else if (selectedTier) {
      const tier = tiers.find(t => t.faceValue === selectedTier);
      if (!tier) {
        this.setData({ ctaText: '请选择充值金额', ctaDisabled: true });
        return;
      }
      payAmount = tier.payAmount;
    } else {
      this.setData({ ctaText: '请选择充值金额', ctaDisabled: true });
      return;
    }

    this.setData({ ctaText: `立即充值 ¥${formatAmount(payAmount)}`, ctaDisabled: false });
  },

  

  async onRecharge() {
    if (this.data.submitting || this.data.ctaDisabled) return;

    
    let faceValue: number;
    if (this.data.customMode) {
      faceValue = Number(this.data.customInput);
    } else {
      faceValue = this.data.selectedTier;
    }

    if (!faceValue || faceValue <= 0) {
      Toast.fail('请选择或输入充值金额');
      return;
    }

    
    if (!this.data.boundStoreId) {
      Toast('请先绑定门店');
      Dialog.confirm({
        title: '请先绑定门店',
        message: '充值卡需绑定门店，便于后续到店核销',
        confirmButtonText: '去绑定',
        cancelButtonText: '取消',
      }).then(() => {
        wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
      }).catch(() => {});
      return;
    }

    
    this._pendingFaceValue = faceValue;
    await this.doRecharge(faceValue);
  },

  async doRecharge(faceValue: number) {
    this.setData({ submitting: true });
    try {
      
      const created = await callClientApi<{ saleOrderId: string }>('card.recharge', { faceValue });
      const saleOrderId = created?.saleOrderId;
      if (!saleOrderId) throw new Error('创建充值订单失败');

      wx.redirectTo({
        url: `/pagesOrder/checkout/checkout?saleOrderId=${saleOrderId}`,
      });
    } catch (err: any) {
      if (err?.errorType === 'PHONE_REQUIRED') {
        this.setData({ showPhoneBind: true, submitting: false });
        return;
      }
      if (err?.data?.pendingOrderNo) {
        Dialog.confirm({
          title: '您有待支付订单',
          message: '请先完成或取消上一笔订单后再充值',
          confirmButtonText: '去支付',
          cancelButtonText: '我知道了',
        }).then(() => {
          wx.redirectTo({
            url: `/pagesOrder/checkout/checkout?saleOrderId=${err.data.pendingOrderNo}`,
          });
        }).catch(() => {});
        this.setData({ submitting: false });
        return;
      }
      const rawMsg = (err?.message || '').replace(/^[A-Z_]+:\s*/, '');
      Toast.fail(rawMsg || '充值失败，请重试');
      this.setData({ submitting: false });
    }
  },

  

  onClosePhoneBind() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent<{ cloudID?: string; errMsg?: string }>) {
    const { cloudID, errMsg } = e.detail;
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) Toast.fail('您拒绝了授权');
      return;
    }
    try {
      await bindPhoneWithCloudID(cloudID);
      this.setData({ showPhoneBind: false });
      Toast.success('绑定成功');
      const pending = this._pendingFaceValue;
      if (pending > 0) {
        setTimeout(() => this.doRecharge(pending), 800);
      }
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败，请重试');
    }
  },
});
