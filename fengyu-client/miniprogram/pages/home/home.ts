// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";
import { callClientApi } from "../../utils/cloud";
import { getCosBase } from "../../utils/cloud-env";

const app = getApp<IAppOption>();

// CloudBase CDN 基础 URL（随 env 切换 dev/prod 桶）
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

    // 侧边栏（扁平商品分类列表）
    sidebarItems: [] as SidebarItem[],
    activeCategoryKey: "",
    sidebarScrollIntoView: "",

    spuList: [] as SpuItem[],
    isLoading: false,
    loadError: false,
    cartCount: 0,
  },

  // 所有一级分组
  _allGroups: [] as CategoryGroup[],

  // 所有二级分类
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按分类名缓存已加载的 SPU 列表
  _spuCache: {} as Record<string, SpuItem[]>,

  // 所有分类 key 的有序列表（用于自动切换下一个分类）
  _allCategoryKeys: [] as string[],

  // 搜索防抖定时器
  _searchTimer: null as number | null,

  // 防止 scrolltolower 连续触发
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
      // 切换门店时清空购物车和 SPU 缓存
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
    // 退出搜索模式，重新加载全部数据
    if (this.data.isSearching) {
      this.setData({ isSearching: false, searchResults: [], searchValue: '' });
    }
    this.loadShopInit().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // ===== 搜索（即时过滤 + 300ms 防抖） =====

  onSearchInput(e: WechatMiniprogram.InputEvent) {
    const value = e.detail.value;
    this.setData({ searchValue: value });

    // 清除上次定时器
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }

    // 输入为空 → 立即退出搜索模式
    if (!value.trim()) {
      if (this.data.isSearching) {
        this.setData({ isSearching: false, searchResults: [], searchLoading: false });
      }
      return;
    }

    // 300ms 防抖后执行搜索
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this._doSearch(value.trim());
    }, 300) as unknown as number;
  },

  /** 回车/按钮点击：立即搜索（跳过防抖） */
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

  /** 实际搜索执行 */
  async _doSearch(value: string) {
    this.setData({ isSearching: true, searchLoading: true });

    try {
      // 全量搜索：调云函数按商品名跨全部分类搜索，不依赖前端 _spuCache/侧边栏分类结构
      //（旧版 loadAllSpus 仅加载已挂进 _allCategoryKeys 的分类，会漏掉未挂侧边栏的分类商品）
      const data = await callClientApi<{ spuList: SpuItem[] }>("product.search", { keyword: value });
      const results = (data?.spuList || []).map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));
      // 防止旧搜索结果覆盖新搜索（用户可能已继续输入）
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

  // categoryKey 就是 category_id
  _findCategoryId(categoryKey: string): string | undefined {
    const cat = this._allCategories.find((c) => c.category_id === categoryKey);
    return cat?.category_id;
  },

  // ===== 事件处理 =====

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
        // 用户取消扫码，不提示
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
          // Tab 页或无效路径时尝试 switchTab
          wx.switchTab({ url, fail: () => {} });
        },
      });
    }
  },

  // 宫格按钮点击
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
        // 体验卡 capability 化（ticket Round 2）：独立入口 → 列表 → 详情 → 严格独立 checkout
        wx.navigateTo({ url: "/pagesExperience/list/list" });
        break;
      default:
        break;
    }
  },

  // 二级分类点击
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

  // 商品列表滚动到底 → 自动切换到下一个分类
  onScrollToLower() {
    if (this._isLoadingNext) return;

    const { activeCategoryKey } = this.data;
    const currentIndex = this._allCategoryKeys.indexOf(activeCategoryKey);
    if (currentIndex < 0 || currentIndex >= this._allCategoryKeys.length - 1) return;

    const nextKey = this._allCategoryKeys[currentIndex + 1];
    this._isLoadingNext = true;

    this.switchToCategory(nextKey);

    // 防止连续触发
    setTimeout(() => {
      this._isLoadingNext = false;
    }, 500);
  },

  // ===== 数据加载 =====

  async loadBanners() {
    // 走云函数取 count/v（不受 wx.request 域名白名单限制），图片仍用 CDN_BASE 拼固定路径。
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
      // 轮播图非关键路径，静默失败即可
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

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      this._allGroups = groups;
      this._allCategories = categories;

      // 构建侧边栏（分组标题 + 二级分类）
      this.buildSidebarItems();

      // 缓存 shopInit 返回的商品列表（对应第一个二级分类）
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
      // 有分组：按分组组织侧边栏
      for (const group of this._allGroups) {
        const children = this._allCategories.filter(c => c.category_group === group.category_name);
        if (children.length === 0) continue;

        const groupKey = `group:${group.category_name}`;
        // 一级分组标题
        items.push({ id: `sid-${idx++}`, type: "title", label: group.category_name, categoryKey: groupKey, groupKey: "" });

        // 二级分类项（groupKey 关联所属分组）
        for (const cat of children) {
          items.push({ id: `sid-${idx++}`, type: "category", label: cat.category_name, categoryKey: cat.category_id, groupKey });
          allCategoryKeys.push(cat.category_id);
        }
      }
    } else {
      // 降级：无分组时扁平展示
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
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 写入缓存
      this._spuCache[categoryKey] = listWithPrice;

      // 仅在仍在查看该分类时更新
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

  // 点击商品卡片 → 跳转详情
  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },

  // 「购买」按钮 → 跳转详情页
  onBuyTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },

  // 购物车 FAB → 跳转购物车页面
  onCartTap() {
    wx.navigateTo({ url: "/pagesShop/shopping-cart/shopping-cart" });
  },
});
