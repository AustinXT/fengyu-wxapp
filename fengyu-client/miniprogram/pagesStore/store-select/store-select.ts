
import Toast from '@vant/weapp/toast/toast';
import { getCurrentLocation } from '../utils/location';
import { haversineKm, formatDistance, formatStoreAddress } from '../utils/distance';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface Store {
  store_id: string;
  store_name: string;
  market_name: string;
  store_region: string;
  street_address?: string;
  cover_image?: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
  open_date?: string;
  available_beds?: number;
  
  fullAddress?: string;
  distanceKm?: number | null;
  distanceText?: string;
}

Page({
  data: {
    allStores: [] as Store[],
    stores: [] as Store[],
    keyword: '',
    selectedStore: '',
    isLoading: false,
    currentCity: '',
    currentDistrict: '',
    userLat: null as number | null,
    userLng: null as number | null,
    locationFailed: false,
    
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
      this.setData({
        currentCity: loc.city,
        currentDistrict: loc.district,
        userLat: loc.latitude,
        userLng: loc.longitude,
      });
    } catch (err: any) {
      console.warn('[loadStoresWithLocation] 定位失败或被拒绝:', err);
      
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

      
      if (city && stores.length === 0) {
        Toast.fail(`${city}暂无门店`);
        this.setData({ allStores: [], stores: [] });
        return;
      }

      this.setData({ allStores: stores });

      
      if (this.data.locationFailed) return;

      this.setData({ stores: this.decorateAndSort(stores) });
    } catch (err: any) {
      console.error('[loadStores] error:', err);
      
      if (err.errMsg?.includes('auth deny') || err.errMsg?.includes('authorize')) {
        Toast.fail('需要定位权限才能显示附近门店');
      } else {
        Toast.fail(err?.message || '加载门店失败');
      }
    } finally {
      this.setData({ isLoading: false });
    }
  },

  
  decorateAndSort(stores: Store[]): Store[] {
    const { userLat, userLng } = this.data;
    const decorated = stores.map(s => {
      const fullAddress = formatStoreAddress(s.store_region, s.street_address);
      let distanceKm: number | null = null;
      const lat = Number(s.latitude);
      const lng = Number(s.longitude);
      if (userLat != null && userLng != null && s.latitude != null && s.longitude != null && !isNaN(lat) && !isNaN(lng)) {
        distanceKm = haversineKm(userLat, userLng, lat, lng);
      }
      return {
        ...s,
        fullAddress,
        distanceKm,
        distanceText: distanceKm == null ? '' : formatDistance(distanceKm),
      };
    });
    decorated.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return decorated;
  },

  onSearch(e: WxEvent<string>) {
    const keyword = (e.detail as string).trim();
    this.setData({ keyword });

    if (keyword.length >= 2) {
      const filtered = this.data.allStores.filter(s =>
        s.store_name.includes(keyword) || s.store_region.includes(keyword)
      );
      this.setData({ showHint: '', stores: this.decorateAndSort(filtered) });
    } else if (keyword.length === 0) {
      if (this.data.locationFailed) {
        
        this.setData({ stores: [], showHint: 'search' });
      } else {
        
        this.setData({ showHint: '', stores: this.decorateAndSort(this.data.allStores) });
      }
    } else {
      
      this.setData({ stores: [], showHint: 'minlen' });
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
    
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御美容 — 选择门店', path: `/pages/home/home${invSuffix}` };
  },
});
