
import Toast from '@vant/weapp/toast/toast';
import { formatDate, formatDiscount } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

const TAB_STATUS = ['未使用', '已使用', '已过期'];

Page({
  data: {
    activeTab: 0,
    coupons: [] as any[],
    isLoading: false,
    loadError: false,
  },

  onLoad() {
    this.loadCoupons();
  },

  onShow() {
    
    if (this.data.coupons.length > 0) {
      this.loadCoupons();
    }
  },

  onPullDownRefresh() {
    this.loadCoupons().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ activeTab: e.detail.index, coupons: [] });
    this.loadCoupons();
  },

  async loadCoupons() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const status = TAB_STATUS[this.data.activeTab];
      const data = await callClientApi('coupon.list', { status });
      const coupons = (data?.coupons || []).map((c: any) => {
        const minSpendNum = Number(c.minSpend) || 0;
        const hasCategory = Array.isArray(c.applicableCategoryNames) && c.applicableCategoryNames.length > 0;
        
        const minSpendHint = minSpendNum > 0
          ? (hasCategory
              ? `仅限 ${c.applicableCategoryNames.join('/')} 品类小计满 ${minSpendNum} 元可用`
              : `满 ${minSpendNum} 元可用`)
          : '';
        return {
          ...c,
          expireAtFmt: formatDate(c.expireAt),
          
          
          usedAtFmt: c.usedAt ? formatDate(c.usedAt) : '',
          discountLabel: formatDiscount(c),
          minSpendNum,
          minSpendHint,
        };
      });
      this.setData({ coupons });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

});
