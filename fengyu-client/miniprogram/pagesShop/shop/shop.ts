// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount, clearCart } from '../../utils/cart';
import { callClientApi } from '../../utils/cloud';
import { createCoverWindow, withInitialCoverVisible, type CoverWindow } from '../../utils/cover-window';
import { getIsMember, priceView } from '../../utils/member-pricing';

const app = getApp<IAppOption>();

/** issue #248：与云函数 PRODUCT_PAGE_SIZE_MAX(50) 同量级，实际由后端夹取 */
const PAGE_SIZE = 20;

interface Category { category_id: string; category_name: string; category_order: number; }

interface SpuItem {
  product_id: string;
  name: string;
  category_name: string;
  /** issue #230：云函数无法保证缩略时下发 null，wxml 走 cover-placeholder 分支 */
  cover_image: string | null;
  /** issue #248：视口窗口内才挂 <image>，滚远的卡片渲染成占位 */
  coverVisible?: boolean;
  min_price: string;
  /** 会员价分流：仅会员且标价起价 > 会员起价时填标价起价（划线），否则空串 */
  strike_min_price?: string;
  /** 组合套餐标记：列表展示套餐总价，不带「起」字（普通单品多 SKU 起价才显示） */
  is_bundle?: boolean;
  is_recommend: boolean;
  skuList?: any[];
}

/** 某个分类的翻页进度 */
interface PageState { cursor: string | null; hasMore: boolean; }

