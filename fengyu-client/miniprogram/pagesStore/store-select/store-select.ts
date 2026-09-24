// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';
import { getCurrentLocation } from '../utils/location';
import { haversineKm, formatDistance, formatStoreAddress } from '../utils/distance';
import {
  MIN_STORE_SEARCH_LENGTH,
  filterStoresByCity,
  getStoreSearchLength,
  searchStores,
} from '../utils/store-search';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface Store {
  store_id: string;
  store_name: string;
  market_name: string;
  store_region: string;
  street_address?: string;
  // 云函数无法保证缩略时会下发 null（见 clientApi/utils/image.js 的 safeThumbUrl），
  // 前端 wx:if 走占位图分支
  cover_image?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  open_date?: string;
  available_beds?: number;
  // 派生字段
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
    showHint: '' as '' | 'search' | 'minlen' | 'no-city' | 'no-result' | 'load-error',
  },

  onLoad() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
    this.loadStoresWithLocation();
  },

  async loadStoresWithLocation() {
    this.setData({ isLoading: true });
    const locationTask = getCurrentLocation()
      .then((location) => ({ ok: true as const, location }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const storesTask = callClientApi<{ stores: Store[] }>('store.list', {})
      .then((data) => ({ ok: true as const, data }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    const [locationResult, storesResult] = await Promise.all([locationTask, storesTask]);

    if (!locationResult.ok) {
      console.warn('[loadStoresWithLocation] 定位失败或被拒绝:', locationResult.error);
    }

    if (!storesResult.ok) {
      const err = storesResult.error as any;
      console.error('[loadStoresWithLocation] 加载门店失败:', err);
      Toast.fail(err?.message || '加载门店失败');
      this.setData({
        allStores: [],
        stores: [],
        locationFailed: !locationResult.ok,
        showHint: 'load-error',
        isLoading: false,
      });
      return;
    }

    const allStores: Store[] = (storesResult.data?.stores || []).map((store) => ({
      ...store,
      market_name: store.market_name || '其他',
      store_region: store.store_region || '',
    }));
    const currentCity = locationResult.ok ? locationResult.location.city : '';
    const locationFailed = !locationResult.ok;

    this.setData({
      allStores,
      currentCity,
      currentDistrict: locationResult.ok ? locationResult.location.district : '',
      userLat: locationResult.ok ? locationResult.location.latitude : null,
      userLng: locationResult.ok ? locationResult.location.longitude : null,
      locationFailed,
      isLoading: false,
    }, () => {
      this.refreshVisibleStores(this.data.keyword, allStores, { currentCity, locationFailed });
    });
  },

  // 计算地址/距离并按距离升序（无法计算距离的排最后）
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

  refreshVisibleStores(
    rawKeyword: string,
    allStores?: Store[],
    locationState?: { currentCity: string; locationFailed: boolean },
  ) {
    const sourceStores = allStores ?? this.data.allStores;
    const keywordLength = getStoreSearchLength(rawKeyword);

    if (keywordLength >= MIN_STORE_SEARCH_LENGTH) {
      const matched = searchStores(sourceStores, rawKeyword);
      this.setData({
        stores: this.decorateAndSort(matched),
        showHint: matched.length > 0 ? '' : 'no-result',
      });
      return;
    }

    if (keywordLength > 0) {
      this.setData({ stores: [], showHint: 'minlen' });
      return;
    }

    const locationFailed = locationState?.locationFailed ?? this.data.locationFailed;
    if (locationFailed) {
      this.setData({ stores: [], showHint: 'search' });
      return;
    }

    const currentCity = locationState?.currentCity ?? this.data.currentCity;
    const cityStores = filterStoresByCity(sourceStores, currentCity);
    this.setData({
      stores: this.decorateAndSort(cityStores),
      showHint: cityStores.length > 0 ? '' : 'no-city',
    });
  },

  onSearch(e: WxEvent<string>) {
    const keyword = String(e.detail || '');
    this.setData({ keyword });
    this.refreshVisibleStores(keyword);
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
