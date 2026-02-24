// pages/service-detail/service-detail.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface Spu {
  spu_id: string;
  name: string;
  big_category: string;
  cover_image: string;
  description: string;
}

interface Sku {
  sku_id: string;
  sku_display_name: string;
  price: number;
  session_count: number | null;
  product_type: string;
}

interface Staff {
  staff_wf_id: string;
  name: string;
  position: string;
}

Page({
  data: {
    spu: {} as Spu,
    skuList: [] as Sku[],
    selectedSku: null as Sku | null,
    staffList: [] as Staff[],
    selectedStaffWfId: '',
    selectedStaffName: '',
    showStaffPopup: false,
    isLoading: true,
  },

  onLoad(options) {
    const { spuId } = options as { spuId: string };
    if (!spuId) {
      wx.navigateBack();
      return;
    }
    this.loadDetail(spuId);
    this.loadStaffList();
  },

  async loadDetail(spuId: string) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getSpuDetail',
        data: { spuId, storeName: app.globalData.boundStoreName },
      }) as any;
      const { spu, skuList } = res.result?.data || {};
      this.setData({ spu: spu || {}, skuList: skuList || [] });
      wx.setNavigationBarTitle({ title: spu?.name || '服务详情' });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async loadStaffList() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStaffList',
        data: { storeName: app.globalData.boundStoreName },
      }) as any;
      this.setData({ staffList: res.result?.data || [] });
    } catch {
      // 美容师加载失败不影响主流程
    }
  },

  onSkuTap(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const sku = this.data.skuList.find(s => s.sku_id === skuId) || null;
    this.setData({ selectedSku: sku });
  },

  onSelectStaff() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.TouchEvent) {
    const { wfId, name } = e.currentTarget.dataset as { wfId: string; name: string };
    this.setData({
      selectedStaffWfId: wfId,
      selectedStaffName: name,
      showStaffPopup: false,
    });
  },

  onSubmit() {
    const { selectedSku, selectedStaffWfId, selectedStaffName, spu } = this.data;
    if (!selectedSku) {
      Toast('请先选择规格');
      return;
    }
    wx.navigateTo({
      url: `/pages/checkout/checkout?skuId=${selectedSku.sku_id}&spuName=${encodeURIComponent(spu.name)}&staffWfId=${selectedStaffWfId}&staffName=${encodeURIComponent(selectedStaffName)}`,
    });
  },

  onShareAppMessage() {
    return { title: this.data.spu.name || '凤御服务', path: '/pages/home/home' };
  },
});
