// pages/product-detail/product-detail.ts — 商品详情
import { callStaffApi } from '../../utils/cloud';
const app = getApp<IAppOption>();

interface Spu {
  spu_id: string;
  name: string;
  big_category: string;
  cover_image: string;
  description: string;
  promotionSchemeId: string;
  promotionSchemeName: string;
}

interface Sku {
  sku_id: string;
  sku_display_name: string;
  price: number;
  session_count: number | null;
  product_type: string;
  workfine_item_id: string;
}

Page({
  data: {
    spu: {} as Spu,
    skuList: [] as Sku[],
    selectedSku: null as Sku | null,
    quantity: 1,
    isLoading: true,
    isPromo: false,
  },

  onLoad(options) {
    const { spuId } = options as { spuId: string };
    if (!spuId) {
      wx.navigateBack();
      return;
    }
    this.loadDetail(spuId);
  },

  async loadDetail(spuId: string) {
    try {
      const data = await callStaffApi<any>('product.spuDetail', { spuId });
      const spu = data?.spu;

      if (!spu) {
        throw new Error('商品不存在');
      }

      const isPromo = spu.big_category === '促销方案';

      this.setData({
        spu: {
          spu_id: spu.spu_id,
          name: spu.name,
          big_category: spu.big_category,
          cover_image: spu.cover_image,
          description: spu.description || '',
          promotionSchemeId: spu.promotionSchemeId || '',
          promotionSchemeName: spu.promotionSchemeName || '',
        },
        isPromo,
        skuList: (spu.skuList || []).map((sku: any) => ({
          sku_id: sku.sku_id,
          sku_display_name: sku.sku_display_name || sku.itemName || '',
          price: Number(sku.originalPrice) || 0,
          session_count: sku.sessionCount != null ? Number(sku.sessionCount) : null,
          product_type: sku.product_type,
          workfine_item_id: sku.workfine_item_id,
        })),
      });
      wx.setNavigationBarTitle({ title: spu.name || '商品详情' });
    } catch {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSkuTap(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const sku = this.data.skuList.find(s => s.sku_id === skuId) || null;
    this.setData({ selectedSku: sku, quantity: 1 });
  },

  onQuantityChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ quantity: e.detail as unknown as number });
  },

  _buildCartItem(directCheckout: boolean) {
    const { selectedSku, spu, quantity } = this.data;
    if (!selectedSku) return null;
    return {
      spuId: spu.spu_id,
      skuId: selectedSku.sku_id,
      spuName: spu.name,
      specName: selectedSku.sku_display_name,
      price: selectedSku.price,
      quantity,
      sessionCount: selectedSku.session_count || 0,
      productType: selectedSku.product_type || spu.big_category,
      workfineItemId: selectedSku.workfine_item_id,
      directCheckout,
    };
  },

  onAddToCart() {
    const { selectedSku } = this.data;
    if (!selectedSku) {
      wx.showToast({ title: '请先选择规格', icon: 'none' });
      return;
    }
    const item = this._buildCartItem(false);
    if (!item) return;
    app.globalData.pendingCartItem = item;
    wx.navigateBack();
  },

  onSubmit() {
    const { selectedSku } = this.data;
    if (!selectedSku) {
      wx.showToast({ title: '请先选择规格', icon: 'none' });
      return;
    }
    const item = this._buildCartItem(true);
    if (!item) return;
    app.globalData.pendingCartItem = item;
    wx.navigateBack();
  },
});
