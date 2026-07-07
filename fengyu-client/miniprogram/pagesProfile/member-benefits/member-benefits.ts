

import Toast from '@vant/weapp/toast/toast';
import { formatDate, formatDiscount } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface ShareGiftRule {
  enabled: boolean;
  percent?: number;
  minFaceValue?: number;
  maxFaceValue?: number;
  validityDays?: number;
}

Page({
  data: {
    rule: { enabled: false } as ShareGiftRule,
    percentLabel: '',
    coupons: [] as any[],
    isLoading: true,
    loadError: false,
    loggedIn: false,
  },

  onLoad() {
    this.setData({ loggedIn: !!app.globalData.userId });
    this.loadAll();
  },

  onShow() {
    
    if (!this.data.isLoading) {
      this.loadAll();
    }
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const rule = await callClientApi<ShareGiftRule>('config.shareGift', {});
      const percentLabel = rule.enabled && rule.percent
        ? `${Math.round(Number(rule.percent) * 100)}%`
        : '';
      this.setData({ rule, percentLabel });

      
      let coupons: any[] = [];
      if (app.globalData.userId) {
        const data = await callClientApi<{ coupons: any[] }>('coupon.list', {});
        coupons = (data?.coupons || [])
          
          .filter((c) => typeof c.couponId === 'string' && c.couponId.indexOf('sg-') === 0)
          .map((c) => ({
            ...c,
            discountLabel: formatDiscount(c),
            expireAtFmt: formatDate(c.expireAt),
            usedAtFmt: c.usedAt ? formatDate(c.usedAt) : '',
          }));
      }
      this.setData({ coupons });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onShareAppMessage() {
    
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: '凤御美容 — 邀请有礼，首单到账各得好礼',
      path: `/pages/home/home${invSuffix}`,
    };
  },
});
