// pagesCoupon/my-coupons/my-coupons.ts
import Toast from '@vant/weapp/toast/toast';

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

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
      if (err.message?.includes('未知的 action')) {
        Toast('兑换功能开发中');
      } else {
        Toast.fail(err.message || '兑换失败');
      }
    } finally {
      this.setData({ redeeming: false });
    }
  },
});

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).replace(/-/g, '/'));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDiscount(coupon: any): string {
  if (coupon.couponType === '折扣券') {
    return `${Math.round(Number(coupon.discountValue) * 10)}折`;
  }
  return `¥${Number(coupon.discountValue).toFixed(0)}`;
}
