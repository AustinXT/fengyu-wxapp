// pagesCoupon/my-coupons/my-coupons.ts
import Toast from '@vant/weapp/toast/toast';

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

const TAB_STATUS = ['未使用', '已使用', '已过期'];

Page({
  data: {
    activeTab: 0,
    coupons: [] as any[],
    isLoading: false,
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
});

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDiscount(coupon: any): string {
  if (coupon.couponType === '折扣券') {
    return `${Math.round(Number(coupon.discountValue) * 10)}折`;
  }
  return `¥${Number(coupon.discountValue).toFixed(0)}`;
}
