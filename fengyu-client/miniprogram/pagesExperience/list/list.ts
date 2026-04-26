// pagesExperience/list/list.ts — 体验卡列表
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';

interface ExperienceCardSku {
  sku_id: string;
  product_id?: string;
  product_name?: string;
  spec_name: string;
  cover_image?: string;
  price: number;
  special_price: number | null;
  session_count: number | null;
  sort_order?: number;
}

Page({
  data: {
    skuList: [] as ExperienceCardSku[],
    isLoading: true,
    loadError: false,
  },

  onLoad() {
    this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  async loadList() {
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi<{ skuList: ExperienceCardSku[] }>(
        'product.experienceCardList',
        {}
      );
      const list = (data?.skuList || []).map((s: any) => ({
        sku_id: s.sku_id,
        product_id: s.product_id,
        product_name: s.product_name || '',
        spec_name: s.spec_name || '',
        cover_image: s.cover_image || '',
        price: Number(s.price || 0),
        special_price: s.special_price !== null && s.special_price !== undefined
          ? Number(s.special_price) : null,
        session_count: s.session_count !== null && s.session_count !== undefined
          ? Number(s.session_count) : null,
        sort_order: s.sort_order,
      }));
      this.setData({ skuList: list });
    } catch (err: any) {
      console.error('loadList error:', err);
      Toast.fail(err?.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    if (!skuId) return;
    wx.navigateTo({ url: `/pagesExperience/detail/detail?skuId=${encodeURIComponent(skuId)}` });
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: '凤御体验卡 · 新人专享',
      path: `/pages/home/home${invSuffix}`,
    };
  },
});
