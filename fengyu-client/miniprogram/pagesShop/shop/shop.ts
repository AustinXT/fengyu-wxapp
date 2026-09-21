// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount, clearCart } from '../../utils/cart';
import { callClientApi } from '../../utils/cloud';
import { getIsMember, priceView } from '../../utils/member-pricing';

const app = getApp<IAppOption>();

interface Category { category_id: string; category_name: string; category_order: number; }

interface SpuItem {
  product_id: string;
  name: string;
  category_name: string;
  /** issue #230：云函数无法保证缩略时下发 null，wxml 走 cover-placeholder 分支 */
  cover_image: string | null;
  min_price: string;
  /** 会员价分流：仅会员且标价起价 > 会员起价时填标价起价（划线），否则空串 */
  strike_min_price?: string;
  /** 组合套餐标记：列表展示套餐总价，不带「起」字（普通单品多 SKU 起价才显示） */
  is_bundle?: boolean;
  is_recommend: boolean;
  skuList?: any[];
}

Page({
  data: {
    boundStoreName: '',
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
    cartCount: 0,
  },

  // 所有分类
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按 categoryId 缓存
  _spuCache: {} as Record<string, SpuItem[]>,

  onLoad() {
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
    this.loadShopInit();
    this.updateCartCount();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      clearCart();
      this._spuCache = {};
      this._allCategories = [];
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [], cartCount: 0 });
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

  async loadShopInit() {
    try {
      this.setData({ isLoading: true });
      const initData = await callClientApi<{ categories: Category[]; spuList: any[] }>('product.shopInit', {});

      const categories: Category[] = initData?.categories || [];
      const spuList: SpuItem[] = initData?.spuList || [];

      // 会员价分流：会员看会员起价（priceFrom）+ 划线标价起价；非会员只看标价起价（listPriceFrom）
      const isMember = getIsMember();
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || '0') : (spu.listPriceFrom || spu.priceFrom || '0'),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : '',
      }));

      this._allCategories = categories;

      // 缓存第一个分类
      if (categories.length > 0) {
        this._spuCache[categories[0].category_id] = listWithPrice;
      }

      this.setData({
        categories,
        activeCategoryIndex: 0,
        spuList: listWithPrice,
      });
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

    const cached = this._spuCache[cat.category_id];
    if (cached) {
      this.setData({ activeCategoryIndex: index, spuList: cached });
      return;
    }

    this.setData({ activeCategoryIndex: index, spuList: [] });
    this.loadSpuList(cat.category_id);
  },

  async loadSpuList(categoryId: string) {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi<{ spuList: SpuItem[] }>('product.spuList', { categoryId });

      const spuList: SpuItem[] = data?.spuList || [];
      // 会员价分流：会员看会员起价 + 划线标价起价；非会员只看标价起价
      const isMember = getIsMember();
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || '0') : (spu.listPriceFrom || spu.priceFrom || '0'),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : '',
      }));

      this._spuCache[categoryId] = listWithPrice;
      this.setData({ spuList: listWithPrice });
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
