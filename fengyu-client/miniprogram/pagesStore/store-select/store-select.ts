// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';
import { getCurrentCity } from '../../utils/location';

const app = getApp<IAppOption>();

interface Store {
  store_name: string;
  market: string;
  market_name?: string;
  store_region?: string;
  region?: string;
  open_date?: string;
  available_beds?: number;
}

interface StoreGroup {
  market: string;
  stores: Store[];
}

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  console.log('[callClientApi] action:', action, 'payload:', payload);
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  console.log('[callClientApi] result:', JSON.stringify(res));
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

Page({
  data: {
    allStores: [] as Store[],
    groupedStores: [] as StoreGroup[],
    keyword: '',
    selectedStore: '',
    isLoading: false,
    currentCity: '',
  },

  onLoad() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
    this.loadStoresWithLocation();
  },

  async loadStoresWithLocation() {
    let city = '';
    try {
      // 尝试获取定位
      city = await getCurrentCity();
      this.setData({ currentCity: city });
    } catch (err: any) {
      console.log('[loadStoresWithLocation] 定位失败或被拒绝:', err);
      // 用户拒绝定位或定位失败，不提示，降级显示全部门店
    }
    this.loadStores(city);
  },

  async loadStores(city: string = '') {
    this.setData({ isLoading: true });
    console.log('[Stores] start loading, selectedStore:', this.data.selectedStore, 'city:', city);
    try {
      const payload = city ? { city } : {};
      const data = await callClientApi('store.list', payload);
      console.log('[loadStores] data:', JSON.stringify(data));
      const stores: Store[] = data?.stores || [];
      // 兼容字段名：API 返回 market_name，前端使用 market
      stores.forEach(s => {
        (s as any).market = (s as any).market_name || '其他';
        (s as any).region = (s as any).store_region || '';
      });
      console.log('[loadStores] stores count:', stores.length);
      this.setData({ allStores: stores });
      this.buildGroups(stores);
    } catch (err: any) {
      console.error('[loadStores] error:', err);
      // 可能是权限拒绝，检查错误类型
      if (err.errMsg?.includes('auth deny') || err.errMsg?.includes('authorize')) {
        Toast.fail('需要定位权限才能显示附近门店');
      } else {
        Toast.fail('加载门店失败: ' + (err?.message || '未知错误'));
      }
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

  onSearch(e: WechatMiniprogram.CustomEvent<string>) {
    const keyword = (e.detail as string).trim();
    this.setData({ keyword });
    const filtered = keyword
      ? this.data.allStores.filter(s =>
          s.store_name.includes(keyword) || s.region?.includes(keyword)
        )
      : this.data.allStores;
    this.buildGroups(filtered);
  },

  onShow() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
  },

  async onStoreTap(e: WechatMiniprogram.TouchEvent) {
    const { storeName } = e.currentTarget.dataset as { storeName: string };
    wx.navigateTo({
      url: `/pages/store-detail/store-detail?storeName=${encodeURIComponent(storeName)}`
    });
  },

  onShareAppMessage() {
    return { title: '凤御美容 — 选择门店', path: '/pages/store-select/store-select' };
  },
});
