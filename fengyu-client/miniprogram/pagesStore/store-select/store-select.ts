// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';
import { getCurrentCity } from '../utils/location';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface Store {
  store_id: string;
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

Page({
  data: {
    allStores: [] as Store[],
    groupedStores: [] as StoreGroup[],
    keyword: '',
    selectedStore: '',
    isLoading: false,
    currentCity: '',
    locationFailed: false,
    // 'search': 定位失败，提示搜索；'minlen': 输入不足2字符；'': 正常
    showHint: '' as '' | 'search' | 'minlen',
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
      // 定位失败：标记状态，预加载全量门店供搜索使用
      this.setData({ locationFailed: true, showHint: 'search' });
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

      // 按城市筛选后无门店：提示并停止，不降级显示全部
      if (city && stores.length === 0) {
        Toast.fail(`${city}暂无门店`);
        this.setData({ allStores: [], groupedStores: [] });
        return;
      }

      this.setData({ allStores: stores });

      // 定位失败时预加载全量门店供搜索，但不展示列表
      if (this.data.locationFailed) return;

      this.buildGroups(stores);
    } catch (err: any) {
      console.error('[loadStores] error:', err);
      // 可能是权限拒绝，检查错误类型
      if (err.errMsg?.includes('auth deny') || err.errMsg?.includes('authorize')) {
        Toast.fail('需要定位权限才能显示附近门店');
      } else {
        Toast.fail(err?.message || '加载门店失败');
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

  onSearch(e: WxEvent<string>) {
    const keyword = (e.detail as string).trim();
    this.setData({ keyword });

    if (keyword.length >= 2) {
      const filtered = this.data.allStores.filter(s =>
        s.store_name.includes(keyword) || s.region?.includes(keyword)
      );
      this.setData({ showHint: '' });
      this.buildGroups(filtered);
    } else if (keyword.length === 0) {
      if (this.data.locationFailed) {
        // 定位失败：清空搜索恢复提示
        this.setData({ groupedStores: [], showHint: 'search' });
      } else {
        // 定位成功：清空搜索恢复城市门店
        this.setData({ showHint: '' });
        this.buildGroups(this.data.allStores);
      }
    } else {
      // 1 个字符：提示需要至少2个字符
      this.setData({ groupedStores: [], showHint: 'minlen' });
    }
  },

  onShow() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
  },

  async onStoreTap(e: WechatMiniprogram.TouchEvent) {
    const { storeId, storeName } = e.currentTarget.dataset as { storeId: string; storeName: string };
    wx.navigateTo({
      url: `/pagesStore/store-detail/store-detail?storeId=${encodeURIComponent(storeId)}&storeName=${encodeURIComponent(storeName)}`
    });
  },

  onShareAppMessage() {
    return { title: '凤御美容 — 选择门店', path: '/pagesStore/store-select/store-select' };
  },
});
