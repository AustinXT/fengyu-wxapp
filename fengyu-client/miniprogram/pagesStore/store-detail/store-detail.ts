// pages/store-detail/store-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';

const app = getApp<IAppOption>();

interface StoreInfo {
  store_id: string;
  store_name: string;
  market_name: string;
  store_region: string;
  open_date: string;
  available_beds: number;
  staff_count: number;
  customer_count: number;
  cover_image: string;
  street_address: string;
  latitude: number | null;
  longitude: number | null;
  phone: string;
  business_hours: string;
  parking_info: string;
  description: string;
  announcement: string;
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
    sourceGroups: [
      { label: '线上来源', channels: ['美团', '抖音', '小程序'] },
      { label: '线下来源', channels: ['推带新', '地推卡', '拓客卡', '老带新', '转让店', '自进店', '内部员工或家属'] },
    ],
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
      // 从 API 返回的 store 获取真实 storeId
      const realStoreId = detailData?.store?.store_id || storeId;
      const bindState = this.computeBindState(realStoreId, pendingRequest);
      this.setData({
        store: detailData?.store || null,
        storeId: realStoreId,
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

  computeBindState(storeId: string, pendingRequest: UnbindRequest | null): BindState {
    const boundStoreId = app.globalData.boundStoreId;
    if (!boundStoreId) return 'no-binding';
    if (boundStoreId === storeId) {
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
    this.setData({ sourceChannel: String(e.detail) });
  },

  onPromoterNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ promoterName: e.detail.value });
  },

  // 确认绑定（含来源渠道）
  async onConfirmBind() {
    const { storeId, storeName, sourceChannel, promoterName } = this.data;
    if (!sourceChannel) {
      Toast.fail('请选择来源渠道');
      return;
    }
    try {
      const data = await callClientApi('auth.bindStore', {
        storeId,
        sourceChannel,
        promoterEmployeeId: promoterName || undefined,
      });
      app.setStore(data?.boundStoreId || storeId, storeName, data?.boundMarketName || '');
      this.setData({ bindState: 'is-current', boundStoreName: storeName, showSourcePopup: false });
      Toast.success('门店已绑定');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败');
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
      Toast.fail(err?.message || '提交失败');
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
      Toast.fail(err?.message || '取消失败');
    }
  },

  onCallPhone() {
    const phone = this.data.store?.phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    }
  },

  onOpenMap() {
    const store = this.data.store;
    if (store?.latitude && store?.longitude) {
      wx.openLocation({
        latitude: Number(store.latitude),
        longitude: Number(store.longitude),
        name: store.store_name || '',
        address: store.street_address || '',
      });
    } else if (store?.street_address) {
      wx.setClipboardData({ data: store.street_address });
      Toast.success('地址已复制');
    }
  },

  onShareAppMessage() {
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pagesStore/store-detail/store-detail?storeName=${encodeURIComponent(this.data.storeName)}`
    };
  },
});
