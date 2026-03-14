// pagesCoupon/my-coupons/my-coupons.ts
import Toast from '@vant/weapp/toast/toast';
import { formatDate, formatDiscount } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

const TAB_STATUS = ['未使用', '已使用', '已过期'];

Page({
  data: {
    activeTab: 0,
    coupons: [] as any[],
    isLoading: false,
    redeemCode: '',
    redeeming: false,
  },

  onLoad() {
    this.loadCoupons();
  },

  onShow() {
    // navigateBack 返回时刷新券状态（使用后状态可能变化）
    if (this.data.coupons.length > 0) {
      this.loadCoupons();
    }
  },

  onPullDownRefresh() {
    this.loadCoupons().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ activeTab: e.detail.index });
    this.loadCoupons();
  },

  async loadCoupons() {
    this.setData({ isLoading: true });
    try {
      const status = TAB_STATUS[this.data.activeTab];
      const data = await callClientApi('coupon.list', { status });
      const coupons = (data?.coupons || []).map((c: any) => ({
        ...c,
        expireAtFmt: formatDate(c.expireAt),
        discountLabel: formatDiscount(c),
      }));
      this.setData({ coupons });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onRedeemInput(e: WechatMiniprogram.Input) {
    this.setData({ redeemCode: e.detail.value.trim() });
  },

  async onRedeem() {
    const code = this.data.redeemCode.trim();
    if (!code) {
      Toast('请输入兑换码');
      return;
    }
    if (this.data.redeeming) return;
    this.setData({ redeeming: true });

    try {
      await callClientApi('coupon.redeem', { code });
      Toast.success('兑换成功');
      this.setData({ redeemCode: '', activeTab: 0 });
      this.loadCoupons();
    } catch (err: any) {
      Toast.fail(err.message || '兑换失败');
    } finally {
      this.setData({ redeeming: false });
    }
  },
});
