// components/bundle-picker/bundle-picker.ts
// PR-B §2.2 — 组合套餐选择器（N 选 M）
// 左侧：bundle SPU 列表（is_bundle=true）
// 右侧：选中套餐后展开 mall_bundle_groups，每组 pickCount 控制多选上限
// 底部"加入购物车"：组装 cartItems（每行带 refBundleId），触发 select 事件
//
// 与 client `product.spuDetail`、admin `getProductsByKind('__bundle__')` 数据形态对齐：
// 每个 group 内嵌完整 SKU 详情，组件不依赖任何外部 skuMap 字典。

interface BundleGroupSku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  purchaseLimit?: number | null;
  productType: string;
  isShengmei: boolean;
  /** 套餐成交价（mall_product_skus.bundle_price = 组会员价 ?? 标价）→ 落 unit_real_price */
  bundlePrice: number;
  listPrice: number;
  listSpecialPrice: number | null;
  sortOrder: number;
}

interface BundleGroup {
  id: number;
  groupName: string;
  pickCount: number | null; // null = 全选
  skus: BundleGroupSku[];
}

interface BundleSpu {
  productId: string;
  name: string;
  coverImage: string | null;
  description: string | null;
  price: number;
  specialPrice: number | null;
  groups: BundleGroup[];
}

interface CartItemOut {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  price: number;
  /** 套餐标价单价（mall_product_skus.bundle_list_price）→ 落 unit_price 划线；与成交价 price 区分 */
  listPrice: number;
  purchaseLimit?: number | null;
  quantity: number;
  discount: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  subtotal: string;
  itemTotal: string;
  /** 前端临时字段：同一套餐的多行共享此 id，云函数 create 侧按此分组摊价 */
  refBundleId: string;
}

/** 展示用 SKU（带选中态 / 数量） */
interface DisplaySku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  bundlePrice: number;
  listPrice: number;
  purchaseLimit?: number | null;
  /** 全选组：是否勾选 */
  selected: boolean;
  /** 选N项组：当前数量 */
  qty: number;
  /** 选N项组：该 SKU 步进器上限（= qty + 组内剩余可选额度） */
  maxQty: number;
}

/** 展示用分组 */
interface DisplayGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  /** 'pick' = 选N项（数量步进器）；'all' = 全选（勾选 toggle） */
  mode: 'pick' | 'all';
  pickCountLabel: string;
  skus: DisplaySku[];
}

/** 选中套餐展示视图 */
interface SelectedBundleView {
  productId: string;
  name: string;
  displayPrice: number;
  groups: DisplayGroup[];
}

function purchaseLimitMessage(sku: { specName: string; purchaseLimit?: number | null }): string {
  return `${sku.specName}每单最多可购买 ${sku.purchaseLimit} 件`;
}

function findCartPurchaseLimitViolation(cartItems: CartItemOut[]): CartItemOut | null {
  const totals = new Map<string, { item: CartItemOut; quantity: number }>();
  for (const item of cartItems) {
    const current = totals.get(item.skuId);
    totals.set(item.skuId, {
      item,
      quantity: (current?.quantity || 0) + item.quantity,
    });
  }
  for (const row of totals.values()) {
    if (row.item.purchaseLimit != null && row.quantity > row.item.purchaseLimit) return row.item;
  }
  return null;
}

