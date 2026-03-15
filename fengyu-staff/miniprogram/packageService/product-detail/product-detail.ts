// pages/product-detail/product-detail.ts — 商品详情
import { callStaffApi } from '../../utils/cloud';
const app = getApp<IAppOption>();

interface Spu {
  product_id: string;
  name: string;
  product_kind: string;
  cover_image: string;
  description: string;
  is_bundle: boolean;
}

interface Sku {
  sku_id: string;
  spec_name: string;
  price: number;
  session_count: number | null;
  product_type: string;
}

interface RawSku {
  sku_id: string;
  spec_name: string;
  price: number;
  special_price: number | null;
  session_count: number | null;
  product_type: string;
}

interface SpuDetailResponse {
  spu: Spu & { skuList: RawSku[] };
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
      const data = await callStaffApi<SpuDetailResponse>('product.spuDetail', { spuId });
      const spu = data?.spu;

      if (!spu) {
        throw new Error('商品不存在');
      }

      const isPromo = spu.product_kind === '福利活动';

      this.setData({
        spu: {
          product_id: spu.product_id,
          name: spu.name,
          product_kind: spu.product_kind,
          cover_image: spu.cover_image,
          description: spu.description || '',
          is_bundle: spu.is_bundle || false,
        },
        isPromo,
        skuList: (spu.skuList || []).map((sku: RawSku) => ({
          sku_id: sku.sku_id,
          spec_name: sku.spec_name || '',
          price: Number(sku.special_price || sku.price) || 0,
          session_count: sku.session_count != null ? Number(sku.session_count) : null,
          product_type: sku.product_type,
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
      spuId: spu.product_id,
      skuId: selectedSku.sku_id,
      spuName: spu.name,
      specName: selectedSku.spec_name,
      price: selectedSku.price,
      quantity,
      sessionCount: selectedSku.session_count || 0,
      productType: selectedSku.product_type || spu.product_kind,
      workfineItemId: '',
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
