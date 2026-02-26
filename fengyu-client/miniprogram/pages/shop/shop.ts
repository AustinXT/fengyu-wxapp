// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount, clearCart } from '../../utils/cart';

const app = getApp<IAppOption>();

interface Category { category: string; category_order: number; big_category: string; }

interface SpuItem {
  spu_id: string;
  name: string;
  category: string;
  big_category: string;
  cover_image: string;
  min_price: string;
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

  // 页面级 SPU 缓存：按分类名缓存已加载的 SPU 列表
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
      // 切换门店时清空购物车和 SPU 缓存
      clearCart();
      this._spuCache = {};
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [], cartCount: 0 });
      this.loadShopInit();
    } else {
      this.updateCartCount();
    }
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  // 点击"加入购物车"按钮
  async onAddToCart(e: WechatMiniprogram.TouchEvent) {
    e.stopPropagation(); // 阻止冒泡，避免触发卡片点击
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    const spu = this.data.spuList.find(s => s.spu_id === spuId);
    if (!spu) return;

    // 获取第一个 SKU 作为默认添加到购物车的商品
    const skuList = spu.skuList || [];
    if (skuList.length === 0) {
      Toast('暂无可购规格');
      return;
    }

    // 使用最低价的 SKU
    const sku = skuList[0];

    addToCart({
      skuId: sku.sku_id,
      spuId: spu.spu_id,
      spuName: spu.name,
      skuDisplayName: sku.sku_display_name,
      coverImage: spu.cover_image,
      price: sku.originalPrice || 0,
      bigCategory: spu.big_category,
      productType: sku.product_type,
    });

    this.updateCartCount();
    Toast.success('已加入购物车');
  },

  // 点击底部购物车栏
  onCartTap() {
    wx.navigateTo({ url: '/pages/cart/cart' });
  },

  // 使用 shopInit 合并接口一次性加载分类 + 第一个分类的 SPU 列表
  async loadShopInit() {
    try {
      this.setData({ isLoading: true });
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.shopInit',
          payload: { storeName: this.data.boundStoreName },
        },
      }) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '加载失败');
      }

      const categories: Category[] = res.result.data?.categories || [];
      const spuList: SpuItem[] = res.result.data?.spuList || [];

      // 为每个分类添加唯一索引，避免重复名称导致 wx:key 警告
      const categoriesWithIndex = categories.map((c, i) => ({
        ...c,
        _index: i,
      }));

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || '0',
      }));

      // 缓存第一个分类的 SPU 列表
      if (categories.length > 0) {
        this._spuCache[categories[0].category] = listWithPrice;
      }

      this.setData({
        categories: categoriesWithIndex,
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

  onCategoryChange(e: WechatMiniprogram.CustomEvent<number>) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const category = index < categories.length ? categories[index].category : '院装产品';

    // 先查缓存：命中则直接替换，不清空不闪烁
    const cached = this._spuCache[category];
    if (cached) {
      this.setData({ activeCategoryIndex: index, spuList: cached });
      return;
    }

    // 未命中缓存：清空列表显示骨架屏，发起请求
    this.setData({ activeCategoryIndex: index, spuList: [] });
    this.loadSpuList(category);
  },

  async loadSpuList(category: string) {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.spuList',
          payload: { category, storeName: this.data.boundStoreName },
        },
      }) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '加载商品失败');
      }

      const spuList: SpuItem[] = res.result.data?.spuList || [];
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || '0',
      }));

      // 写入缓存
      this._spuCache[category] = listWithPrice;

      this.setData({ spuList: listWithPrice });
    } catch (err: any) {
      console.error('loadSpuList error:', err);
      Toast.fail(err?.message || '加载商品失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pages/service-detail/service-detail?spuId=${spuId}` });
  },
});
