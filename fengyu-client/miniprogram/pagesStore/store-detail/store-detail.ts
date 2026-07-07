
import Toast from '@vant/weapp/toast/toast';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { formatStoreAddress, haversineKm, formatDistance } from '../utils/distance';
import { getCurrentLocation } from '../utils/location';

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
  images: string[];
  street_address: string;
  latitude: number | null;
  longitude: number | null;
  phone: string;
  business_hours: string;
  parking_info: string;
  description: string;
  announcement: string;
  
  fullAddress?: string;
}


interface TransferRequest {
  requestId: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  note: string | null;
  createdAt: string;
}







type BindState = 'no-binding' | 'is-current' | 'other-bound';

Page({
  data: {
    store: null as StoreInfo | null,
    isLoading: true,
    storeId: '',
    storeName: '',
    distanceText: '',
    bindState: 'no-binding' as BindState,
    boundStoreName: '',
    pendingRequest: null as TransferRequest | null,
    
    showTransferDialog: false,
    transferNote: '',
    submittingTransfer: false,
    
    showSourcePopup: false,
    sourceChannel: '',
    promoterName: '',
    
    showPhoneBind: false,
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

  
  
  _shownOnce: false,
  async onShow() {
    if (!this._shownOnce) {
      this._shownOnce = true;
      return;
    }
    if (!this.data.storeId && !this.data.storeName) return;
    await app.syncLoginState();
    await this.loadAll(this.data.storeId, this.data.storeName);
  },

  async loadAll(storeId: string, storeName: string) {
    this.setData({ isLoading: true });
    try {
      const detailPayload = storeId ? { storeId } : { storeName };
      const [detailData, unbindData] = await Promise.all([
        callClientApi('store.detail', detailPayload),
        callClientApi('store.getUnbindRequest'),
      ]);
      const pendingRequest: TransferRequest | null = unbindData?.request || null;
      const boundStoreName = app.globalData.boundStoreName || '';
      
      const realStoreId = detailData?.store?.store_id || storeId;
      const bindState = this.computeBindState(realStoreId);
      const store: StoreInfo | null = detailData?.store
        ? {
            ...detailData.store,
            images: Array.isArray(detailData.store.images) ? detailData.store.images : [],
            fullAddress: formatStoreAddress(detailData.store.store_region, detailData.store.street_address),
          }
        : null;
      this.setData({
        store,
        storeId: realStoreId,
        pendingRequest,
        boundStoreName,
        bindState,
      });
      
      this.computeDistanceText(store);
    } catch (err: any) {
      console.error('[store-detail] loadAll error:', err);
      Toast.fail('加载门店失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  
  _userLoc: null as { latitude: number; longitude: number } | null,

  
  async computeDistanceText(store: StoreInfo | null) {
    if (!store || store.latitude == null || store.longitude == null) return;
    const lat = Number(store.latitude);
    const lng = Number(store.longitude);
    if (isNaN(lat) || isNaN(lng)) return;
    try {
      if (!this._userLoc) {
        const loc = await getCurrentLocation();
        this._userLoc = { latitude: loc.latitude, longitude: loc.longitude };
      }
      const km = haversineKm(this._userLoc.latitude, this._userLoc.longitude, lat, lng);
      this.setData({ distanceText: formatDistance(km) });
    } catch (err) {
      console.warn('[store-detail] 距离计算失败（定位被拒或不可用）:', err);
    }
  },

  computeBindState(storeId: string): BindState {
    const boundStoreId = app.globalData.boundStoreId;
    if (!boundStoreId) return 'no-binding';
    return boundStoreId === storeId ? 'is-current' : 'other-bound';
  },

  
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

  
  async onConfirmBind() {
    const { storeId, storeName, sourceChannel, promoterName } = this.data;
    if (!sourceChannel) {
      Toast.fail('请选择来源渠道');
      return;
    }
    
    const inviterUserId = app.globalData.pendingInviter;
    try {
      const data = await callClientApi('auth.bindStore', {
        storeId,
        sourceChannel,
        promoterEmployeeId: promoterName || undefined,
        inviterUserId: inviterUserId || undefined,
      });
      app.setStore(data?.boundStoreId || storeId, storeName, data?.boundMarketName || '');
      
      if (inviterUserId) {
        app.globalData.pendingInviter = undefined;
        wx.removeStorageSync('pendingInviter');
      }
      this.setData({ bindState: 'is-current', boundStoreName: storeName, showSourcePopup: false });
      Toast.success('门店已绑定');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      
      if (err?.errorType === 'PHONE_REQUIRED') {
        this.setData({ showPhoneBind: true });
        return;
      }
      Toast.fail(err?.message || '绑定失败');
    }
  },

  onPhoneBindClose() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent<{ cloudID?: string; errMsg?: string }>) {
    const { cloudID, errMsg } = e.detail || {};
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      }
      return;
    }
    try {
      await bindPhoneWithCloudID(cloudID);
      this.setData({ showPhoneBind: false });
      
      setTimeout(() => this.onConfirmBind(), 600);
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败，请重试');
    }
  },

  
  onRequestTransfer() {
    this.setData({ showTransferDialog: true, transferNote: '' });
  },

  onTransferNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ transferNote: e.detail.value });
  },

  onTransferDialogCancel() {
    this.setData({ showTransferDialog: false });
  },

  async onTransferDialogConfirm() {
    if (this.data.submittingTransfer) return;
    this.setData({ submittingTransfer: true });
    try {
      const data = await callClientApi('store.requestUnbind', {
        toStoreId: this.data.storeId,
        note: this.data.transferNote || undefined,
      });
      const pendingRequest: TransferRequest = {
        requestId: data.requestId,
        fromStoreName: app.globalData.boundStoreName || '',
        toStoreId: this.data.storeId,
        toStoreName: this.data.storeName,
        note: this.data.transferNote || null,
        createdAt: new Date().toISOString(),
      };
      this.setData({ showTransferDialog: false, pendingRequest });
      Toast.success('转店申请已提交');
    } catch (err: any) {
      Toast.fail(err?.message || '提交失败');
    } finally {
      this.setData({ submittingTransfer: false });
    }
  },

  
  async onCancelTransferRequest() {
    const { pendingRequest } = this.data;
    if (!pendingRequest) return;
    try {
      await callClientApi('store.cancelUnbindRequest', { requestId: pendingRequest.requestId });
      this.setData({ pendingRequest: null });
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

  onPreviewImage(e: WechatMiniprogram.TouchEvent) {
    const urls = this.data.store?.images || [];
    if (!urls.length) return;
    const { index } = e.currentTarget.dataset as { index: number };
    wx.previewImage({ current: urls[index], urls });
  },

  onShareAppMessage() {
    
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pages/home/home${invSuffix}`
    };
  },
});
