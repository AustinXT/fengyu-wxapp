// pagesExperience/list/list.ts — 体验卡列表
import { createCoverWindow, withInitialCoverVisible, type CoverWindow } from '../../utils/cover-window';
import { buildAppendPatch, SPU_PAGE_SIZE } from '../../utils/spu-list';
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
  unit: string;
  sort_order?: number;
}

Page({
  data: {
    skuList: [] as ExperienceCardSku[],
    isLoading: true,
    loadError: false,
    loadingMore: false,
    hasMore: true,
  },

  _cursor: null as string | null,
  _epoch: 0,
  _coverWindow: null as CoverWindow | null,
  _visible: true,

  onLoad() {
    this._coverWindow = createCoverWindow(this, { scrollSelector: '', slotSelector: '.experience-cover-slot', listKey: 'skuList' });
  },
  onShow() { this._visible = true; this._coverWindow?.setVisible(true); this.loadList(); },
  onHide() { this._visible = false; this._coverWindow?.setVisible(false); },
  onUnload() { this._epoch++; this._coverWindow?.dispose(); },
  onReachBottom() { if (this.data.hasMore && !this.data.isLoading && !this.data.loadingMore) this.loadList(true); },
  _refreshCovers() {
    this._coverWindow?.setVisible(this._visible && !this.data.loadError && this.data.skuList.length > 0);
    this._coverWindow?.refresh();
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  async loadList(append = false) {
    if (append && (this.data.isLoading || this.data.loadingMore || !this.data.hasMore)) return;
    const epoch = append ? this._epoch : ++this._epoch;
    if (!append) {
      this._coverWindow?.invalidate();
      this._coverWindow?.setVisible(false);
    }
    this.setData(append ? { loadingMore: true } : { isLoading: true, loadingMore: false, loadError: false });
    try {
      const data = await callClientApi<{ skuList: ExperienceCardSku[]; hasMore?: boolean; nextCursor?: string | null }>(
        'product.experienceCardList',
        { limit: SPU_PAGE_SIZE, cursor: append ? this._cursor : null }
      );
      if (epoch !== this._epoch) return;
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
          unit: s.unit || '次',
          sort_order: s.sort_order,
        };
      });
      const seen = new Set(append ? this.data.skuList.map(row => row.sku_id) : []);
      const unique = list.filter(row => { if (seen.has(row.sku_id)) return false; seen.add(row.sku_id); return true; });
      const from = append ? this.data.skuList.length : 0;
      const next = withInitialCoverVisible(unique, from);
      this._cursor = data.nextCursor || null;
      this._coverWindow?.invalidate();
      this.setData({
        ...(append ? buildAppendPatch('skuList', from, [...this.data.skuList, ...next]) : { skuList: next }),
        hasMore: Boolean(data.hasMore && this._cursor),
        isLoading: false, loadingMore: false,
      }, () => { if (epoch === this._epoch) this._refreshCovers(); });
    } catch (err: any) {
      if (epoch !== this._epoch) return;
      console.error('loadList error:', err);
      Toast.fail(err?.message || '加载失败');
      this.setData({ loadError: !append && this.data.skuList.length === 0 });
    } finally {
      if (epoch === this._epoch) this.setData({ isLoading: false, loadingMore: false }, () => this._refreshCovers());
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
