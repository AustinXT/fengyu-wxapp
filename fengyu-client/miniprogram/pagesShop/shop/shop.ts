// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount, clearCart } from '../../utils/cart';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface Category { category_id: string; category_name: string; category_order: number; product_kind: string; }

interface SpuItem {
  product_id: string;
  name: string;
  category_name: string;
  product_kind: string;
  cover_image: string;
  min_price: string;
  is_recommend: boolean;
  skuList?: any[];
}

const BIG_CATEGORIES = ['福利活动', '护理项目', '家居产品', '充值卡'];

Page({
  data: {
    boundStoreName: '',
    bigCategories: BIG_CATEGORIES,
    activeBigCategoryIndex: 0,
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
    cartCount: 0,
  },

  // 所有分类（未过滤）
  _allCategories: [] as Category[],

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
      this._allCategories = [];
      this.setData({ boundStoreName: storeName, activeBigCategoryIndex: 0, activeCategoryIndex: 0, spuList: [], cartCount: 0 });
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
    (e as any).stopPropagation(); // 阻止冒泡，避免触发卡片点击
    const { productId } = e.currentTarget.dataset as { productId: string };
    const spu = this.data.spuList.find(s => s.product_id === productId);
    if (!spu) return;

    // 获取第一个 SKU 作为默认添加到购物车的商品
    const skuList = spu.skuList || [];
    if (skuList.length === 0) {
      Toast.fail('暂无可购规格');
      return;
    }

    // 使用最低价的 SKU
    const sku = skuList[0];

    addToCart({
      skuId: sku.sku_id,
      spuId: spu.product_id,
      spuName: spu.name,
      skuDisplayName: sku.spec_name,
      coverImage: spu.cover_image,
      price: Number(sku.special_price || sku.price || 0),
      bigCategory: spu.product_kind,
      productType: sku.product_type,
    });

    this.updateCartCount();
    Toast.success('已加入购物车');
  },

  // 点击底部购物车栏
  onCartTap() {
    wx.navigateTo({ url: '/pagesShop/shopping-cart/shopping-cart' });
  },

  // 使用 shopInit 合并接口一次性加载分类 + 第一个分类的 SPU 列表
  async loadShopInit() {
    try {
      this.setData({ isLoading: true });
      const initData = await callClientApi<{ categories: Category[]; spuList: any[] }>('product.shopInit', {});

      const categories: Category[] = initData?.categories || [];
      const spuList: SpuItem[] = initData?.spuList || [];

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || '0',
      }));

      // 缓存 shopInit 返回的 SPU 列表（对应全局第一个分类）
      if (categories.length > 0) {
        this._spuCache[categories[0].category_name] = listWithPrice;
      }

      // 保存全部分类，按当前大类筛选侧边栏
      this._allCategories = categories;
      const activeBig = BIG_CATEGORIES[this.data.activeBigCategoryIndex];
      const filtered = categories.filter(c => c.product_kind === activeBig);
      const categoriesWithIndex = filtered.map((c, i) => ({
        ...c,
        _index: i,
      }));

      // 判断第一个筛选后的分类是否有缓存
      let displayList = listWithPrice;
      if (filtered.length > 0 && filtered[0].category_name !== categories[0]?.category_name) {
        // 首个大类分类与全局首个分类不同，需单独加载
        displayList = [];
      }

      this.setData({
        categories: categoriesWithIndex,
        activeCategoryIndex: 0,
        spuList: displayList,
      });

      // 如需单独加载首个大类的 SPU
      if (filtered.length > 0 && displayList.length === 0) {
        this.loadSpuList(filtered[0].category_name);
      }
    } catch (err: any) {
      console.error('loadShopInit error:', err);
      Toast.fail(err?.message || '加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onBigCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.index;
    if (typeof index !== 'number' || index === this.data.activeBigCategoryIndex) return;

    const activeBig = BIG_CATEGORIES[index];
    const filtered = this._allCategories.filter(c => c.product_kind === activeBig);
    const categoriesWithIndex = filtered.map((c, i) => ({ ...c, _index: i }));

    this.setData({
      activeBigCategoryIndex: index,
      categories: categoriesWithIndex,
      activeCategoryIndex: 0,
      spuList: [],
    });

    if (filtered.length > 0) {
      const firstCategory = filtered[0].category_name;
      const cached = this._spuCache[firstCategory];
      if (cached) {
        this.setData({ spuList: cached });
      } else {
        this.loadSpuList(firstCategory);
      }
    }
  },

  onCategoryChange(e: WxEvent<number>) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const category = index < categories.length ? categories[index].category_name : '家居产品';

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
    // 根据分类名查找 categoryId 传给云函数
    const catObj = this._allCategories.find(c => c.category_name === category);
    if (!catObj) {
      this.setData({ isLoading: false });
      return;
    }
    try {
      const data = await callClientApi<{ spuList: SpuItem[] }>('product.spuList', { categoryId: catObj.category_id });

      const spuList: SpuItem[] = data?.spuList || [];
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
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },
});
