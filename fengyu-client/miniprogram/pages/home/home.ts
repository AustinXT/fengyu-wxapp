// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { getCartCount, clearCart } from "../../utils/cart";
import { callClientApi } from "../../utils/cloud";
import { getCosBase } from "../../utils/cloud-env";
import { createCoverWindow, type CoverWindow } from "../../utils/cover-window";
import { appendUniqueSpuRows, buildAppendPatch, decorateSpuRows, SPU_PAGE_SIZE } from "../../utils/spu-list";
import { getIsMember } from "../../utils/member-pricing";

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

  /**
   * 数据代次。每次整体重置缓存（切门店 / 下拉刷新）都自增一次。
   *
   * 翻页请求是异步的：`prev` 在 `await` 之后才从 `_spuCache` 取，若期间缓存被清空，
   * 回包会把「只有第 2 页」写回缓存并把游标推进到第 3 页 —— 第 1 页 20 条永久消失。
   * 只比对 activeCategoryKey 区分不了「同一分类、数据集已被整体重置」。
   */
  _dataEpoch: 0,

  /**
   * loading 所有权令牌。
   *
   * `isLoading` 是页面级的单一状态，而同时可能有多个请求在飞（切分类、翻页、兜底重拉）。
   * **不能用「数据是否过期」来决定谁关 loading**：翻页成功的请求会自己把游标推进，
   * 回到 finally 时反而判定自己过期 —— 于是没有任何请求去关，底部永久转圈，
   * 触底入口又被 `isLoading` 拦住，加载完一页就再也翻不动了。
   * 规则简单化：**最后启动的那个请求负责关**。
   */
  _loadingToken: 0,

  /**
   * 每个分类的请求序号，以及全局的搜索请求序号。
   *
   * `_dataEpoch` 只拦得住「缓存被整体重置」，拦不住**同一分类内的乱序回包**：
   * 快速点 A → B → A 会让 A 的两个首页请求并发，新的先回、旧的后回，
   * 旧回包会把 `_spuCache[A]` 打回第一页并让在途的第 3 页接错位置，第 2 页永久跳过。
   * 搜索侧同理：旧请求只靠「关键词相同」判有效，同词二次搜索时会串进旧门店/旧游标的结果。
   */
  _reqSeq: {} as Record<string, number>,
  _searchSeq: 0,

  // 防止 scrolltolower 连续触发
  _isLoadingNext: false,
  _isLoadingSearchNext: false,
  _nextCategoryTimer: null as ReturnType<typeof setTimeout> | null,

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
    this._teardownTimers();
    this._coverWindow?.dispose();
    this._searchCoverWindow?.dispose();
    this._coverWindow = null;
    this._searchCoverWindow = null;
  },

  /**
   * home 是 tabBar 页，切到别的 tab 只触发 onHide 不触发 onUnload。
   * 不在这里收摊的话，两个 IntersectionObserver 会在页面不可见时一直活着，
   * 300ms 搜索防抖定时器还可能在页面隐藏后回调 setData。
   */
  onHide() {
    this._teardownTimers();
    // 隐藏时只拆观察器接线，不销毁实例：隐藏的页面不渲染，observer 注定零回调，
    // 硬撑着会在 800ms 后误触发 fail-open 把整列图片放开
    this._coverWindow?.setVisible(false);
    this._searchCoverWindow?.setVisible(false);
  },

  _teardownTimers() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    if (this._nextCategoryTimer) {
      clearTimeout(this._nextCategoryTimer);
      this._nextCategoryTimer = null;
    }
    this._isLoadingNext = false;
    this._isLoadingSearchNext = false;
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || "";
    if (storeName !== this.data.boundStoreName) {
      // 切换门店时清空购物车和 SPU 缓存
      clearCart();
      this._coverWindow?.setVisible(true);
      this._searchCoverWindow?.setVisible(true);
      this._resetPaging();
      this._allGroups = [];
      this._allCategories = [];
      this._allCategoryKeys = [];
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
      // onHide 里拆过接线，回到本页要把当前显示的那份列表重新接上观察器
      this._coverWindow?.setVisible(true);
      this._searchCoverWindow?.setVisible(true);
      this._refreshCoverWindow(this.data.isSearching ? "search" : "browse");
    }
  },

  /** 整体重置分页态。`_spuCache` 与 `_pageState` 必须同生共死，否则会拿旧游标翻新数据集 */
  _resetPaging() {
    this._spuCache = {};
    this._pageState = {};
    this._reqSeq = {};
    this._isLoadingNext = false;
    this._dataEpoch++;
    this._resetSearchPaging();
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  onPullDownRefresh() {
    // 退出搜索模式，重新加载全部数据；下拉刷新要真重来一次，
    // 清掉分页游标与累积行，否则会拿旧游标续翻
    this._resetPaging();
    this.setData({ isSearching: false, searchResults: [], searchValue: '' });
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
      this._exitSearch({ keepInput: true });
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
      this._exitSearch({ keepInput: true });
      return;
    }
    await this._doSearch(value);
  },

  /**
   * 退出搜索模式的唯一出口。
   *
   * `isSearching` 由 wxml 的 `wx:if/wx:else` 控制：进搜索会销毁 `.product-scroll`
   * 与全部 `.spu-cover-slot`，退出时再重建。**必须在这里把浏览列表的观察器重新接上**，
   * 否则新节点无人观察、`coverVisible` 冻结在进搜索之前的值；而进搜索时节点被移除，
   * 旧 observer 多半已经以 `intersectionRatio=0` 回调把它们写成 false
   * —— 回到浏览态就是整列占位图。
   */
  _exitSearch(opts: { keepInput?: boolean } = {}) {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this._resetSearchPaging();
    this._searchCoverWindow?.dispose();
    const patch: Record<string, any> = { isSearching: false, searchResults: [], searchLoading: false };
    if (!opts.keepInput) patch.searchValue = "";
    this.setData(patch, () => this._coverWindow?.refresh());
  },

  _resetSearchPaging() {
    this._searchKeyword = "";
    this._searchPageState = { cursor: null, hasMore: false };
    this._isLoadingSearchNext = false;
    this._searchSeq++;
  },

  /**
   * 列表内容变了就得重建相交观察（observeAll 不跟踪新增节点）。
   *
   * 必须挂在 setData 的**渲染完成回调**上：`wx.nextTick` 只保证「下一个时间片」，
   * 不保证视图层已渲染；新节点还没上树就 observe，observeAll 只会拿到旧节点集合，
   * 追加的那一页从此永远是占位图，且失败是静默的。
   */
  _setListData(which: "browse" | "search", patch: Record<string, any>) {
    // setData 会**同步**换掉 page.data 里的列表，而 refresh 要等渲染回调才跑。
    // 这中间旧 observer 的在队回调仍属当前世代，会把旧下标写进新列表 —— 先作废掉。
    const win = which === "search" ? this._searchCoverWindow : this._coverWindow;
    win?.invalidate();
    this.setData(patch, () => this._refreshCoverWindow(which));
  },

  _refreshCoverWindow(which: "browse" | "search") {
    // 两份列表由 wx:if/wx:else 互斥渲染。给不在场的那份重建观察器，
    // 参照节点根本不存在 → 一个回调都收不到 → 会误触发 fail-open 把解码封顶放掉。
    if (which === "browse" && this.data.isSearching) return;
    if (which === "search" && !this.data.isSearching) return;
    if (which === "search") this._searchCoverWindow?.refresh();
    else this._coverWindow?.refresh();
  },

  /** 实际搜索执行；append=true 时翻本次搜索的下一页 */
  async _doSearch(value: string, append = false) {
    // 首页搜索换代作废在途请求；翻页沿用当前代次（它就是同一次搜索的延续）
    if (!append) this._searchSeq++;
    const seq = this._searchSeq;
    this.setData({ isSearching: true, searchLoading: true });

    try {
      // 全量搜索：调云函数按商品名跨全部分类搜索，不依赖前端 _spuCache/侧边栏分类结构
      //（旧版 loadAllSpus 仅加载已挂进 _allCategoryKeys 的分类，会漏掉未挂侧边栏的分类商品）
      const cursor = append ? this._searchPageState.cursor : null;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        "product.search",
        cursor
          ? { keyword: value, limit: SPU_PAGE_SIZE, cursor }
          : { keyword: value, limit: SPU_PAGE_SIZE }
      );

      // 只认当前代次的回包。光比对关键词不够：退出搜索后用同一个词再搜一次、
      // 或切门店后搜同一个词，旧请求都能通过「关键词相同」的检查，
      // 把旧门店 / 旧游标的那一页追加进新结果并覆盖 _searchPageState。
      if (seq !== this._searchSeq) return;
      // 早退也要把 loading 关掉，否则转圈会一直挂到下一次搜索完成
      if (this.data.searchValue.trim() !== value) {
        this.setData({ searchLoading: false });
        return;
      }

      const prev = append ? this.data.searchResults : [];
      const rows = decorateSpuRows(data?.spuList || [], getIsMember(), { startIndex: prev.length, dropSkuList: true }) as SpuItem[];
      const results = appendUniqueSpuRows(prev, rows);

      this._searchKeyword = value;
      this._searchPageState = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };
      this._setListData("search",
        append
          ? { ...buildAppendPatch("searchResults", prev.length, results), searchLoading: false }
          : { searchResults: results, searchLoading: false }
      );
    } catch (err) {
      console.error("_doSearch error:", err);
      // 过期请求的失败不该动当前状态（`_resetSearchPaging` 会把新搜索的游标也清掉）
      if (seq !== this._searchSeq) return;
      if (this.data.searchValue.trim() === value) {
        // 翻页失败只停在已有结果上，别把用户已看到的清空；
        // 但要把 hasMore 落下来，否则每次触底都重发同一个失败请求
        this.setData(append ? { searchLoading: false } : { searchResults: [], searchLoading: false });
        if (append) this._searchPageState = { ...this._searchPageState, hasMore: false };
        else this._searchPageState = { cursor: null, hasMore: false };
      } else {
        this.setData({ searchLoading: false });
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
    this._exitSearch();
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
    this._setListData("browse", {
      activeCategoryKey: categoryKey,
      sidebarScrollIntoView: catItem.id,
      spuList: cached || [],
      hasMore: Boolean(this._pageState[categoryKey]?.hasMore),
    });

    if (!cached) this.loadSpuList(categoryKey);
  },

  /**
   * 商品列表滚动到底。
   *
   * issue #248 之后是两段语义：本分类还有下一页就先翻页，翻到底了才切下一个分类。
   */
  onScrollToLower() {
    if (this._isLoadingNext || this.data.isLoading) return;

    const { activeCategoryKey } = this.data;

    if (this.data.hasMore) {
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
    this._nextCategoryTimer = setTimeout(() => {
      this._nextCategoryTimer = null;
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
    const epoch = this._dataEpoch;
    const token = ++this._loadingToken;
    try {
      this.setData({ isLoading: true, loadError: false });
      const initData = await callClientApi<{
        groups?: CategoryGroup[]; categories: Category[]; spuList: any[];
        spuCategoryId?: string | null; nextCursor?: string | null; hasMore?: boolean;
      }>("product.shopInit", { limit: SPU_PAGE_SIZE });
      if (epoch !== this._dataEpoch) return;

      const groups: CategoryGroup[] = initData?.groups || [];
      const categories: Category[] = initData?.categories || [];
      const listWithPrice = decorateSpuRows(initData?.spuList || [], getIsMember(), { dropSkuList: true }) as SpuItem[];

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

      const cachedFirst = firstCatKey ? this._spuCache[firstCatKey] : undefined;
      this._setListData("browse", {
        activeCategoryKey: firstCatKey,
        spuList: cachedFirst || [],
        hasMore: Boolean(this._pageState[firstCatKey]?.hasMore),
      });

      if (firstCatKey && !cachedFirst) this.loadSpuList(firstCatKey);
    } catch (err: any) {
      // 过期请求的失败不该弹 Toast 干扰已经开始的新一轮加载
      if (epoch !== this._dataEpoch) return;
      console.error("loadShopInit error:", err);
      Toast.fail(err?.message || "加载失败");
      if (epoch === this._dataEpoch) this.setData({ loadError: true });
    } finally {
      // 只有最后启动的请求能关 loading（见 _loadingToken 注释）。
      // 不能用 isStale()：翻页成功的请求自己推进了游标，回到这里反而判定自己过期，
      // 结果谁都不关，底部永久转圈、触底入口又被 isLoading 拦住。
      if (token === this._loadingToken) this.setData({ isLoading: false });
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
    const epoch = this._dataEpoch;
    // 分类内请求代次：拦住同一分类的乱序回包（快速点 A→B→A 会让 A 的两个首页请求并发）。
    // **只有首页请求推进代次**，于是「首页重来」自动作废掉还在途的翻页回包；
    // 翻页沿用当前代次，靠下面的 cursor 幂等键去重，不能靠 ++（后发翻页会错杀先发的成功回包）。
    const seq = append
      ? (this._reqSeq[categoryKey] || 0)
      : (this._reqSeq[categoryKey] = (this._reqSeq[categoryKey] || 0) + 1);
    const token = ++this._loadingToken;
    this.setData({ isLoading: true });
    const categoryId = this._findCategoryId(categoryKey);
    if (!categoryId) {
      if (token === this._loadingToken) this.setData({ isLoading: false });
      return;
    }
    // 翻页的幂等键：同一个 cursor 只认第一个回来的回包。先回的会把游标推进，
    // 后回的因 cursor 已变被丢弃 —— 否则重复触底会把同一页追加两次。
    const sentCursor = append ? this._pageState[categoryKey]?.cursor ?? null : null;
    const isStale = () =>
      epoch !== this._dataEpoch ||
      seq !== (this._reqSeq[categoryKey] || 0) ||
      (append && (this._pageState[categoryKey]?.cursor ?? null) !== sentCursor);
    try {
      const cursor = sentCursor;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        "product.spuList",
        cursor ? { categoryId, limit: SPU_PAGE_SIZE, cursor } : { categoryId, limit: SPU_PAGE_SIZE }
      );
      // 代次变了说明缓存在请求飞行期间被整体重置（下拉刷新 / 切门店）。此时 prev 已是空数组，
      // 继续写下去会把「只有第 N 页」当第 1 页存起来、并把游标推进到第 N+1 页，
      // 前面那些行就此永久消失。判定必须在写 _spuCache **之前**。
      if (isStale()) return;

      const prev = append ? (this._spuCache[categoryKey] || []) : [];
      const rows = decorateSpuRows(data?.spuList || [], getIsMember(), { startIndex: prev.length, dropSkuList: true }) as SpuItem[];
      const listWithPrice = appendUniqueSpuRows(prev, rows);

      // 写入缓存 + 翻页进度
      this._spuCache[categoryKey] = listWithPrice;
      this._pageState[categoryKey] = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };

      // 仅在仍在查看该分类时更新
      if (this.data.activeCategoryKey === categoryKey) {
        this._setListData("browse",
          append
            // 翻页只发新增的那些行，别每页都重发整列（O(N²) 的跨线程序列化）
            ? { ...buildAppendPatch("spuList", prev.length, listWithPrice), hasMore: Boolean(data?.hasMore) }
            : { spuList: listWithPrice, hasMore: Boolean(data?.hasMore) }
        );
      }
    } catch (err: any) {
      // 过期请求的失败不该打扰用户，也不该动当前列表的状态
      if (isStale()) return;
      console.error("loadSpuList error:", err);
      Toast.fail(err?.message || "加载商品失败");
      // 失败后把 hasMore 落下来：否则触底永远走「翻页」分支，
      // 既切不到下一个分类（home 触底的第二段语义），又会每次触底重发同一个失败请求
      if (this._pageState[categoryKey]) {
        this._pageState[categoryKey].hasMore = false;
        if (this.data.activeCategoryKey === categoryKey) this.setData({ hasMore: false });
      }
    } finally {
      // 只有最后启动的请求能关 loading（见 _loadingToken 注释）。
      // 不能用 isStale()：翻页成功的请求自己推进了游标，回到这里反而判定自己过期，
      // 结果谁都不关，底部永久转圈、触底入口又被 isLoading 拦住。
      if (token === this._loadingToken) this.setData({ isLoading: false });
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
