// components/bundle-picker/bundle-picker.ts
// PR-B §2.2 — 组合套餐选择器（N 选 M）
// 左侧：bundle SPU 列表（is_bundle=true）
// 右侧：选中套餐后展开 mall_bundle_groups，每组 pickCount 控制多选上限
// 底部"加入购物车"：组装 cartItems（每行带 refBundleId），触发 select 事件

interface BundleGroup {
  id: number;
  groupName: string;
  pickCount: number | null; // null = 全选
  skuIds: string[];
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

interface SkuMini {
  skuId: string;
  specName: string;
  productKind: string;
  productType: string;
  price: number;
  specialPrice: number | null;
  sessionCount: number | null;
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

/** 展示用分组（groupSkus 已解析为 sku 对象） */
interface DisplayGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  pickCountLabel: string;
  skus: SkuMini[];
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
    /** 套餐 SPU 列表 */
    bundles: {
      type: Array,
      value: [] as BundleSpu[],
    },
    /** SKU 字典（spuId 按 sku_id 索引；由父页面传入） */
    skuMap: {
      type: Object,
      value: {} as Record<string, SkuMini>,
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
      const selectedView = this._buildView(bundle);
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
      this.setData({ groupSelections: selections });
      this._refreshCanSubmit(bundle, selections);
    },

    onAddToCart() {
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle || !this.data.canSubmit) return;

      const skuMap = this.data.skuMap as Record<string, SkuMini>;
      const allSkuIds: string[] = [];
      for (const g of bundle.groups) {
        const picked = this.data.groupSelections[g.id] || [];
        allSkuIds.push(...picked);
      }
      if (allSkuIds.length === 0) return;

      // TODO(PR-C 对齐云函数): 当前按"套餐价 / 选中SKU数 平均分"占位摊价；
      //   云函数 create 收到 refBundleId 分组后应按反比例分摊到 unit_real_price。
      const bundlePrice = Number(bundle.specialPrice ?? bundle.price) || 0;
      const n = allSkuIds.length;
      const base = Math.floor((bundlePrice / n) * 100) / 100;
      const remainder = Math.round((bundlePrice - base * n) * 100) / 100;

      const cartItems: CartItemOut[] = allSkuIds.map((skuId, i) => {
        const sku = skuMap[skuId];
        const unitPrice = base + (i === 0 ? remainder : 0);
        return {
          spuId: skuId,
          skuId,
          spuName: sku?.specName || '',
          specName: sku?.specName || '',
          price: unitPrice,
          quantity: 1,
          discount: 0,
          sessionCount: sku?.sessionCount || 0,
          productType: sku?.productType || '组合套餐',
          workfineItemId: '',
          subtotal: '',
          itemTotal: '',
          refBundleId: bundle.productId,
        };
      });

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

    _buildView(bundle: BundleSpu): SelectedBundleView {
      const skuMap = this.data.skuMap as Record<string, SkuMini>;
      const groups: DisplayGroup[] = bundle.groups.map(g => {
        const total = g.skuIds.length;
        return {
          id: g.id,
          groupName: g.groupName,
          pickCount: g.pickCount,
          pickCountLabel: g.pickCount == null
            ? `全选 ${total} 项`
            : `${total} 选 ${g.pickCount}`,
          skus: g.skuIds
            .map(id => skuMap[id])
            .filter((s): s is SkuMini => !!s),
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
