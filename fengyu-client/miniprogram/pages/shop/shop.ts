// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface Category { category: string; category_order: number; }

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
    const storeName = app.globalData.boundStoreName;
    this.setData({ boundStoreName: storeName });
    if (storeName) this.loadCategories();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName;
    if (storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [] });
      if (storeName) this.loadCategories();
    }
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  async loadCategories() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCategories',
        data: { storeName: this.data.boundStoreName },
      }) as any;
      const categories: Category[] = res.result?.data || [];
      this.setData({ categories, activeCategoryIndex: 0 });
      const first = categories[0]?.category;
      if (first) this.loadSpuList(first);
    } catch {
      Toast.fail('加载分类失败');
    }
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent<{ index: number }>) {
    const index = e.detail.index;
    this.setData({ activeCategoryIndex: index, spuList: [] });
    const { categories } = this.data;
    const category = index < categories.length ? categories[index].category : '院装产品';
    this.loadSpuList(category);
  },

  async loadSpuList(category: string) {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getSpuList',
        data: { category, storeName: this.data.boundStoreName },
      }) as any;
      this.setData({ spuList: res.result?.data || [] });
    } catch {
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