Component({
  properties: {
    /** 套餐 SPU 列表（每个 group 内嵌完整 SKU 详情） */
    bundles: {
      type: Array,
      value: [] as BundleSpu[],
      observer() {
        (this as unknown as { _refreshFiltered(): void })._refreshFiltered();
      },
    },
  },

  data: {
    /** 套餐名称模糊查询关键词 */
    keyword: '',
    /** 按 keyword 过滤后的套餐列表（列表态渲染数据源） */
    filteredBundles: [] as BundleSpu[],
    selectedBundleId: '' as string,
    /** groupSelections[groupId][skuId] = 数量（选N项支持同一 SKU 多次；全选组数量恒 0/1） */
    groupSelections: {} as Record<number, Record<string, number>>,
    selectedView: null as SelectedBundleView | null,
    totalSelected: 0,
    canSubmit: false,
  },

  methods: {
    // ===== 套餐名称模糊查询 =====

    onKeywordChange(e: WechatMiniprogram.CustomEvent) {
      this.setData({ keyword: ((e.detail as unknown as string) || '').trim() });
      this._refreshFiltered();
    },

    onKeywordClear() {
      this.setData({ keyword: '' });
      this._refreshFiltered();
    },

    /** 按 keyword（大小写不敏感）过滤 bundles → filteredBundles */
    _refreshFiltered() {
      const kw = this.data.keyword.trim().toLowerCase();
      const all = this.data.bundles as BundleSpu[];
      const filtered = kw
        ? all.filter(b => (b.name || '').toLowerCase().includes(kw))
        : all;
      this.setData({ filteredBundles: filtered });
    },

    onSelectBundle(e: WechatMiniprogram.TouchEvent) {
      const productId = e.currentTarget.dataset.productId as string;
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === productId);
      if (!bundle) return;

      const groupSelections: Record<number, Record<string, number>> = {};
      for (const g of bundle.groups) {
        groupSelections[g.id] = {};
      }
      const selectedView = this._buildView(bundle, groupSelections);
      this.setData({
        selectedBundleId: productId,
        groupSelections,
        selectedView,
      });
      this._refreshCanSubmit(bundle, groupSelections);
    },

    onBackToList() {
      this.setData({
        selectedBundleId: '',
        groupSelections: {},
        selectedView: null,
        canSubmit: false,
        totalSelected: 0,
      });
    },

    /** 全选组（pickCount=null）勾选 toggle：数量 0/1 */
    onToggleSku(e: WechatMiniprogram.TouchEvent) {
      const { groupId, skuId } = e.currentTarget.dataset as { groupId: number; skuId: string };
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle) return;
      const group = bundle.groups.find(g => g.id === Number(groupId));
      if (!group || group.pickCount != null) return; // 仅全选组走此 handler

      const selections = { ...this.data.groupSelections };
      const cur = { ...(selections[group.id] || {}) };
      if (cur[skuId]) {
        delete cur[skuId];
      } else {
        cur[skuId] = 1;
      }
      selections[group.id] = cur;
      const selectedView = this._buildView(bundle, selections);
      this.setData({ groupSelections: selections, selectedView });
      this._refreshCanSubmit(bundle, selections);
    },

    /** 选N项组（pickCount!=null）数量步进：同一 SKU 可选多次，组内合计夹紧到 pickCount */
    onSkuQtyChange(e: WechatMiniprogram.CustomEvent) {
      const { groupId, skuId } = e.currentTarget.dataset as { groupId: number; skuId: string };
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle) return;
      const group = bundle.groups.find(g => g.id === Number(groupId));
      if (!group || group.pickCount == null) return;

      const selections = { ...this.data.groupSelections };
      const cur = { ...(selections[group.id] || {}) };
      const prevQty = cur[skuId] || 0;
      const otherTotal = Object.entries(cur).reduce((s, [k, v]) => s + (k === skuId ? 0 : v), 0);
      const sku = group.skus.find(s => s.skuId === skuId);
      const limit = sku?.purchaseLimit != null ? Number(sku.purchaseLimit) : null;
      const allowedByGroup = group.pickCount - otherTotal;
      const allowed = limit != null ? Math.min(allowedByGroup, limit) : allowedByGroup; // 该 SKU 可达上限
      const raw = parseInt(e.detail as unknown as string) || 0;
      if (sku && limit != null && raw > limit) {
        wx.showToast({ title: purchaseLimitMessage(sku), icon: 'none' });
      }
      const next = Math.max(0, Math.min(raw, allowed));
      // van-stepper 初始化会触发一次 change；值未变则不重渲染（避免无谓 setData）
      if (next === prevQty) return;
      if (next > 0) cur[skuId] = next;
      else delete cur[skuId];
      selections[group.id] = cur;
      const selectedView = this._buildView(bundle, selections);
      this.setData({ groupSelections: selections, selectedView });
      this._refreshCanSubmit(bundle, selections);
    },

    onAddToCart() {
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle || !this.data.canSubmit) return;

      // 按"组 → 选中 sku + 数量"展平，每行 unitPrice = sku.bundlePrice（与 client/admin 一致）。
      // 选N项支持同一 SKU 多次 → quantity=该 SKU 的已选数量（后端 B2 拆行规则按类型落库）。
      const cartItems: CartItemOut[] = [];
      for (const g of bundle.groups) {
        const picked = this.data.groupSelections[g.id] || {};
        for (const sku of g.skus) {
          const qty = picked[sku.skuId] || 0;
          if (qty <= 0) continue;
          cartItems.push({
            spuId: sku.skuId,
            skuId: sku.skuId,
            spuName: sku.specName,
            specName: sku.specName,
            price: sku.bundlePrice,
            listPrice: sku.listPrice,
            purchaseLimit: sku.purchaseLimit ?? null,
            quantity: qty,
            discount: 0,
            sessionCount: sku.sessionCount || 0,
            productType: sku.productType || '组合套餐',
            workfineItemId: '',
            subtotal: '',
            itemTotal: '',
            refBundleId: bundle.productId,
          });
        }
      }
      if (cartItems.length === 0) return;
      const violation = findCartPurchaseLimitViolation(cartItems);
      if (violation) {
        wx.showToast({ title: purchaseLimitMessage(violation), icon: 'none' });
        return;
      }

      this.triggerEvent('select', { cartItems, bundleName: bundle.name });
    },

    /** 组内已选数量合计（选N项 N 按数量统计，非种类数） */
    _groupTotal(selections: Record<number, Record<string, number>>, groupId: number): number {
      return Object.values(selections[groupId] || {}).reduce((s, q) => s + q, 0);
    },

    /** 根据 pickCount + 已选数量合计判断是否可提交 */
    _refreshCanSubmit(bundle: BundleSpu, selections: Record<number, Record<string, number>>) {
      let ok = true;
      let total = 0;
      for (const g of bundle.groups) {
        const picked = this._groupTotal(selections, g.id);
        total += picked;
        if (g.pickCount == null) {
          // 全选：至少 1 个（避免空选）
          if (picked === 0) ok = false;
        } else {
          // 选N项：数量合计须 === pickCount
          if (picked !== g.pickCount) ok = false;
        }
      }
      this.setData({ canSubmit: ok && total > 0, totalSelected: total });
    },

    _buildView(bundle: BundleSpu, selections: Record<number, Record<string, number>>): SelectedBundleView {
      const groups: DisplayGroup[] = bundle.groups.map(g => {
        const total = g.skus.length;
        const picked = selections[g.id] || {};
        const groupTotal = this._groupTotal(selections, g.id);
        const isPick = g.pickCount != null;
        return {
          id: g.id,
          groupName: g.groupName,
          pickCount: g.pickCount,
          mode: isPick ? 'pick' : 'all',
          pickCountLabel: g.pickCount == null
            ? `全选 ${total} 项`
            : `${total} 选 ${g.pickCount}（已选 ${groupTotal}）`,
          skus: g.skus.map(s => {
            const qty = picked[s.skuId] || 0;
            const groupMaxQty = isPick ? qty + ((g.pickCount as number) - groupTotal) : 1;
            const limit = s.purchaseLimit != null ? Number(s.purchaseLimit) : null;
            return {
              skuId: s.skuId,
              specName: s.specName,
              sessionCount: s.sessionCount,
              bundlePrice: s.bundlePrice,
              listPrice: s.listPrice,
              purchaseLimit: s.purchaseLimit ?? null,
              selected: qty > 0,
              qty,
              // 选N项步进器上限 = 当前数量 + 组内剩余可选额度
              maxQty: limit != null ? Math.min(groupMaxQty, limit) : groupMaxQty,
            };
          }),
        };
      });
      return {
        productId: bundle.productId,
        name: bundle.name,
        displayPrice: Number(bundle.specialPrice ?? bundle.price) || 0,
        groups,
      };
    },
  },
});
