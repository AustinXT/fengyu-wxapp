// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface Store {
  store_name: string;
  market: string;
  region: string;
}

interface StoreGroup {
  market: string;
  stores: Store[];
}

Page({
  data: {
    allStores: [] as Store[],
    groupedStores: [] as StoreGroup[],
    keyword: '',
    selectedStore: '',
    isLoading: false,
  },

  onLoad() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
    this.loadStores();
  },

  async loadStores() {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'getStores' }) as any;
      const stores: Store[] = res.result?.data || [];
      this.setData({ allStores: stores });
      this.buildGroups(stores);
    } catch {
      Toast.fail('加载门店失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  buildGroups(stores: Store[]) {
    const map = new Map<string, Store[]>();
    stores.forEach(s => {
      if (!map.has(s.market)) map.set(s.market, []);
      map.get(s.market)!.push(s);
    });
    const groupedStores: StoreGroup[] = Array.from(map.entries()).map(([market, stores]) => ({
      market,
      stores,
    }));
    this.setData({ groupedStores });
  },

  onSearch(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const keyword = e.detail.value.trim();
    this.setData({ keyword });
    const filtered = keyword
      ? this.data.allStores.filter(s =>
          s.store_name.includes(keyword) || s.region?.includes(keyword)
        )
      : this.data.allStores;
    this.buildGroups(filtered);
  },

  async onStoreTap(e: WechatMiniprogram.TouchEvent) {
    const { storeName } = e.currentTarget.dataset as { storeName: string };
    try {
      await wx.cloud.callFunction({
        name: 'updateUserStore',
        data: { storeName },
      });
      app.setStore(storeName);
      this.setData({ selectedStore: storeName });
      Toast.success('门店已切换');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch {
      Toast.fail('切换失败，请重试');
    }
  },

  onShareAppMessage() {
    return { title: '凤御美容 — 选择门店', path: '/pages/store-select/store-select' };
  },
});
