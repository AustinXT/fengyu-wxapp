// pages/store-select/store-select.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface Store {
  store_name: string;
  market: string;
  store_region?: string;
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
  },

  onLoad() {
    this.setData({ selectedStore: app.globalData.boundStoreName });
    this.loadStores();
  },

  async loadStores() {
    this.setData({ isLoading: true });
    console.log('[Stores] start loadingload, boundStoreName:', this.data.boundStoreName);
    try {
      const data = await callClientApi('store.list');
      console.log('[loadStores] data:', JSON.stringify(data));
      const stores: Store[] = data?.stores || [];
      // 兼容旧字段名
      stores.forEach(s => {
        (s as any).region = (s as any).store_region || '';
      });
      console.log('[loadStores] stores count:', stores.length);
      this.setData({ allStores: stores });
      this.buildGroups(stores);
    } catch (err: any) {
      console.error('[loadStores] error:', err);
      Toast.fail('加载门店失败: ' + (err?.message || '未知错误'));
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
      // TODO: 云函数需新增 auth.bindStore 接口来更新用户门店
      // 临时方案：先调用 auth.login，然后在本地更新（后端需要完善）
      const data = await callClientApi('auth.login', { storeName });
      // 后端 auth.login 目前不支持 storeName 参数，需要扩展
      // 暂时使用本地存储，后续需后端支持
      app.setStore(storeName);
      this.setData({ selectedStore: storeName });
      Toast.success('门店已切换');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch {
      // 降级：仅本地存储
      app.setStore(storeName);
      this.setData({ selectedStore: storeName });
      Toast.success('门店已切换（本地）');
      setTimeout(() => wx.navigateBack(), 1200);
    }
  },

  onShareAppMessage() {
    return { title: '凤御美容 — 选择门店', path: '/pages/store-select/store-select' };
  },
});
