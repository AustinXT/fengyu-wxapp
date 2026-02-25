// pages/service-detail/service-detail.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount } from '../../utils/cart';

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
  staff_id: string;
  name: string;
  position: string;
}

// 调用 clientApi 云函数
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
    spu: {} as Spu,
    skuList: [] as Sku[],
    selectedSku: null as Sku | null,
    staffList: [] as Staff[],
    staffListLoading: false,
    selectedStaffWfId: '',
    selectedStaffName: '',
    showStaffPopup: false,
    isLoading: true,
    cartCount: 0,
  },

  onLoad(options) {
    const { spuId } = options as { spuId: string };
    if (!spuId) {
      wx.navigateBack();
      return;
    }
    this.loadDetail(spuId);
    this.loadStaffList();
    this.loadDefaultStaff();
  },

  onShow() {
    this.setData({ cartCount: getCartCount() });
  },

  async loadDetail(spuId: string) {
    try {
      // 根据 spuId 查找第一个 sku_id，然后调用 skuDetail
      // product.skuDetail 需要 skuId 参数，这里需要先获取 sku 列表
      // 简化处理：调用 product.spuList 获取该分类下的所有 SPU
      const storeName = app.globalData.boundStoreName || '';
      const data = await callClientApi('product.spuList', { storeName });
      const spuList = data?.spuList || [];
      const spu = spuList.find((s: any) => s.spu_id === spuId);

      if (!spu) {
        throw new Error('商品不存在');
      }

      this.setData({
        spu: {
          spu_id: spu.spu_id,
          name: spu.name,
          big_category: spu.big_category,
          cover_image: spu.cover_image,
          description: spu.description || ''
        },
        skuList: (spu.skuList || []).map((sku: any) => ({
          sku_id: sku.sku_id,
          sku_display_name: sku.sku_display_name,
          price: sku.originalPrice || 0,
          session_count: sku.sessionCount,
          product_type: sku.product_type
        }))
      });
      wx.setNavigationBarTitle({ title: spu.name || '服务详情' });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async loadDefaultStaff() {
    try {
      const data = await callClientApi('staff.default', {});
      if (data?.mainStaffId) {
        this.setData({
          selectedStaffWfId: data.mainStaffId,
          selectedStaffName: data.mainStaffName || '',
        });
      }
    } catch {
      // 获取默认美容师失败不影响主流程
    }
  },

  async loadStaffList() {
    // 优先用 globalData，其次用本地缓存
    const storeName = app.globalData.boundStoreName || wx.getStorageSync('boundStoreName');
    if (!storeName) return;
    this.setData({ staffListLoading: true });
    try {
      const data = await callClientApi('staff.list', { storeName });
      const staffList: Staff[] = (data?.staffList || []).map((s: any) => ({
        staff_wf_id: s.staff_id,
        staff_id: s.staff_id,
        name: s.name,
        position: s.position
      }));
      this.setData({ staffList });
    } catch {
      // 美容师加载失败不影响主流程
    } finally {
      this.setData({ staffListLoading: false });
    }
  },

  onSkuTap(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const sku = this.data.skuList.find(s => s.sku_id === skuId) || null;
    this.setData({ selectedSku: sku });
  },

  onSelectStaff() {
    this.setData({ showStaffPopup: true });
    // 列表为空时重试加载（boundStoreName 可能在 onLoad 时尚未就绪）
    if (this.data.staffList.length === 0 && !this.data.staffListLoading) {
      this.loadStaffList();
    }
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

  onAddToCart() {
    const { selectedSku, spu } = this.data;
    if (!selectedSku) {
      Toast('请先选择规格');
      return;
    }

    addToCart({
      skuId: selectedSku.sku_id,
      spuId: spu.spu_id,
      spuName: spu.name,
      skuDisplayName: selectedSku.sku_display_name,
      coverImage: spu.cover_image,
      price: selectedSku.price,
      bigCategory: spu.big_category,
      productType: selectedSku.product_type,
    });

    this.setData({ cartCount: getCartCount() });
    Toast.success('已加入购物车');
  },

  onCartTap() {
    wx.navigateTo({ url: '/pages/cart/cart' });
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
