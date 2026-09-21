// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";
import { callClientApi } from "../../utils/cloud";
import { getCosBase } from "../../utils/cloud-env";
import { createCoverWindow, withInitialCoverVisible, type CoverWindow } from "../../utils/cover-window";
import { getIsMember } from "../../utils/member-pricing";

const app = getApp<IAppOption>();

// CloudBase CDN 基础 URL（随 env 切换 dev/prod 桶）
const CDN_BASE = `${getCosBase()}/fengyu-client`;

/** issue #248：每页条数，与云函数默认值一致（后端仍会按 PRODUCT_PAGE_SIZE_MAX 夹取） */
const PAGE_SIZE = 20;

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
  /** issue #230：云函数无法保证缩略时下发 null，wxml 走 cover-placeholder 分支 */
  cover_image: string | null;
  /** issue #248：视口窗口内才挂 <image>，滚远的卡片渲染成占位 */
  coverVisible?: boolean;
  min_price: string;
  /** 会员价分流：仅会员且标价起价 > 会员起价时填标价起价（划线），否则空串 */
  strike_min_price?: string;
  /** 组合套餐标记：列表展示套餐总价，不带「起」字（普通单品多 SKU 起价才显示） */
  is_bundle?: boolean;
  is_recommend: boolean;
  skuList?: any[];
}

