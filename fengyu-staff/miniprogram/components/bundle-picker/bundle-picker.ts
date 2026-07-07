








interface BundleGroupSku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  productType: string;
  isShengmei: boolean;
  
  bundlePrice: number;
  listPrice: number;
  listSpecialPrice: number | null;
  sortOrder: number;
}

interface BundleGroup {
  id: number;
  groupName: string;
  pickCount: number | null; 
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
  
  listPrice: number;
  quantity: number;
  discount: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  subtotal: string;
  itemTotal: string;
  
  refBundleId: string;
}


interface DisplaySku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  bundlePrice: number;
  listPrice: number;
  
  selected: boolean;
  
  qty: number;
  
  maxQty: number;
}


interface DisplayGroup {
  id: number;
  groupName: string;
  pickCount: number | null;
  
  mode: 'pick' | 'all';
  pickCountLabel: string;
  skus: DisplaySku[];
}


interface SelectedBundleView {
  productId: string;
  name: string;
  displayPrice: number;
  groups: DisplayGroup[];
}

Component({
  properties: {
    
    bundles: {
      type: Array,
      value: [] as BundleSpu[],
      observer() {
        (this as unknown as { _refreshFiltered(): void })._refreshFiltered();
      },
    },
  },

  data: {
    
    keyword: '',
    
    filteredBundles: [] as BundleSpu[],
    selectedBundleId: '' as string,
    
    groupSelections: {} as Record<number, Record<string, number>>,
    selectedView: null as SelectedBundleView | null,
    totalSelected: 0,
    canSubmit: false,
  },

  methods: {
    

    onKeywordChange(e: WechatMiniprogram.CustomEvent) {
      this.setData({ keyword: ((e.detail as unknown as string) || '').trim() });
      this._refreshFiltered();
    },

    onKeywordClear() {
      this.setData({ keyword: '' });
      this._refreshFiltered();
    },

    
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

    
    onToggleSku(e: WechatMiniprogram.TouchEvent) {
      const { groupId, skuId } = e.currentTarget.dataset as { groupId: number; skuId: string };
      const bundle = (this.data.bundles as BundleSpu[]).find(b => b.productId === this.data.selectedBundleId);
      if (!bundle) return;
      const group = bundle.groups.find(g => g.id === Number(groupId));
      if (!group || group.pickCount != null) return; 

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
      const allowed = group.pickCount - otherTotal; 
      const raw = parseInt(e.detail as unknown as string) || 0;
      const next = Math.max(0, Math.min(raw, allowed));
      
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

      this.triggerEvent('select', { cartItems, bundleName: bundle.name });
    },

    
    _groupTotal(selections: Record<number, Record<string, number>>, groupId: number): number {
      return Object.values(selections[groupId] || {}).reduce((s, q) => s + q, 0);
    },

    
    _refreshCanSubmit(bundle: BundleSpu, selections: Record<number, Record<string, number>>) {
      let ok = true;
      let total = 0;
      for (const g of bundle.groups) {
        const picked = this._groupTotal(selections, g.id);
        total += picked;
        if (g.pickCount == null) {
          
          if (picked === 0) ok = false;
        } else {
          
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
            return {
              skuId: s.skuId,
              specName: s.specName,
              sessionCount: s.sessionCount,
              bundlePrice: s.bundlePrice,
              listPrice: s.listPrice,
              selected: qty > 0,
              qty,
              
              maxQty: isPick ? qty + ((g.pickCount as number) - groupTotal) : 1,
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