Page({
  data: {
    boundStoreName: '',
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
    hasMore: false,
    cartCount: 0,
  },

  // 所有分类
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按 categoryId 缓存（累积已翻过的页）
  _spuCache: {} as Record<string, SpuItem[]>,

  // 每个分类的翻页进度，与 _spuCache 同生命周期
  _pageState: {} as Record<string, PageState>,

  // 当前正在展示的分类 id（shopInit 下发的是权威值，不等于 categories[0]）
  _activeCategoryId: '',

  // 防止 scrolltolower 连续触发
  _isLoadingNext: false,

  _coverWindow: null as CoverWindow | null,

  onLoad() {
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
    this._coverWindow = createCoverWindow(this as any, {
      scrollSelector: '.product-scroll',
      slotSelector: '.spu-cover-slot',
      listKey: 'spuList',
    });
    this.loadShopInit();
    this.updateCartCount();
  },

  onUnload() {
    this._coverWindow?.dispose();
    this._coverWindow = null;
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      clearCart();
      this._spuCache = {};
      this._pageState = {};
      this._allCategories = [];
      this._activeCategoryId = '';
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [], hasMore: false, cartCount: 0 });
      this.loadShopInit();
    } else {
      this.updateCartCount();
    }
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  // 点击"加入购物车"按钮
  async onAddToCart(e: WechatMiniprogram.TouchEvent) {
    (e as any).stopPropagation();
    const { productId } = e.currentTarget.dataset as { productId: string };
    const spu = this.data.spuList.find(s => s.product_id === productId);
    if (!spu) return;

    const skuList = spu.skuList || [];
    if (skuList.length === 0) {
      Toast.fail('暂无可购规格');
      return;
    }

    const sku = skuList[0];

    // 会员价分流：套餐组件价（bundle_price）固定不分流；普通 SKU 会员→会员价、非会员→标价。
    // 与后端 order.create 权威定价同口径，避免购物车/结算预览与实收不一致。
    const hasBundlePrice = Number(sku.bundle_price) > 0;
    const pv = priceView(getIsMember(), sku.special_price, sku.price);
    const dealPrice = hasBundlePrice ? Number(sku.bundle_price) : pv.display;
    const listPrice = hasBundlePrice ? Number(sku.bundle_price) : (pv.strike ?? pv.display);

    addToCart({
      skuId: sku.sku_id,
      spuId: spu.product_id,
      spuName: spu.name,
      skuDisplayName: sku.spec_name,
      // 购物车是 localStorage 快照，用空串表示无封面（CartItem.coverImage 非空）
      coverImage: spu.cover_image || '',
      price: dealPrice,
      listPrice,
      bigCategory: spu.category_name,
      productType: sku.product_type,
      // PR-D：DB 驱动 tag 渲染（来自 product.shopInit / spuList JOIN product_categories）
      productKind: sku.product_kind || undefined,
      kindDisplayColor: sku.kind_display_color || undefined,
      // 充值卡剥离 SKU 化（2026-05-20）：商城 SKU 已不含充值卡
    });

    this.updateCartCount();
    Toast.success('已加入购物车');
  },

  onCartTap() {
    wx.navigateTo({ url: '/pagesShop/shopping-cart/shopping-cart' });
  },

  /** 会员价分流：会员看会员起价 + 划线标价起价；非会员只看标价起价 */
  _decorate(rows: any[], startIndex: number): SpuItem[] {
    const isMember = getIsMember();
    return withInitialCoverVisible(
      rows.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || '0') : (spu.listPriceFrom || spu.priceFrom || '0'),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : '',
      })),
      startIndex
    ) as SpuItem[];
  },

  /** 列表内容变了就得重建相交观察（observeAll 不跟踪新增节点） */
  _refreshCoverWindow() {
    wx.nextTick(() => this._coverWindow?.refresh());
  },

  async loadShopInit() {
    try {
      this.setData({ isLoading: true });
      const initData = await callClientApi<{
        categories: Category[]; spuList: any[];
        spuCategoryId?: string | null; nextCursor?: string | null; hasMore?: boolean;
      }>('product.shopInit', { limit: PAGE_SIZE });

      const categories: Category[] = initData?.categories || [];
      const listWithPrice = this._decorate(initData?.spuList || [], 0);

      this._allCategories = categories;

      // 这批商品归属哪个分类由后端下发（shopInit 取的是「第一个 group 下的首个二级分类」，
      // 不必然是 categories[0]）；游标必须挂在正确的分类上，否则「加载更多」会翻错分类
      const activeId = initData?.spuCategoryId || categories[0]?.category_id || '';
      this._activeCategoryId = activeId;
      if (activeId) {
        this._spuCache[activeId] = listWithPrice;
        this._pageState[activeId] = {
          cursor: initData?.nextCursor ?? null,
          hasMore: Boolean(initData?.hasMore),
        };
      }

      const activeIndex = Math.max(0, categories.findIndex(c => c.category_id === activeId));
      this.setData({
        categories,
        activeCategoryIndex: activeIndex,
        spuList: listWithPrice,
        hasMore: Boolean(initData?.hasMore),
      });
      this._refreshCoverWindow();
    } catch (err: any) {
      console.error('loadShopInit error:', err);
      Toast.fail(err?.message || '加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCategoryChange(e: WxEvent<number>) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const cat = categories[index];
    if (!cat) return;

    this._activeCategoryId = cat.category_id;
    const cached = this._spuCache[cat.category_id];
    if (cached) {
      // 切分类是整体替换而非追加，旧分类的图片节点随之释放
      this.setData({
        activeCategoryIndex: index,
        spuList: cached,
        hasMore: Boolean(this._pageState[cat.category_id]?.hasMore),
      });
      this._refreshCoverWindow();
      return;
    }

    this.setData({ activeCategoryIndex: index, spuList: [], hasMore: false });
    this.loadSpuList(cat.category_id);
  },

  /** 触底：加载本分类下一页（shop 无「自动切下一分类」语义） */
  onScrollToLower() {
    if (this._isLoadingNext || this.data.isLoading) return;
    const categoryId = this._activeCategoryId;
    if (!categoryId) return;
    if (!this._pageState[categoryId]?.hasMore) return;

    this._isLoadingNext = true;
    this.loadSpuList(categoryId, true).then(() => {
      this._isLoadingNext = false;
    });
  },

  async loadSpuList(categoryId: string, append = false) {
    this.setData({ isLoading: true });
    try {
      const cursor = append ? this._pageState[categoryId]?.cursor ?? null : null;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        'product.spuList',
        // cursor 为 null 时不传：云函数只把「缺省」当首页，显式 null 也接受，但别依赖
        cursor ? { categoryId, limit: PAGE_SIZE, cursor } : { categoryId, limit: PAGE_SIZE }
      );

      const prev = append ? (this._spuCache[categoryId] || []) : [];
      const listWithPrice = prev.concat(this._decorate(data?.spuList || [], prev.length));

      this._spuCache[categoryId] = listWithPrice;
      this._pageState[categoryId] = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };

      // 仅在仍在看该分类时更新（翻页期间用户可能已切走）
      if (this._activeCategoryId === categoryId) {
        this.setData({ spuList: listWithPrice, hasMore: Boolean(data?.hasMore) });
        this._refreshCoverWindow();
      }
    } catch (err: any) {
      console.error('loadSpuList error:', err);
      Toast.fail(err?.message || '加载商品失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },
});
