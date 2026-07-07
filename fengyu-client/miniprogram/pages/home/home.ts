
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";
import { callClientApi } from "../../utils/cloud";
import { getCosBase } from "../../utils/cloud-env";
import { getIsMember } from "../../utils/member-pricing";

const app = getApp<IAppOption>();


const CDN_BASE = `${getCosBase()}/fengyu-client`;

interface Banner {
  id: string;
  title: string;
  desc: string;
  bgColor: string;
  image: string;
  link: string;
}

interface CategoryGroup {
  category_id: string;
  category_name: string;
  sort_order: number;
}

interface Category {
  category_id: string;
  category_name: string;
  category_group: string | null;
  category_order: number;
}

interface SpuItem {
  product_id: string;
  name: string;
  category_name: string;
  cover_image: string;
  min_price: string;
  
  strike_min_price?: string;
  is_recommend: boolean;
  skuList?: any[];
}

interface SidebarItem {
  id: string;
  type: "title" | "category";
  label: string;
  categoryKey: string;
  groupKey: string;
}

Page({
  data: {
    searchValue: "",
    isSearching: false,
    searchResults: [] as SpuItem[],
    searchLoading: false,
    boundStoreName: "",
    banners: [] as Banner[],
    currentBanner: 0,

    
    sidebarItems: [] as SidebarItem[],
    activeCategoryKey: "",
    sidebarScrollIntoView: "",

    spuList: [] as SpuItem[],
    isLoading: false,
    loadError: false,
    cartCount: 0,
  },

  
  _allGroups: [] as CategoryGroup[],

  
  _allCategories: [] as Category[],

  
  _spuCache: {} as Record<string, SpuItem[]>,

  
  _allCategoryKeys: [] as string[],

  
  _searchTimer: null as number | null,

  
  _isLoadingNext: false,

  onLoad() {
    this._spuCache = {};
    const storeName = app.globalData.boundStoreName || "";
    this.setData({ boundStoreName: storeName });
    this.loadShopInit();
    this.loadBanners();
    this.updateCartCount();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || "";
    if (storeName !== this.data.boundStoreName) {
      
      clearCart();
      this._spuCache = {};
      this._allGroups = [];
      this._allCategories = [];
      this._allCategoryKeys = [];
      this.setData({
        boundStoreName: storeName,
        sidebarItems: [],
        activeCategoryKey: "",
        spuList: [],
        cartCount: 0,
        isSearching: false,
        searchResults: [],
        searchValue: "",
      });
      this.loadShopInit();
    } else {
      this.updateCartCount();
    }
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  onPullDownRefresh() {
    
    if (this.data.isSearching) {
      this.setData({ isSearching: false, searchResults: [], searchValue: '' });
    }
    this.loadShopInit().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  

  onSearchInput(e: WechatMiniprogram.InputEvent) {
    const value = e.detail.value;
    this.setData({ searchValue: value });

    
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }

    
    if (!value.trim()) {
      if (this.data.isSearching) {
        this.setData({ isSearching: false, searchResults: [], searchLoading: false });
      }
      return;
    }

    
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this._doSearch(value.trim());
    }, 300) as unknown as number;
  },

  
  async onSearchSubmit() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    const value = this.data.searchValue.trim();
    if (!value) {
      if (this.data.isSearching) {
        this.setData({ isSearching: false, searchResults: [] });
      }
      return;
    }
    await this._doSearch(value);
  },

  
  async _doSearch(value: string) {
    this.setData({ isSearching: true, searchLoading: true });

    try {
      
      
      const data = await callClientApi<{ spuList: SpuItem[] }>("product.search", { keyword: value });
      
      const isMember = getIsMember();
      const results = (data?.spuList || []).map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || "0") : (spu.listPriceFrom || spu.priceFrom || "0"),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : "",
      }));
      
      if (this.data.searchValue.trim() === value) {
        this.setData({ searchResults: results, searchLoading: false });
      }
    } catch (err) {
      console.error("_doSearch error:", err);
      if (this.data.searchValue.trim() === value) {
        this.setData({ searchResults: [], searchLoading: false });
      }
    }
  },

  onSearchClear() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this.setData({ isSearching: false, searchResults: [], searchValue: "" });
  },

  
  _findCategoryId(categoryKey: string): string | undefined {
    const cat = this._allCategories.find((c) => c.category_id === categoryKey);
    return cat?.category_id;
  },

  

  onSelectStore() {
    wx.navigateTo({ url: "/pagesStore/store-select/store-select" });
  },

  onScanPay() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        if (res.path) {
          wx.navigateTo({ url: "/" + res.path });
        } else if (res.result) {
          wx.navigateTo({ url: `/pagesOrder/scan-pay/scan-pay?saleOrderId=${encodeURIComponent(res.result)}` });
        }
      },
      fail: () => {
        
      },
    });
  },

  onBannerChange(e: WechatMiniprogram.CustomEvent<{ current: number }>) {
    this.setData({ currentBanner: e.detail.current });
  },

  onBannerTap(e: WechatMiniprogram.TouchEvent) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      wx.navigateTo({
        url,
        fail: () => {
          
          wx.switchTab({ url, fail: () => {} });
        },
      });
    }
  },

  
  onGridTap(e: WechatMiniprogram.TouchEvent) {
    const { type } = e.currentTarget.dataset as { type: string };

    switch (type) {
      case "coupon":
        wx.navigateTo({ url: "/pagesCoupon/my-coupons/my-coupons" });
        break;
      case "treatment":
        wx.navigateTo({ url: "/pagesOrder/treatment-cards/treatment-cards" });
        break;
      case "recharge":
        wx.navigateTo({ url: "/pagesProfile/card-recharge/card-recharge" });
        break;
      case "experience":
        
        wx.navigateTo({ url: "/pagesExperience/list/list" });
        break;
      default:
        break;
    }
  },

  
  onSidebarCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const { key } = e.currentTarget.dataset as { key: string };
    if (key && key !== this.data.activeCategoryKey) {
      this.switchToCategory(key);
    }
  },

  switchToCategory(categoryKey: string) {
    const catItem = this.data.sidebarItems.find((i) => i.categoryKey === categoryKey);
    if (!catItem) return;

    const cached = this._spuCache[categoryKey];

    this.setData({
      activeCategoryKey: categoryKey,
      sidebarScrollIntoView: catItem.id,
      spuList: cached || [],
    });

    if (!cached) {
      this.loadSpuList(categoryKey);
    }
  },

  
  onScrollToLower() {
    if (this._isLoadingNext) return;

    const { activeCategoryKey } = this.data;
    const currentIndex = this._allCategoryKeys.indexOf(activeCategoryKey);
    if (currentIndex < 0 || currentIndex >= this._allCategoryKeys.length - 1) return;

    const nextKey = this._allCategoryKeys[currentIndex + 1];
    this._isLoadingNext = true;

    this.switchToCategory(nextKey);

    
    setTimeout(() => {
      this._isLoadingNext = false;
    }, 500);
  },

  

  async loadBanners() {
    
    try {
      const { count, v } = await callClientApi<{ count: number; v: number }>("config.banners", {});
      if (count > 0) {
        this.setData({
          banners: Array.from({ length: count }, (_, i) => ({
            id: String(i + 1),
            title: "",
            desc: "",
            bgColor: "",
            image: `${CDN_BASE}/banner/banner${i + 1}.jpg?v=${v}`,
            link: "",
          })),
        });
      }
    } catch (err) {
      
      console.warn("[home] loadBanners failed", err);
    }
  },

  async loadShopInit() {
    try {
      this.setData({ isLoading: true, loadError: false });
      const initData = await callClientApi<{ groups?: CategoryGroup[]; categories: Category[]; spuList: any[] }>("product.shopInit", {});

      const groups: CategoryGroup[] = initData?.groups || [];
      const categories: Category[] = initData?.categories || [];
      const spuList: SpuItem[] = initData?.spuList || [];

      
      const isMember = getIsMember();
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || "0") : (spu.listPriceFrom || spu.priceFrom || "0"),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : "",
      }));

      this._allGroups = groups;
      this._allCategories = categories;

      
      this.buildSidebarItems();

      
      const firstCatKey = this._allCategoryKeys[0] || "";
      if (firstCatKey && listWithPrice.length > 0) {
        this._spuCache[firstCatKey] = listWithPrice;
      }

      this.setData({
        activeCategoryKey: firstCatKey,
        spuList: firstCatKey ? (this._spuCache[firstCatKey] || []) : [],
      });

      if (firstCatKey && !this._spuCache[firstCatKey]) {
        this.loadSpuList(firstCatKey);
      }
    } catch (err: any) {
      console.error("loadShopInit error:", err);
      Toast.fail(err?.message || "加载失败");
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  buildSidebarItems() {
    const items: SidebarItem[] = [];
    const allCategoryKeys: string[] = [];
    let idx = 0;

    if (this._allGroups.length > 0) {
      
      for (const group of this._allGroups) {
        const children = this._allCategories.filter(c => c.category_group === group.category_name);
        if (children.length === 0) continue;

        const groupKey = `group:${group.category_name}`;
        
        items.push({ id: `sid-${idx++}`, type: "title", label: group.category_name, categoryKey: groupKey, groupKey: "" });

        
        for (const cat of children) {
          items.push({ id: `sid-${idx++}`, type: "category", label: cat.category_name, categoryKey: cat.category_id, groupKey });
          allCategoryKeys.push(cat.category_id);
        }
      }
    } else {
      
      for (const cat of this._allCategories) {
        items.push({ id: `sid-${idx++}`, type: "category", label: cat.category_name, categoryKey: cat.category_id, groupKey: "" });
        allCategoryKeys.push(cat.category_id);
      }
    }

    this._allCategoryKeys = allCategoryKeys;
    this.setData({ sidebarItems: items });
  },

  async loadSpuList(categoryKey: string) {
    this.setData({ isLoading: true });
    const categoryId = this._findCategoryId(categoryKey);
    if (!categoryId) {
      this.setData({ isLoading: false });
      return;
    }
    try {
      const data = await callClientApi<{ spuList: SpuItem[] }>("product.spuList", { categoryId });

      const spuList: SpuItem[] = data?.spuList || [];
      
      const isMember = getIsMember();
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || "0") : (spu.listPriceFrom || spu.priceFrom || "0"),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : "",
      }));

      
      this._spuCache[categoryKey] = listWithPrice;

      
      if (this.data.activeCategoryKey === categoryKey) {
        this.setData({ spuList: listWithPrice });
      }
    } catch (err: any) {
      console.error("loadSpuList error:", err);
      Toast.fail(err?.message || "加载商品失败");
    } finally {
      this.setData({ isLoading: false });
    }
  },

  
  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },

  
  onBuyTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },

  
  onCartTap() {
    wx.navigateTo({ url: "/pagesShop/shopping-cart/shopping-cart" });
  },
});
