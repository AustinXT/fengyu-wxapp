// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';

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
}

Page({
  data: {
    boundStoreName: '',
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
  },

  onLoad() {
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
    this.loadCategories();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [] });
      this.loadCategories();
    }
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  async loadCategories() {
    try {
      this.setData({ isLoading: true });
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.categories',
          payload: { storeName: this.data.boundStoreName },
        },
      }) as any;
      const categories: Category[] = res.result?.data?.categories || [];
      // 为每个分类添加唯一索引，避免重复名称导致 wx:key 警告
      const categoriesWithIndex = categories.map((c, i) => ({
        ...c,
        _index: i,
      }));
      this.setData({ categories: categoriesWithIndex, activeCategoryIndex: 0 });
      const first = categories[0]?.category;
      if (first) this.loadSpuList(first);
    } catch (err) {
      console.error('loadCategories error:', err);
      Toast.fail('加载分类失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent<number>) {
    console.log('onCategoryChange', e.detail);
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;
    this.setData({ activeCategoryIndex: index, spuList: [] });
    const category = index < categories.length ? categories[index].category : '院装产品';
    console.log('Loading category:', index, category);
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
      const spuList: SpuItem[] = res.result?.data?.spuList || [];
      // 计算每个 SPU 的最低价
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || '0',
      }));
      this.setData({ spuList: listWithPrice });
    } catch (err) {
      console.error('loadSpuList error:', err);
      Toast.fail('加载商品失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pages/service-detail/service-detail?spuId=${spuId}` });
  },
});
