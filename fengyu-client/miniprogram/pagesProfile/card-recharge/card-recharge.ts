// pagesProfile/card-recharge/card-recharge.ts
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { matchTier, formatAmount } from './recharge';

const app = getApp<IAppOption>();

interface TierVM {
  faceValue: number;
  discount: number;
  payAmount: number;
  discountLabel: string;
  payAmountLabel: string;
  bonusLabel: string;
}

interface RechargeConfig {
  tiers: { faceValue: number; discount: number; payAmount: number }[];
  minAmount: number;
  maxAmount: number;
}

/** 折扣 0.99 → "9.9 折" */
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

    selectedTier: 0,        // 选中的预设档面值；0 = 未选
    customMode: false,      // 是否处于"自定义金额"模式
    customInput: '',
    customPayAmount: 0,
    customDiscountLabel: '',
    customPayAmountLabel: '',
    customBonus: 0,
    customBonusLabel: '',
    customError: '',

    // CTA
    ctaText: '请选择充值金额',
    ctaDisabled: true,

    // 提交态
    submitting: false,

    // 手机绑定
    showPhoneBind: false,
    pendingFaceValue: 0,    // 手机绑定流程后自动重提交
  },

  onLoad() {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreId: storeId, boundStoreName: storeName });
    this.loadConfig();
  },

  onShow() {
    // 用户可能从门店选择页返回，更新一次
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
      const tiers: TierVM[] = (data?.tiers || []).map(t => ({
        faceValue: t.faceValue,
        discount: t.discount,
        payAmount: t.payAmount,
        discountLabel: formatDiscountLabel(t.discount),
        payAmountLabel: formatAmount(t.payAmount),
        bonusLabel: formatAmount(t.faceValue - t.payAmount),
      }));
      this.setData({
        tiers,
        minAmount: data?.minAmount || 500,
        maxAmount: data?.maxAmount || 100000,
        configLoading: false,
      });
    } catch (err: any) {
      this.setData({ configLoading: false });
      Toast.fail(err?.message || '加载档位失败');
    }
  },

  // ============ 选择档位 ============

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
      ctaText: `立即充值 ¥${tier.payAmountLabel}`,
      ctaDisabled: false,
    });
  },

  // ============ 自定义金额 ============

  onCustomFocus() {
    this.setData({ customMode: true, selectedTier: 0 });
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
        ctaText: '请输入充值金额',
        ctaDisabled: true,
      });
      return;
    }

    const amount = Number(raw);
    try {
      const { discount, payAmount } = matchTier(amount);
      const bonus = Math.round((amount - payAmount) * 100) / 100;
      this.setData({
        customError: '',
        customPayAmount: payAmount,
        customDiscountLabel: formatDiscountLabel(discount),
        customPayAmountLabel: formatAmount(payAmount),
        customBonus: bonus,
        customBonusLabel: formatAmount(bonus),
        ctaText: `立即充值 ¥${formatAmount(payAmount)}`,
        ctaDisabled: false,
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
        ctaText: '请输入有效金额',
        ctaDisabled: true,
      });
    }
  },

  // ============ 提交充值 ============

  async onRecharge() {
    if (this.data.submitting || this.data.ctaDisabled) return;

    // 算出待充值的面值
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

    // 前置：未绑定门店直接拦截（云函数也会校验，前端先拦免一次往返）
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

    this.data.pendingFaceValue = faceValue;
    await this.doRecharge(faceValue);
  },

  async doRecharge(faceValue: number) {
    this.setData({ submitting: true });
    try {
      const data = await callClientApi<{
        saleOrderId: string;
        payAmount: number;
        paymentParams: WechatMiniprogram.RequestPaymentOption;
      }>('card.recharge', { faceValue });

      const saleOrderId = data?.saleOrderId;
      const paymentParams = data?.paymentParams;
      if (!saleOrderId || !paymentParams) {
        throw new Error('创建充值订单失败');
      }

      try {
        await wx.requestPayment(paymentParams);
      } catch (payErr: any) {
        if ((payErr?.errMsg || '').toLowerCase().includes('cancel')) {
          // 用户主动取消支付，不报错（订单仍处待支付，后续可在订单页重新支付）
          this.setData({ submitting: false });
          return;
        }
        throw payErr;
      }

      Toast.success('充值成功');
      // 跳回充值卡列表查看新余额
      setTimeout(() => {
        wx.redirectTo({ url: '/pagesProfile/prepaid-cards/prepaid-cards' });
      }, 1200);
    } catch (err: any) {
      if (err?.errorType === 'PHONE_REQUIRED') {
        this.setData({ showPhoneBind: true, submitting: false });
        return;
      }
      if (err?.data?.pendingOrderNo) {
        Dialog.confirm({
          title: '您有待支付订单',
          message: '请先完成或取消上一笔订单后再充值',
          confirmButtonText: '去查看',
          cancelButtonText: '我知道了',
        }).then(() => {
          wx.navigateTo({
            url: `/pagesOrder/order-detail/order-detail?saleOrderId=${err.data.pendingOrderNo}`,
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

  // ============ 手机绑定 ============

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
      const pending = this.data.pendingFaceValue;
      if (pending > 0) {
        setTimeout(() => this.doRecharge(pending), 800);
      }
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败，请重试');
    }
  },
});
