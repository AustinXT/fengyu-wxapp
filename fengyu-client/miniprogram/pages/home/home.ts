// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";

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
  category: string;
  category_order: number;
  big_category: string;
}

interface SpuItem {
  spu_id: string;
  name: string;
  category: string;
  big_category: string;
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

const BIG_CATEGORIES = ["福利活动", "护理项目", "家居产品"];

// 数据库 big_category 与前端显示的映射
const BIG_CATEGORY_MAP: Record<string, string> = {
  促销方案: "福利活动",
  生美: "护理项目",
  非生美: "护理项目",
  院装产品: "家居产品",
};

// 获取前端显示的大分类名称
function getDisplayBigCategory(dbValue: string): string {
  return BIG_CATEGORY_MAP[dbValue] || dbValue;
}

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
    cartCount: 0,
  },

  // 所有分类（已映射 big_category）
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按分类名缓存已加载的 SPU 列表
  _spuCache: {} as Record<string, SpuItem[]>,

  // 所有分类 key 的有序列表（用于自动切换下一个分类）
  _allCategoryKeys: [] as string[],

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
    wx.stopPullDownRefresh();
  },

  // ===== 搜索 =====

  onSearchInput(e: WechatMiniprogram.InputEvent) {
    this.setData({ searchValue: e.detail.value });
  },

  async onSearchSubmit() {
    const value = this.data.searchValue.trim();
    if (!value) {
      // 清空搜索 → 退出搜索模式
      if (this.data.isSearching) {
        this.setData({ isSearching: false, searchResults: [] });
      }
      return;
    }

    this.setData({ isSearching: true, searchLoading: true, searchResults: [] });

    // 加载所有未缓存的分类 SPU
    await this.loadAllSpus();

    // 跨分类搜索，按名称匹配，去重
    const keyword = value.toLowerCase();
    const seen = new Set<string>();
    const results: SpuItem[] = [];

    for (const key of this._allCategoryKeys) {
      const cached = this._spuCache[key] || [];
      for (const spu of cached) {
        if (!seen.has(spu.spu_id) && spu.name.toLowerCase().includes(keyword)) {
          seen.add(spu.spu_id);
          results.push(spu);
        }
      }
    }

    this.setData({ searchResults: results, searchLoading: false });
  },

  onSearchClear() {
    this.setData({ isSearching: false, searchResults: [], searchValue: "" });
  },

  async loadAllSpus() {
    const uncached = this._allCategoryKeys.filter((key) => !this._spuCache[key]);
    if (uncached.length === 0) return;

    await Promise.all(
      uncached.map(async (category) => {
        try {
          const res = (await wx.cloud.callFunction({
            name: "clientApi",
            data: { action: "product.spuList", payload: { category } },
          })) as any;

          if (res.result?.code === 0) {
            const spuList = (res.result.data?.spuList || []).map((spu: any) => ({
              ...spu,
              min_price: spu.priceFrom || "0",
            }));
            this._spuCache[category] = spuList;
          }
        } catch (err) {
          console.error("loadAllSpus error:", category, err);
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
          wx.navigateTo({ url: `/pagesOrder/scan-pay/scan-pay?orderNo=${encodeURIComponent(res.result)}` });
        }
      },
      fail: () => {
        // 用户取消扫码，不提示
      },
    });
  },

  onBannerChange(e: WechatMiniprogram.CustomEvent<number>) {
    this.setData({ currentBanner: e.detail.current });
  },

  onBannerTap(e: WechatMiniprogram.TouchEvent) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      // TODO: 处理跳转
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
        wx.showToast({ title: "优惠券功能开发中", icon: "none" });
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
      this.setData({ isLoading: true });
      const res = (await wx.cloud.callFunction({
        name: "clientApi",
        data: { action: "product.shopInit", payload: {} },
      })) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || "加载失败");
      }

      const categories: Category[] = res.result.data?.categories || [];
      const spuList: SpuItem[] = res.result.data?.spuList || [];

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 缓存 shopInit 返回的 SPU 列表（对应全局第一个分类）
      if (categories.length > 0) {
        this._spuCache[categories[0].category] = listWithPrice;
      }

      // 将数据库 big_category 转换为前端显示名称
      const mappedCategories = categories.map((c: any) => ({
        ...c,
        big_category: getDisplayBigCategory(c.big_category),
      }));
      this._allCategories = mappedCategories;

      // 构建侧边栏
      this.buildSidebarItems();

      // 设置初始分类和商品
      const firstKey = this._allCategoryKeys[0] || "";
      const firstBigCat = this.data.sidebarItems.find((i) => i.categoryKey === firstKey)?.bigCategory;
      const bigCatIndex = firstBigCat ? BIG_CATEGORIES.indexOf(firstBigCat) : -1;

      // 检查缓存是否匹配第一个可见分类
      let displayList = listWithPrice;
      if (firstKey && firstKey !== categories[0]?.category) {
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
    } finally {
      this.setData({ isLoading: false });
    }
  },

  buildSidebarItems() {
    const items: SidebarItem[] = [];
    const allCategoryKeys: string[] = [];
    let idx = 0;

    for (const bigCat of BIG_CATEGORIES) {
      const cats = this._allCategories.filter((c) => c.big_category === bigCat);
      if (cats.length === 0) continue;

      items.push({
        id: `sid-${idx}`,
        type: "title",
        label: bigCat,
      });
      idx++;

      for (const cat of cats) {
        items.push({
          id: `sid-${idx}`,
          type: "category",
          label: cat.category,
          categoryKey: cat.category,
          bigCategory: bigCat,
        });
        allCategoryKeys.push(cat.category);
        idx++;
      }
    }

    this._allCategoryKeys = allCategoryKeys;
    this.setData({ sidebarItems: items });
  },

  async loadSpuList(category: string) {
    this.setData({ isLoading: true });
    try {
      const res = (await wx.cloud.callFunction({
        name: "clientApi",
        data: { action: "product.spuList", payload: { category } },
      })) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || "加载商品失败");
      }

      const spuList: SpuItem[] = res.result.data?.spuList || [];
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 写入缓存
      this._spuCache[category] = listWithPrice;

      // 仅在仍在查看该分类时更新
      if (this.data.activeCategoryKey === category) {
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
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?spuId=${spuId}` });
  },

  // 「购买」按钮 → 跳转详情页
  onBuyTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?spuId=${spuId}` });
  },

  // 购物车 FAB → 跳转购物车页面
  onCartTap() {
    wx.navigateTo({ url: "/pagesShop/shopping-cart/shopping-cart" });
  },
});
