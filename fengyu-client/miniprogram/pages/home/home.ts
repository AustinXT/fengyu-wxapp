// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";
import { callClientApi } from "../../utils/cloud";
import { searchProducts } from "../../utils/format";

const app = getApp<IAppOption>();

// CloudBase CDN 基础 URL
const CDN_BASE = "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la/fengyu-client";

interface Banner {
  id: string;
  title: string;
  desc: string;
  bgColor: string;
  image: string;
  link: string;
}

interface Category {
  category_id: string;
  category_name: string;
  category_order: number;
  product_kind: string;
}

interface SpuItem {
  product_id: string;
  name: string;
  category_name: string;
  product_kind: string;
  cover_image: string;
  min_price: string;
  is_recommend: boolean;
  skuList?: any[];
}

interface SidebarItem {
  id: string;
  type: "title" | "category";
  label: string;
  categoryKey?: string;
  bigCategory?: string;
}

const BIG_CATEGORIES = ["福利活动", "护理项目", "家居产品", "充值卡"];

Page({
  data: {
    searchValue: "",
    isSearching: false,
    searchResults: [] as SpuItem[],
    searchLoading: false,
    boundStoreName: "",
    banners: [
      { id: "1", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner1.jpg`, link: "" },
      { id: "2", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner2.jpg`, link: "" },
      { id: "3", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner3.jpg`, link: "" },
      { id: "4", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner4.jpg`, link: "" },
      { id: "5", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner5.jpg`, link: "" },
    ] as Banner[],
    currentBanner: 0,

    // 侧边栏（统一展示所有分类，按大分类分组）
    sidebarItems: [] as SidebarItem[],
    activeCategoryKey: "",
    activeBigCategoryIndex: -1, // 宫格高亮
    activeBigCategory: "", // 当前选中的大分类名称（用于侧边栏去重高亮）
    sidebarScrollIntoView: "",

    spuList: [] as SpuItem[],
    isLoading: false,
    loadError: false,
    cartCount: 0,
  },

  // 所有分类
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
    const storeName = app.globalData.boundStoreName || "";
    this.setData({ boundStoreName: storeName });
    this.loadShopInit();
    this.updateCartCount();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || "";
    if (storeName !== this.data.boundStoreName) {
      // 切换门店时清空购物车和 SPU 缓存
      clearCart();
      this._spuCache = {};
      this._allCategories = [];
      this._allCategoryKeys = [];
      this.setData({
        boundStoreName: storeName,
        sidebarItems: [],
        activeCategoryKey: "",
        activeBigCategoryIndex: -1,
        activeBigCategory: "",
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

    // 加载所有未缓存的分类 SPU
    await this.loadAllSpus();

    const results = searchProducts(value, this._spuCache, this._allCategoryKeys);
    // 防止旧搜索结果覆盖新搜索（用户可能已继续输入）
    if (this.data.searchValue.trim() === value) {
      this.setData({ searchResults: results, searchLoading: false });
    }
  },

  onSearchClear() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this.setData({ isSearching: false, searchResults: [], searchValue: "" });
  },

  // 根据 compositeKey 查找 category_id
  _findCategoryId(compositeKey: string): string | undefined {
    const categoryName = compositeKey.includes("::") ? compositeKey.split("::")[1] : compositeKey;
    const cat = this._allCategories.find((c) => c.category_name === categoryName);
    return cat?.category_id;
  },

  async loadAllSpus() {
    const uncached = this._allCategoryKeys.filter((key) => !this._spuCache[key]);
    if (uncached.length === 0) return;

    await Promise.all(
      uncached.map(async (key) => {
        const categoryId = this._findCategoryId(key);
        if (!categoryId) return;
        try {
          const data = await callClientApi<{ spuList: any[] }>("product.spuList", { categoryId });
          const spuList = (data?.spuList || []).map((spu: any) => ({
            ...spu,
            min_price: spu.priceFrom || "0",
          }));
          this._spuCache[key] = spuList;
        } catch (err) {
          console.error("loadAllSpus error:", key, err);
        }
      })
    );
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

  // 宫格按钮点击 → 滚动到对应大分类区域
  onGridTap(e: WechatMiniprogram.TouchEvent) {
    const { type } = e.currentTarget.dataset as { type: string };

    switch (type) {
      case "promotion":
        this.scrollToBigCategory("福利活动");
        break;
      case "service":
        this.scrollToBigCategory("护理项目");
        break;
      case "product":
        this.scrollToBigCategory("家居产品");
        break;
      case "coupon":
        wx.navigateTo({ url: "/pagesCoupon/my-coupons/my-coupons" });
        break;
      case "treatment":
        wx.navigateTo({ url: "/pagesOrder/treatment-cards/treatment-cards" });
        break;
      default:
        break;
    }
  },

  scrollToBigCategory(bigCategory: string) {
    // 退出搜索模式
    if (this.data.isSearching) {
      this.setData({ isSearching: false, searchResults: [], searchValue: "" });
    }

    // 找到该大分类的 title 项
    const titleItem = this.data.sidebarItems.find((i) => i.type === "title" && i.label === bigCategory);
    if (!titleItem) return;

    // 找到该大分类下的第一个子分类
    const firstCat = this.data.sidebarItems.find((i) => i.type === "category" && i.bigCategory === bigCategory);
    if (!firstCat?.categoryKey) return;

    // 先清空 scroll-into-view 再设置，确保相同值也能触发滚动
    this.setData({ sidebarScrollIntoView: "" });
    setTimeout(() => {
      this.setData({ sidebarScrollIntoView: titleItem.id });
    }, 50);
    this.switchToCategory(firstCat.categoryKey);
  },

  // 侧边栏分类点击
  onSidebarCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const { key } = e.currentTarget.dataset as { key: string };
    if (key && key !== this.data.activeCategoryKey) {
      this.switchToCategory(key);
    }
  },

  switchToCategory(categoryKey: string) {
    const catItem = this.data.sidebarItems.find((i) => i.categoryKey === categoryKey);
    if (!catItem) return;

    const bigCatIndex = catItem.bigCategory ? BIG_CATEGORIES.indexOf(catItem.bigCategory) : -1;
    const cached = this._spuCache[categoryKey];

    this.setData({
      activeCategoryKey: categoryKey,
      activeBigCategoryIndex: bigCatIndex,
      activeBigCategory: catItem.bigCategory || "",
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

  async loadShopInit() {
    try {
      this.setData({ isLoading: true, loadError: false });
      const initData = await callClientApi<{ categories: Category[]; spuList: any[] }>("product.shopInit", {});

      const categories: Category[] = initData?.categories || [];
      const spuList: SpuItem[] = initData?.spuList || [];

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 缓存 shopInit 返回的 SPU 列表（对应全局第一个分类）
      if (categories.length > 0) {
        const firstCompositeKey = `${categories[0].product_kind}::${categories[0].category_name}`;
        this._spuCache[firstCompositeKey] = listWithPrice;
      }

      this._allCategories = categories;

      // 构建侧边栏
      this.buildSidebarItems();

      // 设置初始分类和商品
      const firstKey = this._allCategoryKeys[0] || "";
      const firstBigCat = this.data.sidebarItems.find((i) => i.categoryKey === firstKey)?.bigCategory;
      const bigCatIndex = firstBigCat ? BIG_CATEGORIES.indexOf(firstBigCat) : -1;

      // 检查缓存是否匹配第一个可见分类
      const firstCompositeKeyCheck = categories.length > 0
        ? `${categories[0].product_kind}::${categories[0].category_name}`
        : "";
      let displayList = listWithPrice;
      if (firstKey && firstKey !== firstCompositeKeyCheck) {
        displayList = this._spuCache[firstKey] || [];
      }

      this.setData({
        activeCategoryKey: firstKey,
        activeBigCategoryIndex: bigCatIndex,
        activeBigCategory: firstBigCat || "",
        spuList: displayList,
      });

      // 如需单独加载首个分类的 SPU
      if (firstKey && displayList.length === 0 && !this._spuCache[firstKey]) {
        this.loadSpuList(firstKey);
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

    for (const bigCat of BIG_CATEGORIES) {
      const cats = this._allCategories.filter((c) => c.product_kind === bigCat);
      if (cats.length === 0) continue;

      items.push({
        id: `sid-${idx}`,
        type: "title",
        label: bigCat,
      });
      idx++;

      for (const cat of cats) {
        const compositeKey = `${bigCat}::${cat.category_name}`;
        items.push({
          id: `sid-${idx}`,
          type: "category",
          label: cat.category_name,
          categoryKey: compositeKey,
          bigCategory: bigCat,
        });
        allCategoryKeys.push(compositeKey);
        idx++;
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
