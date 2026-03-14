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
  cover_image: string;
  street_address: string;
  phone: string;
  business_hours: string;
  parking_info: string;
  description: string;
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
    storeId: '',
    storeName: '',
    bindState: 'no-binding' as BindState,
    boundStoreName: '',
    pendingRequest: null as UnbindRequest | null,
    // 解绑备注弹窗
    showUnbindDialog: false,
    unbindNote: '',
    submittingUnbind: false,
    // 来源渠道弹窗
    showSourcePopup: false,
    sourceChannel: '',
    promoterName: '',
    sourceChannels: ['推广部', '老带新', '美团', '抖音', '转让店', '自进', '内部地推', '第三方拓客'],
  },

  onLoad(options: { storeId?: string; storeName?: string }) {
    const storeId = decodeURIComponent(options.storeId || '');
    const storeName = decodeURIComponent(options.storeName || '');
    if (!storeId && !storeName) {
      Toast.fail('缺少门店参数');
      return;
    }
    this.setData({ storeId, storeName });
    this.loadAll(storeId, storeName);
  },

  async loadAll(storeId: string, storeName: string) {
    this.setData({ isLoading: true });
    try {
      const detailPayload = storeId ? { storeId } : { storeName };
      const [detailData, unbindData] = await Promise.all([
        callClientApi('store.detail', detailPayload),
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

  // 绑定门店 — 先弹出来源渠道选择
  onBindStore() {
    this.setData({ showSourcePopup: true, sourceChannel: '', promoterName: '' });
  },

  onSourcePopupClose() {
    this.setData({ showSourcePopup: false });
  },

  onSourceChannelChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ sourceChannel: e.detail });
  },

  onPromoterNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ promoterName: e.detail.value });
  },

  // 确认绑定（含来源渠道）
  async onConfirmBind() {
    const { storeId, storeName, sourceChannel, promoterName } = this.data;
    if (!sourceChannel) {
      Toast('请选择来源渠道');
      return;
    }
    try {
      const data = await callClientApi('auth.bindStore', {
        storeId,
        sourceChannel,
        promoterName: promoterName || undefined,
      });
      app.setStore(data?.boundStoreId || storeId, storeName, data?.boundMarketName || '');
      this.setData({ bindState: 'is-current', boundStoreName: storeName, showSourcePopup: false });
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

  onUnbindNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ unbindNote: e.detail.value });
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

  onCallPhone() {
    const phone = (this.data.store as any)?.phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    }
  },

  onOpenMap() {
    const store = this.data.store as any;
    if (store?.latitude && store?.longitude) {
      wx.openLocation({
        latitude: Number(store.latitude),
        longitude: Number(store.longitude),
        name: store.store_name || '',
        address: store.street_address || '',
      });
    } else if (store?.street_address) {
      wx.setClipboardData({ data: store.street_address });
      Toast('地址已复制');
    }
  },

  onShareAppMessage() {
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pagesStore/store-detail/store-detail?storeName=${encodeURIComponent(this.data.storeName)}`
    };
  },
});
