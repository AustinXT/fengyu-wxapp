// pages/service-detail/service-detail.ts
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
  /** 标价（price），会员价分流：price=标价、special_price=会员价 */
  price: number;
  /** 会员价（special_price，可空） */
  special_price: number | null;
  session_count: number | null;
  product_type: string;
  /** PR-D：来自 product_categories（DB 驱动 tag 渲染） */
  product_kind?: string;
  /** PR-D：一级 kind 行的 display_color HEX */
  kind_display_color?: string;
  // 充值卡剥离 SKU 化（2026-05-20）：商城 SKU 不含充值卡
}

interface BundleSku {
  sku_id: string;
  spec_name: string;
  bundle_price: number;       // mall_product_skus.bundle_price (套餐价)
  list_price: number;         // 原价（special_price ?? price）兜底展示
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
  /** 是否已选（qty>0） */
  selected: boolean;
  /** 选 N 项组：当前数量（全选组恒 0/1） */
  qty: number;
  /** 选 N 项组：步进器上限（= qty + 组内剩余可选额度）；全选组恒 1 */
  maxQty: number;
}

interface BundleViewGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  isAllSelect: boolean;
  /** 'pick' = 选 N 项（数量步进器）；'all' = 全选（锁定复选框） */
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
    // 组合套餐多选状态
    bundleGroupsRaw: [] as BundleGroupRaw[],
    bundleSkuMap: {} as Record<string, BundleSku>,
    // 选择状态：bundleSelections[groupId][skuId] = 数量（选 N 项支持同一 SKU 多件；全选组恒 1）
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

  /** 初始化套餐多选状态：从 skuList 抽 bundle_price 建 map；全选组 pickCount=null 预填所有 SKU */
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
        // 划线价用套餐标价单价（bundle_list_price 下沉副本）；缺失回退 SKU 原价
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
      // 全选组（pick_count IS NULL）→ 默认每项 1 件（锁定全选）；选 N 项 → 空
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

  /** 根据当前 selections 重算视图 + canSubmit + totalPrice */
  _refreshBundleView() {
    const { bundleGroupsRaw, bundleSelections, bundleSkuMap } = this.data;
    const viewGroups: BundleViewGroup[] = [];
    let canSubmit = true;
    let total = 0;
    let totalSelected = 0;

    for (const g of bundleGroupsRaw) {
      const picked = bundleSelections[g.id] || {};
      const isAllSelect = g.pickCount == null;
      // 组内数量合计（选 N 项按数量统计，非种类数）
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
          // 选 N 项步进器上限 = 当前数量 + 组内剩余可选额度；全选组恒 1
          maxQty: isAllSelect ? 1 : qty + ((g.pickCount as number) - groupTotal),
        };
      });
      totalSelected += groupTotal;
      total += g.skuIds.reduce((s, id) => s + (bundleSkuMap[id]?.bundle_price ?? 0) * (picked[id] || 0), 0);

      let hint = '';
      if (isAllSelect) {
        hint = `全选 ${g.skuIds.length} 项`;
        // 全选组：每项都须选中（防止后台配错空组）
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
      // 获取默认美容师失败不影响主流程
    }
  },

  async loadStaffList() {
    // 优先用 globalData，其次用本地缓存
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
      // 美容师加载失败不影响主流程
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

  /** 选 N 项组数量步进：同一 SKU 可选多件，组内合计夹紧到 pickCount */
  onBundleSkuQtyChange(e: WechatMiniprogram.CustomEvent) {
    const { groupId, skuId } = e.currentTarget.dataset as { groupId: number | string; skuId: string };
    const gid = Number(groupId);
    const group = this.data.bundleGroupsRaw.find(g => g.id === gid);
    if (!group || group.pickCount == null) return; // 仅选 N 项组走此 handler

    const cur = { ...(this.data.bundleSelections[gid] || {}) };
    const prevQty = cur[skuId] || 0;
    const otherTotal = Object.entries(cur).reduce((s, [k, v]) => s + (k === skuId ? 0 : v), 0);
    const allowed = group.pickCount - otherTotal; // 该 SKU 可达上限
    const raw = parseInt(e.detail as unknown as string) || 0;
    const next = Math.max(0, Math.min(raw, allowed));
    // van-stepper 初始化会触发一次 change；值未变则跳过（避免无谓 setData）
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
    // 列表为空时重试加载（boundStoreName 可能在 onLoad 时尚未就绪）
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
    // 套餐：复用 onSubmit 直接下单（不走购物车）
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
      // PR-D：DB 驱动 tag 渲染（spuDetail SQL JOIN product_categories 后注入）
      productKind: selectedSku.product_kind || undefined,
      kindDisplayColor: selectedSku.kind_display_color || undefined,
      // 2026-04-26 capability 化：充值卡 SKU 已在云函数侧过滤，此处兜底
      // 充值卡剥离 SKU 化（2026-05-20）：商城 SKU 已不含充值卡
    }, quantity);

    this.setData({ cartCount: getCartCount() });
    Toast.success('已加入购物车');
  },

  onCartTap() {
    wx.navigateTo({ url: '/pagesShop/shopping-cart/shopping-cart' });
  },

  onSubmit() {
    const { spu, selectedStaffWfId, selectedStaffName } = this.data;

    // 套餐分支：校验所有组配额满足，装配 items 后跳 checkout
    if (spu.is_bundle) {
      if (!this.data.bundleCanSubmit) {
        // 未满足配额：打开弹层让用户继续选
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

    // 非套餐分支：保持原有单 SKU 流
    const { selectedSku, quantity } = this.data;
    if (!selectedSku) {
      Toast.fail('请先选择规格');
      return;
    }
    const url = `/pagesOrder/checkout/checkout?skuId=${selectedSku.sku_id}&productId=${encodeURIComponent(spu.product_id)}&spuName=${encodeURIComponent(spu.name)}&staffWfId=${selectedStaffWfId}&staffName=${encodeURIComponent(selectedStaffName)}&quantity=${quantity}`;
    wx.navigateTo({ url });
  },

  /** 收集套餐选中的所有 SKU 装配成 checkout items */
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