/** 某个分类（或某次搜索）的翻页进度 */
interface PageState { cursor: string | null; hasMore: boolean; }

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
    hasMore: false,
    cartCount: 0,
  },

  // 所有一级分组
  _allGroups: [] as CategoryGroup[],

  // 所有二级分类
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按分类名缓存已加载的 SPU 列表（累积已翻过的页）
  _spuCache: {} as Record<string, SpuItem[]>,

  // 每个分类的翻页进度，与 _spuCache 同生命周期
  _pageState: {} as Record<string, PageState>,

  // 所有分类 key 的有序列表（用于自动切换下一个分类）
  _allCategoryKeys: [] as string[],

  // 搜索防抖定时器
  _searchTimer: null as number | null,

  // 当前搜索词与其翻页进度
  _searchKeyword: "",
  _searchPageState: { cursor: null, hasMore: false } as PageState,

  // 防止 scrolltolower 连续触发
  _isLoadingNext: false,
  _isLoadingSearchNext: false,

  // issue #248：两份列表各一个相交观察器（互斥渲染，但下标空间不同，不能共用选择器）
  _coverWindow: null as CoverWindow | null,
  _searchCoverWindow: null as CoverWindow | null,

  onLoad() {
    this._spuCache = {};
    this._pageState = {};
    const storeName = app.globalData.boundStoreName || "";
    this.setData({ boundStoreName: storeName });
    this._coverWindow = createCoverWindow(this as any, {
      scrollSelector: ".product-scroll",
      slotSelector: ".spu-cover-slot",
      listKey: "spuList",
    });
    this._searchCoverWindow = createCoverWindow(this as any, {
      scrollSelector: ".search-results-scroll",
      slotSelector: ".search-cover-slot",
      listKey: "searchResults",
    });
    this.loadShopInit();
    this.loadBanners();
    this.updateCartCount();
  },

  onUnload() {
    this._coverWindow?.dispose();
    this._searchCoverWindow?.dispose();
    this._coverWindow = null;
    this._searchCoverWindow = null;
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || "";
    if (storeName !== this.data.boundStoreName) {
      // 切换门店时清空购物车和 SPU 缓存
      clearCart();
      this._spuCache = {};
      this._pageState = {};
      this._allGroups = [];
      this._allCategories = [];
      this._allCategoryKeys = [];
      this._resetSearchPaging();
      this.setData({
        boundStoreName: storeName,
        sidebarItems: [],
        activeCategoryKey: "",
        spuList: [],
        hasMore: false,
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
      this._resetSearchPaging();
      this.setData({ isSearching: false, searchResults: [], searchValue: '' });
    }
    // 下拉刷新要真重来一次：清掉分页游标与累积行，否则会拿旧游标续翻
    this._spuCache = {};
    this._pageState = {};
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
        this._resetSearchPaging();
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
        this._resetSearchPaging();
        this.setData({ isSearching: false, searchResults: [] });
      }
      return;
    }
    await this._doSearch(value);
  },

  _resetSearchPaging() {
    this._searchKeyword = "";
    this._searchPageState = { cursor: null, hasMore: false };
    this._isLoadingSearchNext = false;
  },

  /** 会员价分流：会员看会员起价 + 划线标价起价；非会员只看标价起价 */
  _decorate(rows: any[], startIndex: number): SpuItem[] {
    const isMember = getIsMember();
    return withInitialCoverVisible(
      rows.map((spu: any) => ({
        ...spu,
        min_price: isMember ? (spu.priceFrom || "0") : (spu.listPriceFrom || spu.priceFrom || "0"),
        strike_min_price: (isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom)) ? spu.listPriceFrom : "",
      })),
      startIndex
    ) as SpuItem[];
  },

  /** 列表内容变了就得重建相交观察（observeAll 不跟踪新增节点） */
  _refreshCoverWindow(which: "browse" | "search") {
    wx.nextTick(() => {
      if (which === "search") this._searchCoverWindow?.refresh();
      else this._coverWindow?.refresh();
    });
  },

  /** 实际搜索执行；append=true 时翻本次搜索的下一页 */
  async _doSearch(value: string, append = false) {
    this.setData({ isSearching: true, searchLoading: true });

    try {
      // 全量搜索：调云函数按商品名跨全部分类搜索，不依赖前端 _spuCache/侧边栏分类结构
      //（旧版 loadAllSpus 仅加载已挂进 _allCategoryKeys 的分类，会漏掉未挂侧边栏的分类商品）
      const cursor = append ? this._searchPageState.cursor : null;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        "product.search",
        cursor
          ? { keyword: value, limit: PAGE_SIZE, cursor }
          : { keyword: value, limit: PAGE_SIZE }
      );

      // 防止旧搜索结果覆盖新搜索（用户可能已继续输入）
      if (this.data.searchValue.trim() !== value) return;

      const prev = append ? this.data.searchResults : [];
      const results = prev.concat(this._decorate(data?.spuList || [], prev.length));

      this._searchKeyword = value;
      this._searchPageState = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };
      this.setData({ searchResults: results, searchLoading: false });
      this._refreshCoverWindow("search");
    } catch (err) {
      console.error("_doSearch error:", err);
      if (this.data.searchValue.trim() === value) {
        // 翻页失败只停在已有结果上，别把用户已看到的清空
        this.setData(append ? { searchLoading: false } : { searchResults: [], searchLoading: false });
        if (!append) this._resetSearchPaging();
      }
    }
  },

  /** 搜索结果触底：翻本次搜索的下一页 */
  onSearchScrollToLower() {
    if (this._isLoadingSearchNext || this.data.searchLoading) return;
    if (!this._searchPageState.hasMore || !this._searchKeyword) return;

    this._isLoadingSearchNext = true;
    this._doSearch(this._searchKeyword, true).then(() => {
      this._isLoadingSearchNext = false;
    });
  },

  onSearchClear() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this._resetSearchPaging();
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

    // 切分类是整体替换而非追加，上一个分类的图片节点随之释放
    this.setData({
      activeCategoryKey: categoryKey,
      sidebarScrollIntoView: catItem.id,
      spuList: cached || [],
      hasMore: Boolean(this._pageState[categoryKey]?.hasMore),
    });

    if (cached) {
      this._refreshCoverWindow("browse");
    } else {
      this.loadSpuList(categoryKey);
    }
  },

  /**
   * 商品列表滚动到底。
   *
   * issue #248 之后是两段语义：本分类还有下一页就先翻页，翻到底了才切下一个分类。
   */
  onScrollToLower() {
    if (this._isLoadingNext || this.data.isLoading) return;

    const { activeCategoryKey } = this.data;

    if (this._pageState[activeCategoryKey]?.hasMore) {
      this._isLoadingNext = true;
      this.loadSpuList(activeCategoryKey, true).then(() => {
        this._isLoadingNext = false;
      });
      return;
    }

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
      const initData = await callClientApi<{
        groups?: CategoryGroup[]; categories: Category[]; spuList: any[];
        spuCategoryId?: string | null; nextCursor?: string | null; hasMore?: boolean;
      }>("product.shopInit", { limit: PAGE_SIZE });

      const groups: CategoryGroup[] = initData?.groups || [];
      const categories: Category[] = initData?.categories || [];
      const listWithPrice = this._decorate(initData?.spuList || [], 0);

      this._allGroups = groups;
      this._allCategories = categories;

      // 构建侧边栏（分组标题 + 二级分类）
      this.buildSidebarItems();

      // 这批商品归属哪个分类由后端下发（shopInit 取的是「第一个 group 下的首个二级分类」）；
      // 游标必须挂在正确的分类上，否则「加载更多」会翻错分类的下一页
      const serverCatKey = initData?.spuCategoryId || "";
      const firstCatKey =
        serverCatKey && this._allCategoryKeys.indexOf(serverCatKey) >= 0
          ? serverCatKey
          : this._allCategoryKeys[0] || "";

      // shopInit 的这批只有在确实属于当前激活分类时才可当作它的第一页
      if (firstCatKey && firstCatKey === serverCatKey) {
        this._spuCache[firstCatKey] = listWithPrice;
        this._pageState[firstCatKey] = {
          cursor: initData?.nextCursor ?? null,
          hasMore: Boolean(initData?.hasMore),
        };
      }

      this.setData({
        activeCategoryKey: firstCatKey,
        spuList: firstCatKey ? (this._spuCache[firstCatKey] || []) : [],
        hasMore: Boolean(this._pageState[firstCatKey]?.hasMore),
      });

      if (firstCatKey && !this._spuCache[firstCatKey]) {
        this.loadSpuList(firstCatKey);
      } else {
        this._refreshCoverWindow("browse");
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

  async loadSpuList(categoryKey: string, append = false) {
    this.setData({ isLoading: true });
    const categoryId = this._findCategoryId(categoryKey);
    if (!categoryId) {
      this.setData({ isLoading: false });
      return;
    }
    try {
      const cursor = append ? this._pageState[categoryKey]?.cursor ?? null : null;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        "product.spuList",
        cursor ? { categoryId, limit: PAGE_SIZE, cursor } : { categoryId, limit: PAGE_SIZE }
      );

      const prev = append ? (this._spuCache[categoryKey] || []) : [];
      const listWithPrice = prev.concat(this._decorate(data?.spuList || [], prev.length));

      // 写入缓存 + 翻页进度
      this._spuCache[categoryKey] = listWithPrice;
      this._pageState[categoryKey] = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };

      // 仅在仍在查看该分类时更新
      if (this.data.activeCategoryKey === categoryKey) {
        this.setData({ spuList: listWithPrice, hasMore: Boolean(data?.hasMore) });
        this._refreshCoverWindow("browse");
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
