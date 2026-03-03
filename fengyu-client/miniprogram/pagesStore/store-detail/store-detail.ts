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

interface UnbindRequest {
  requestId: string;
  fromStoreName: string;
  note: string | null;
  createdAt: string;
}

// bindState:
//   'no-binding'          — 无绑定门店，可直接绑定
//   'is-current'          — 当前门店，无 pending 申请，可申请解绑
//   'is-current-reviewing'— 当前门店，有 pending 申请
//   'other-bound'         — 已绑定其他门店
type BindState = 'no-binding' | 'is-current' | 'is-current-reviewing' | 'other-bound';

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
    storeName: '',
    bindState: 'no-binding' as BindState,
    boundStoreName: '',
    pendingRequest: null as UnbindRequest | null,
    // 解绑备注弹窗
    showUnbindDialog: false,
    unbindNote: '',
    submittingUnbind: false,
  },

  onLoad(options: { storeName?: string }) {
    const storeName = decodeURIComponent(options.storeName || '');
    if (!storeName) {
      Toast.fail('缺少门店参数');
      return;
    }
    this.setData({ storeName });
    this.loadAll(storeName);
  },

  async loadAll(storeName: string) {
    this.setData({ isLoading: true });
    try {
      const [detailData, unbindData] = await Promise.all([
        callClientApi('store.detail', { storeName }),
        callClientApi('store.getUnbindRequest'),
      ]);
      const pendingRequest: UnbindRequest | null = unbindData?.request || null;
      const boundStoreName = app.globalData.boundStoreName || '';
      const bindState = this.computeBindState(storeName, boundStoreName, pendingRequest);
      this.setData({
        store: detailData?.store || null,
        pendingRequest,
        boundStoreName,
        bindState,
      });
    } catch (err: any) {
      console.error('[store-detail] loadAll error:', err);
      Toast.fail('加载门店失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  computeBindState(storeName: string, boundStoreName: string, pendingRequest: UnbindRequest | null): BindState {
    if (!boundStoreName) return 'no-binding';
    if (boundStoreName === storeName) {
      return pendingRequest ? 'is-current-reviewing' : 'is-current';
    }
    return 'other-bound';
  },

  // 直接绑定（首次绑定）
  async onBindStore() {
    const storeName = this.data.storeName;
    try {
      const data = await callClientApi('auth.bindStore', { storeName });
      app.setStore(storeName, data?.boundMarketName || '');
      this.setData({ bindState: 'is-current', boundStoreName: storeName });
      Toast.success('门店已绑定');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      Toast.fail('绑定失败: ' + (err?.message || '未知错误'));
    }
  },

  // 申请解绑
  onRequestUnbind() {
    this.setData({ showUnbindDialog: true, unbindNote: '' });
  },

  onUnbindNoteInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ unbindNote: e.detail });
  },

  onUnbindDialogCancel() {
    this.setData({ showUnbindDialog: false });
  },

  async onUnbindDialogConfirm() {
    if (this.data.submittingUnbind) return;
    this.setData({ submittingUnbind: true });
    try {
      const data = await callClientApi('store.requestUnbind', { note: this.data.unbindNote || undefined });
      const pendingRequest: UnbindRequest = {
        requestId: data.requestId,
        fromStoreName: this.data.storeName,
        note: this.data.unbindNote || null,
        createdAt: new Date().toISOString(),
      };
      this.setData({
        showUnbindDialog: false,
        bindState: 'is-current-reviewing',
        pendingRequest,
      });
      Toast.success('解绑申请已提交');
    } catch (err: any) {
      Toast.fail(err?.message?.replace('INVALID_PARAMS: ', '') || '提交失败');
    } finally {
      this.setData({ submittingUnbind: false });
    }
  },

  // 取消解绑申请
  async onCancelUnbindRequest() {
    const { pendingRequest } = this.data;
    if (!pendingRequest) return;
    try {
      await callClientApi('store.cancelUnbindRequest', { requestId: pendingRequest.requestId });
      this.setData({
        pendingRequest: null,
        bindState: 'is-current',
      });
      Toast.success('申请已取消');
    } catch (err: any) {
      Toast.fail('取消失败: ' + (err?.message || '未知错误'));
    }
  },

  onShareAppMessage() {
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pagesStore/store-detail/store-detail?storeName=${encodeURIComponent(this.data.storeName)}`
    };
  },
});
