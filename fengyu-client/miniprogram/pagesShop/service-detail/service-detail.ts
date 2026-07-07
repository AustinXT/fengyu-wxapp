
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount } from '../../utils/cart';
import { callClientApi } from '../../utils/cloud';
import { getIsMember, priceView } from '../../utils/member-pricing';

const app = getApp<IAppOption>();

interface Spu {
  product_id: string;
  name: string;
  category_name: string;
  cover_image: string;
  description: string;
  detail_images?: string[];
  is_bundle: boolean;
  price: number;
  special_price: number | null;
}

interface Sku {
  sku_id: string;
  spec_name: string;
  
  price: number;
  
  special_price: number | null;
  session_count: number | null;
  product_type: string;
  
  product_kind?: string;
  
  kind_display_color?: string;
  
}

interface BundleSku {
  sku_id: string;
  spec_name: string;
  bundle_price: number;       
  list_price: number;         
  session_count: number | null;
  product_type: string;
  group_id: number | null;
}

interface BundleGroupRaw {
  id: number;
  groupName: string;
  pickCount: number | null;
  skuIds: string[];
}

interface BundleViewSku {
  skuId: string;
  specName: string;
  bundlePrice: number;
  sessionCount: number | null;
  
  selected: boolean;
  
  qty: number;
  
  maxQty: number;
}

interface BundleViewGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  isAllSelect: boolean;
  
  mode: 'pick' | 'all';
  selectedCount: number;
  hint: string;
  skus: BundleViewSku[];
}

interface Staff {
  employee_id: string;
  staff_id: string;
  name: string;
  position: string;
  avatarUrl?: string;
}

