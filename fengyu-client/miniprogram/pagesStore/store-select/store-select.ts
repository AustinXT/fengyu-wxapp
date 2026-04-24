// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';
import { getCurrentLocation } from '../utils/location';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface Store {
  store_id: string;
  store_name: string;
  market_name: string;
  store_region: string;
  open_date?: string;
  available_beds?: number;
}

interface StoreGroup {
  market_name: string;
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
    currentDistrict: '',
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
      const loc = await getCurrentLocation();
      city = loc.city;
      this.setData({ currentCity: loc.city, currentDistrict: loc.district });
    } catch (err: any) {
      console.warn('[loadStoresWithLocation] 定位失败或被拒绝:', err);
      // 定位失败：标记状态，预加载全量门店供搜索使用
      this.setData({ locationFailed: true, showHint: 'search' });
    }
    this.loadStores(city);
  },

  async loadStores(city: string = '') {
    this.setData({ isLoading: true });
    try {
      const payload = city ? { city } : {};
      const data = await callClientApi<{ stores: Store[] }>('store.list', payload);
      const stores: Store[] = (data?.stores || []).map(s => ({
        ...s,
        market_name: s.market_name || '其他',
        store_region: s.store_region || '',
      }));

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
      if (!map.has(s.market_name)) map.set(s.market_name, []);
      map.get(s.market_name)!.push(s);
    });
    const groupedStores: StoreGroup[] = Array.from(map.entries()).map(([market_name, stores]) => ({
      market_name,
      stores,
    }));
    this.setData({ groupedStores });
  },

  onSearch(e: WxEvent<string>) {
    const keyword = (e.detail as string).trim();
    this.setData({ keyword });

    if (keyword.length >= 2) {
      const filtered = this.data.allStores.filter(s =>
        s.store_name.includes(keyword) || s.store_region.includes(keyword)
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
    // 分享礼：被分享人进入首页而非分享者的门店选择页
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御美容 — 选择门店', path: `/pages/home/home${invSuffix}` };
  },
});
