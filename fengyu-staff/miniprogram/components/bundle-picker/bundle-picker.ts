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
  productType: string;
  isShengmei: boolean;
  /** mall_product_skus.bundle_price — 套餐内单价（落 unit_real_price） */
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

/** 展示用 SKU（带选中态） */
interface DisplaySku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  bundlePrice: number;
  selected: boolean;
}

/** 展示用分组 */
interface DisplayGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
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

Component({
  properties: {
    /** 套餐 SPU 列表（每个 group 内嵌完整 SKU 详情） */
    bundles: {
      type: Array,
      value: [] as BundleSpu[],
    },
  },

  data: {
    selectedBundleId: '' as string,
    /** groupSelections[groupId] = Set<skuId>，为了 WXML 渲染方便用数组 */
    groupSelections: {} as Record<number, string[]>,
    selectedView: null as SelectedBundleView | null,
    totalSelected: 0,
    canSubmit: false,
  },

  methods: {
    onSelectBundle(e: WechatMiniprogram.TouchEvent) {
      const productId = e.currentTarget.dataset.productId as string;
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === productId);
      if (!bundle) return;

      const groupSelections: Record<number, string[]> = {};
      for (const g of bundle.groups) {
        groupSelections[g.id] = [];
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

    onToggleSku(e: WechatMiniprogram.TouchEvent) {
      const { groupId, skuId } = e.currentTarget.dataset as { groupId: number; skuId: string };
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle) return;
      const group = bundle.groups.find(g => g.id === Number(groupId));
      if (!group) return;

      const selections = { ...this.data.groupSelections };
      const cur = selections[group.id] ? [...selections[group.id]] : [];
      const idx = cur.indexOf(skuId);
      if (idx >= 0) {
        cur.splice(idx, 1);
      } else {
        // pickCount 非空时校验上限
        if (group.pickCount != null && cur.length >= group.pickCount) {
          wx.showToast({
            title: `该组最多选 ${group.pickCount} 项`,
            icon: 'none',
          });
          return;
        }
        cur.push(skuId);
      }
      selections[group.id] = cur;
      const selectedView = this._buildView(bundle, selections);
      this.setData({ groupSelections: selections, selectedView });
      this._refreshCanSubmit(bundle, selections);
    },

    onAddToCart() {
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle || !this.data.canSubmit) return;

      // 按"组 → 选中 sku"展平，每行 unitPrice = sku.bundlePrice（与 client/admin 一致）
      const cartItems: CartItemOut[] = [];
      for (const g of bundle.groups) {
        const picked = this.data.groupSelections[g.id] || [];
        for (const skuId of picked) {
          const sku = g.skus.find(s => s.skuId === skuId);
          if (!sku) continue;
          cartItems.push({
            spuId: skuId,
            skuId,
            spuName: sku.specName,
            specName: sku.specName,
            price: sku.bundlePrice,
            quantity: 1,
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

      this.triggerEvent('select', { cartItems, bundleName: bundle.name });
    },

    /** 根据 pickCount + 已选数判断是否可提交 */
    _refreshCanSubmit(bundle: BundleSpu, selections: Record<number, string[]>) {
      let ok = true;
      let total = 0;
      for (const g of bundle.groups) {
        const picked = (selections[g.id] || []).length;
        total += picked;
        if (g.pickCount == null) {
          // 全选：至少 1 个（避免空选）
          if (picked === 0) ok = false;
        } else {
          if (picked !== g.pickCount) ok = false;
        }
      }
      this.setData({ canSubmit: ok && total > 0, totalSelected: total });
    },

    _buildView(bundle: BundleSpu, selections: Record<number, string[]>): SelectedBundleView {
      const groups: DisplayGroup[] = bundle.groups.map(g => {
        const total = g.skus.length;
        const picked = selections[g.id] || [];
        return {
          id: g.id,
          groupName: g.groupName,
          pickCount: g.pickCount,
          pickCountLabel: g.pickCount == null
            ? `全选 ${total} 项`
            : `${total} 选 ${g.pickCount}`,
          skus: g.skus.map(s => ({
            skuId: s.skuId,
            specName: s.specName,
            sessionCount: s.sessionCount,
            bundlePrice: s.bundlePrice,
            selected: picked.indexOf(s.skuId) >= 0,
          })),
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