Page({
  data: {
    spu: {} as Spu,
    skuList: [] as Sku[],
    selectedSku: null as Sku | null,
    quantity: 1,
    isMember: false,
    staffList: [] as Staff[],
    staffListLoading: false,
    selectedStaffWfId: '',
    selectedStaffName: '',
    showStaffPopup: false,
    showSkuPopup: false,
    isLoading: true,
    loadError: false,
    cartCount: 0,
    
    bundleGroupsRaw: [] as BundleGroupRaw[],
    bundleSkuMap: {} as Record<string, BundleSku>,
    
    bundleSelections: {} as Record<number, Record<string, number>>,
    bundleViewGroups: [] as BundleViewGroup[],
    bundleCanSubmit: false,
    bundleTotalPrice: 0,
    bundleSelectedCount: 0,
  },

  _productId: '',

  onLoad(options) {
    const { productId, spuId } = options as { productId?: string; spuId?: string };
    const id = productId || spuId;
    if (!id) {
      wx.navigateBack();
      return;
    }
    this._productId = id;
    this.setData({ isMember: getIsMember() });
    this.loadDetail(id);
    this.loadStaffList();
    this.loadDefaultStaff();
  },

  onShow() {
    this.setData({ cartCount: getCartCount() });
  },

  async loadDetail(productId: string) {
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi('product.spuDetail', { productId });
      const spu = data?.spu;

      if (!spu) {
        throw new Error('商品不存在');
      }

      const isBundle = !!spu.is_bundle;
      const rawSkuList = spu.skuList || [];

      this.setData({
        spu: {
          product_id: spu.product_id,
          name: spu.name,
          category_name: spu.category_name || '',
          cover_image: spu.cover_image,
          description: spu.description || '',
          detail_images: spu.detail_images || [],
          is_bundle: isBundle,
          price: Number(spu.price || 0),
          special_price: spu.special_price != null ? Number(spu.special_price) : null,
        },
        skuList: rawSkuList.map((sku: any) => ({
          sku_id: sku.sku_id,
          spec_name: sku.spec_name,
          price: Number(sku.price || 0),
          special_price: sku.special_price != null ? Number(sku.special_price) : null,
          session_count: sku.session_count,
          product_type: sku.product_type
        }))
      });

      if (isBundle) {
        this._initBundleState(spu.bundleGroups || [], rawSkuList);
      }

      wx.setNavigationBarTitle({ title: spu.name || '服务详情' });
    } catch {
      Toast.fail('加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  
  _initBundleState(bundleGroups: BundleGroupRaw[], rawSkuList: any[]) {
    const skuMap: Record<string, BundleSku> = {};
    for (const s of rawSkuList) {
      const bundlePrice = s.bundle_price != null
        ? Number(s.bundle_price)
        : Number(s.special_price || s.price || 0);
      skuMap[s.sku_id] = {
        sku_id: s.sku_id,
        spec_name: s.spec_name,
        bundle_price: bundlePrice,
        
        list_price: s.bundle_list_price != null
          ? Number(s.bundle_list_price)
          : Number(s.special_price || s.price || 0),
        session_count: s.session_count,
        product_type: s.product_type,
        group_id: s.bundle_group_id != null ? Number(s.bundle_group_id) : null,
      };
    }

    const selections: Record<number, Record<string, number>> = {};
    for (const g of bundleGroups) {
      
      if (g.pickCount == null) {
        const m: Record<string, number> = {};
        for (const id of g.skuIds) m[id] = 1;
        selections[g.id] = m;
      } else {
        selections[g.id] = {};
      }
    }

    this.setData({
      bundleGroupsRaw: bundleGroups,
      bundleSkuMap: skuMap,
      bundleSelections: selections,
    });
    this._refreshBundleView();
  },

  
  _refreshBundleView() {
    const { bundleGroupsRaw, bundleSelections, bundleSkuMap } = this.data;
    const viewGroups: BundleViewGroup[] = [];
    let canSubmit = true;
    let total = 0;
    let totalSelected = 0;

    for (const g of bundleGroupsRaw) {
      const picked = bundleSelections[g.id] || {};
      const isAllSelect = g.pickCount == null;
      
      const groupTotal = g.skuIds.reduce((s, id) => s + (picked[id] || 0), 0);
      const skus: BundleViewSku[] = g.skuIds.map(skuId => {
        const sku = bundleSkuMap[skuId];
        const qty = picked[skuId] || 0;
        return {
          skuId,
          specName: sku?.spec_name || skuId,
          bundlePrice: sku?.bundle_price ?? 0,
          sessionCount: sku?.session_count ?? null,
          selected: qty > 0,
          qty,
          
          maxQty: isAllSelect ? 1 : qty + ((g.pickCount as number) - groupTotal),
        };
      });
      totalSelected += groupTotal;
      total += g.skuIds.reduce((s, id) => s + (bundleSkuMap[id]?.bundle_price ?? 0) * (picked[id] || 0), 0);

      let hint = '';
      if (isAllSelect) {
        hint = `全选 ${g.skuIds.length} 项`;
        
        if (g.skuIds.length === 0 || groupTotal !== g.skuIds.length) canSubmit = false;
      } else {
        hint = `${g.skuIds.length} 选 ${g.pickCount}（已选 ${groupTotal}/${g.pickCount}）`;
        if (groupTotal !== g.pickCount) canSubmit = false;
      }

      viewGroups.push({
        id: g.id,
        groupName: g.groupName,
        pickCount: g.pickCount,
        isAllSelect,
        mode: isAllSelect ? 'all' : 'pick',
        selectedCount: groupTotal,
        hint,
        skus,
      });
    }

    this.setData({
      bundleViewGroups: viewGroups,
      bundleCanSubmit: canSubmit && bundleGroupsRaw.length > 0,
      bundleTotalPrice: Math.round(total * 100) / 100,
      bundleSelectedCount: totalSelected,
    });
  },

  onPullDownRefresh() {
    if (this._productId) {
      this.loadDetail(this._productId).finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
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
      
    }
  },

  async loadStaffList() {
    
    const storeId = app.globalData.boundStoreId || wx.getStorageSync('boundStoreId');
    if (!storeId) return;
    this.setData({ staffListLoading: true });
    try {
      const data = await callClientApi('staff.list', { storeId });
      const staffList: Staff[] = (data?.staffList || []).map((s: any) => ({
        employee_id: s.staff_id,
        staff_id: s.staff_id,
        name: s.name,
        position: s.position,
        avatarUrl: s.avatarUrl || '',
      }));
      this.setData({ staffList });
    } catch {
      
    } finally {
      this.setData({ staffListLoading: false });
    }
  },

  onOpenSkuPopup() {
    this.setData({ showSkuPopup: true });
  },

  onCloseSkuPopup() {
    this.setData({ showSkuPopup: false });
  },

  onSkuTap(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const sku = this.data.skuList.find(s => s.sku_id === skuId) || null;
    this.setData({ selectedSku: sku, quantity: 1 });
  },

  
  onBundleSkuQtyChange(e: WechatMiniprogram.CustomEvent) {
    const { groupId, skuId } = e.currentTarget.dataset as { groupId: number | string; skuId: string };
    const gid = Number(groupId);
    const group = this.data.bundleGroupsRaw.find(g => g.id === gid);
    if (!group || group.pickCount == null) return; 

    const cur = { ...(this.data.bundleSelections[gid] || {}) };
    const prevQty = cur[skuId] || 0;
    const otherTotal = Object.entries(cur).reduce((s, [k, v]) => s + (k === skuId ? 0 : v), 0);
    const allowed = group.pickCount - otherTotal; 
    const raw = parseInt(e.detail as unknown as string) || 0;
    const next = Math.max(0, Math.min(raw, allowed));
    
    if (next === prevQty) return;
    if (next > 0) cur[skuId] = next;
    else delete cur[skuId];
    this.setData({ bundleSelections: { ...this.data.bundleSelections, [gid]: cur } });
    this._refreshBundleView();
  },

  onQuantityChange(e: WxEvent<number>) {
    this.setData({ quantity: e.detail });
  },

  onSelectStaff() {
    this.setData({ showStaffPopup: true });
    
    if (this.data.staffList.length === 0 && !this.data.staffListLoading) {
      this.loadStaffList();
    }
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.CustomEvent<{ wfId: string; name: string }>) {
    const { wfId, name } = e.detail;
    this.setData({
      selectedStaffWfId: wfId,
      selectedStaffName: name,
      showStaffPopup: false,
    });
  },

  onAddToCart() {
    const { selectedSku, spu, quantity } = this.data;
    
    if (spu.is_bundle) {
      this.onSubmit();
      return;
    }
    if (!selectedSku) {
      Toast.fail('请先选择规格');
      return;
    }

    const pv = priceView(this.data.isMember, selectedSku.special_price, selectedSku.price);
    addToCart({
      skuId: selectedSku.sku_id,
      spuId: spu.product_id,
      spuName: spu.name,
      skuDisplayName: selectedSku.spec_name,
      coverImage: spu.cover_image,
      price: pv.display,
      listPrice: pv.strike ?? pv.display,
      bigCategory: spu.category_name,
      productType: selectedSku.product_type,
      
      productKind: selectedSku.product_kind || undefined,
      kindDisplayColor: selectedSku.kind_display_color || undefined,
      
      
    }, quantity);

    this.setData({ cartCount: getCartCount() });
    Toast.success('已加入购物车');
  },

  onCartTap() {
    wx.navigateTo({ url: '/pagesShop/shopping-cart/shopping-cart' });
  },

  onSubmit() {
    const { spu, selectedStaffWfId, selectedStaffName } = this.data;

    
    if (spu.is_bundle) {
      if (!this.data.bundleCanSubmit) {
        
        this.setData({ showSkuPopup: true });
        Toast.fail('请完成套餐选择');
        return;
      }
      const items = this._collectBundleItems();
      if (items.length === 0) {
        Toast.fail('请完成套餐选择');
        return;
      }
      wx.setStorageSync('bundleCheckoutItems', items);
      const url = `/pagesOrder/checkout/checkout`
        + `?bundleProductId=${encodeURIComponent(spu.product_id)}`
        + `&spuName=${encodeURIComponent(spu.name)}`
        + `&staffWfId=${selectedStaffWfId}`
        + `&staffName=${encodeURIComponent(selectedStaffName)}`;
      this.setData({ showSkuPopup: false });
      wx.navigateTo({ url });
      return;
    }

    
    const { selectedSku, quantity } = this.data;
    if (!selectedSku) {
      Toast.fail('请先选择规格');
      return;
    }
    const url = `/pagesOrder/checkout/checkout?skuId=${selectedSku.sku_id}&productId=${encodeURIComponent(spu.product_id)}&spuName=${encodeURIComponent(spu.name)}&staffWfId=${selectedStaffWfId}&staffName=${encodeURIComponent(selectedStaffName)}&quantity=${quantity}`;
    wx.navigateTo({ url });
  },

  
  _collectBundleItems() {
    const { bundleSelections, bundleSkuMap, spu } = this.data;
    const items: Array<{
      skuId: string;
      spuName: string;
      skuDisplayName: string;
      coverImage: string;
      price: number;
      quantity: number;
      sessionCount: number | null;
    }> = [];
    for (const groupId of Object.keys(bundleSelections)) {
      const picked = bundleSelections[Number(groupId)] || {};
      for (const skuId of Object.keys(picked)) {
        const qty = picked[skuId] || 0;
        if (qty <= 0) continue;
        const sku = bundleSkuMap[skuId];
        if (!sku) continue;
        items.push({
          skuId,
          spuName: spu.name,
          skuDisplayName: sku.spec_name,
          coverImage: spu.cover_image,
          price: sku.bundle_price,
          quantity: qty,
          sessionCount: sku.session_count,
        });
      }
    }
    return items;
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: this.data.spu.name || '凤御服务', path: `/pages/home/home${invSuffix}` };
  },
});
