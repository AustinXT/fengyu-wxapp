// pages/store-detail/store-detail.ts
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
  // 派生字段：省市区+地址
  fullAddress?: string;
}

// 转店申请（含目标门店）
interface TransferRequest {
  requestId: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  note: string | null;
  createdAt: string;
}

// bindState 仅表示「当前页门店 vs 已绑定门店」的关系（不含审批态）。
// 审批态由 pendingRequest 是否存在统一表达：一旦有 pending 转店申请，
// 无论在哪家门店详情页都展示审核中横幅 + 取消，且禁止再发起（同顾客仅 1 条 pending）。
//   'no-binding' — 未绑定任何门店，可直接绑定
//   'is-current' — 当前页就是已绑定门店
//   'other-bound'— 已绑定其他门店（可申请转绑到本店）
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
    // 转店备注弹窗
    showTransferDialog: false,
    transferNote: '',
    submittingTransfer: false,
    // 来源渠道弹窗
    showSourcePopup: false,
    sourceChannel: '',
    promoterEmployeeName: '',
    // 绑手机号弹窗（绑门店前若未授权手机号则弹出）
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

  // 审批生效后顾客切回本页时，先从服务器同步最新绑定态再重算 UI。
  // 首次进入由 onLoad 已 loadAll，跳过本次 onShow 避免重复请求；之后每次回到本页都刷新。
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
      // 从 API 返回的 store 获取真实 storeId
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
      // 异步计算距离（懒定位 + 缓存），失败静默不展示
      this.computeDistanceText(store);
    } catch (err: any) {
      console.error('[store-detail] loadAll error:', err);
      Toast.fail('加载门店失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 用户定位缓存：避免 onShow 重复 loadAll 反复弹定位授权
  _userLoc: null as { latitude: number; longitude: number } | null,

  // 计算门店距离文案；定位失败 / 门店缺经纬度时静默不展示
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

  // 绑定门店 — 先弹出来源渠道选择
  onBindStore() {
    this.setData({ showSourcePopup: true, sourceChannel: '', promoterEmployeeName: '' });
  },

  onSourcePopupClose() {
    this.setData({ showSourcePopup: false });
  },

  onSourceChannelChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ sourceChannel: String(e.detail) });
  },

  onPromoterEmployeeNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ promoterEmployeeName: e.detail.value });
  },

  // 确认绑定（含来源渠道 + 分享礼邀请人一次性写入）
  async onConfirmBind() {
    const { storeId, storeName, sourceChannel, promoterEmployeeName } = this.data;
    if (!sourceChannel) {
      Toast.fail('请选择来源渠道');
      return;
    }
    // 分享礼：读取在 App.onLaunch / onShow 中捕获的邀请人 userId
    const inviterUserId = app.globalData.pendingInviter;
    try {
      const data = await callClientApi('auth.bindStore', {
        storeId,
        sourceChannel,
        promoterEmployeeName: promoterEmployeeName || undefined,
      });
      app.setStore(data?.boundStoreId || storeId, storeName, data?.boundMarketName || '');
      // 一次性消费邀请人，防止二次使用
      if (inviterUserId) {
        app.globalData.pendingInviter = undefined;
        wx.removeStorageSync('pendingInviter');
      }
      this.setData({ bindState: 'is-current', boundStoreName: storeName, showSourcePopup: false });
      Toast.success('门店已绑定');
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      // 未授权手机号 → 弹绑手机号弹窗（保留已选来源渠道/推荐人，绑完后重提交）
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
      const inviterUserId = app.globalData.pendingInviter;
      await bindPhoneWithCloudID(cloudID, inviterUserId ? { inviterUserId } : {});
      if (inviterUserId) {
        app.globalData.pendingInviter = undefined;
        wx.removeStorageSync('pendingInviter');
      }
      this.setData({ showPhoneBind: false });
      // 绑定手机号成功后自动重提交绑门店
      setTimeout(() => this.onConfirmBind(), 600);
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败，请重试');
    }
  },

  // 申请转绑到本店（from = 已绑定门店，to = 当前页门店）
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

  // 取消转店申请
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
    // 分享礼：统一回首页并附带邀请人 inv 参数，保留原 title 文案
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: `凤御美容 — ${this.data.storeName}`,
      path: `/pages/home/home${invSuffix}`
    };
  },
});
