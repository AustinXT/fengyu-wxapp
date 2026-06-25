// pagesExperience/list/list.ts — 体验卡列表
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { getIsMember, priceView } from '../../utils/member-pricing';

interface ExperienceCardSku {
  sku_id: string;
  product_id?: string;
  product_name?: string;
  spec_name: string;
  cover_image?: string;
  price: number;
  special_price: number | null;
  /** 会员价分流后的展示主价（#6=B：会员=会员价，非会员=标价） */
  displayPrice: number;
  /** 划线原价（标价）；null=不划线 */
  strikePrice: number | null;
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
      // 体验卡按会员价分流（#6=B）：会员展示会员价 + 划线标价，非会员只看标价
      const member = getIsMember();
      const list = (data?.skuList || []).map((s: any) => {
        const price = Number(s.price || 0);
        const special_price = s.special_price !== null && s.special_price !== undefined
          ? Number(s.special_price) : null;
        const pv = priceView(member, special_price, price);
        return {
          sku_id: s.sku_id,
          product_id: s.product_id,
          product_name: s.product_name || '',
          spec_name: s.spec_name || '',
          cover_image: s.cover_image || '',
          price,
          special_price,
          displayPrice: pv.display,
          strikePrice: pv.strike,
          session_count: s.session_count !== null && s.session_count !== undefined
            ? Number(s.session_count) : null,
          sort_order: s.sort_order,
        };
      });
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
