// pages/store-detail/store-detail.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface StoreInfo {
  store_name: string;
  market_name: string;
  store_region: string;
  open_date: string;
  available_beds: number;
  staff_count: number;
  customer_count: number;
}

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

Page({
  data: {
    store: null as StoreInfo | null,
    isLoading: true,
    isCurrent: false,
    storeName: '',
  },

  onLoad(options: { storeName?: string }) {
    const storeName = decodeURIComponent(options.storeName || '');
    if (!storeName) {
      Toast.fail('缺少门店参数');
      return;
    }
    this.setData({
      storeName,
      isCurrent: app.globalData.boundStoreName === storeName,
    });
    this.loadDetail(storeName);
  },

  async loadDetail(storeName: string) {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi('store.detail', { storeName });
      this.setData({ store: data?.store || null });
    } catch (err: any) {
      console.error('[store-detail] loadDetail error:', err);
      Toast.fail('加载门店失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async onSelectStore() {
    if (this.data.isCurrent) return;
    const storeName = this.data.storeName;
    try {
      const data = await callClientApi('auth.bindStore', { storeName });
      app.setStore(storeName, data?.boundMarketName || '');
      this.setData({ isCurrent: true });
      Toast.success('门店已切换');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      console.error('[store-detail] bindStore failed:', err);
      Toast.fail('切换门店失败: ' + (err?.message || '未知错误'));
    }
  },

  onShareAppMessage() {
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pages/store-detail/store-detail?storeName=${encodeURIComponent(this.data.storeName)}`
    };
  },
});
