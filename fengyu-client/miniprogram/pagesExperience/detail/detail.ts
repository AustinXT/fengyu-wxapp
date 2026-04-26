// pagesExperience/detail/detail.ts — 体验卡详情
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface ExperienceSku {
  sku_id: string;
  product_id?: string;
  product_name?: string;
  spec_name: string;
  cover_image?: string;
  description?: string;
  price: number;
  special_price: number | null;
  session_count: number | null;
}

Page({
  data: {
    sku: {} as ExperienceSku,
    isLoading: true,
    loadError: false,
    boundStoreName: '',
  },

  _skuId: '',

  onLoad(options) {
    const { skuId } = options as { skuId?: string };
    if (!skuId) {
      Toast.fail('缺少 skuId 参数');
      setTimeout(() => wx.navigateBack(), 1000);
      return;
    }
    this._skuId = skuId;
    this.setData({ boundStoreName: app.globalData.boundStoreName || '' });
    this.loadDetail(skuId);
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreName: storeName });
    }
  },

  onPullDownRefresh() {
    if (this._skuId) {
      this.loadDetail(this._skuId).finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  async loadDetail(skuId: string) {
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi<{ sku: any }>('product.skuDetail', { skuId });
      const raw = data?.sku;
      if (!raw) {
        throw new Error('体验卡不存在');
      }
      const sku: ExperienceSku = {
        sku_id: raw.sku_id,
        product_id: raw.product_id,
        product_name: raw.product_name || raw.name || '',
        spec_name: raw.spec_name || '',
        cover_image: raw.cover_image || '',
        description: raw.description || '',
        price: Number(raw.price || 0),
        special_price: raw.special_price !== null && raw.special_price !== undefined
          ? Number(raw.special_price) : null,
        session_count: raw.session_count !== null && raw.session_count !== undefined
          ? Number(raw.session_count) : null,
      };
      this.setData({ sku });
      wx.setNavigationBarTitle({ title: sku.product_name || sku.spec_name || '体验卡详情' });
    } catch (err: any) {
      console.error('loadDetail error:', err);
      Toast.fail(err?.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onBuyNow() {
    const sku = this.data.sku;
    if (!sku?.sku_id) {
      Toast.fail('体验卡数据未就绪');
      return;
    }
    // 严格独立 checkout：固定 1 张/单（C2 物理隔离 + 体验卡限购语义）
    const params = [
      `skuId=${encodeURIComponent(sku.sku_id)}`,
      `spuName=${encodeURIComponent(sku.product_name || sku.spec_name || '体验卡')}`,
    ].join('&');
    wx.navigateTo({ url: `/pagesExperience/checkout/checkout?${params}` });
  },

  onShareAppMessage() {
    const sku = this.data.sku;
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: sku?.product_name || sku?.spec_name || '凤御体验卡',
      path: `/pages/home/home${invSuffix}`,
    };
  },
});
