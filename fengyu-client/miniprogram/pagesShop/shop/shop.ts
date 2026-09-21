// pages/shop/shop.ts
import Toast from '@vant/weapp/toast/toast';
import { addToCart, getCartCount, clearCart } from '../../utils/cart';
import { callClientApi } from '../../utils/cloud';
import { createCoverWindow, type CoverWindow } from '../../utils/cover-window';
import { getIsMember, priceView } from '../../utils/member-pricing';
import { appendUniqueSpuRows, buildAppendPatch, decorateSpuRows, SPU_PAGE_SIZE } from '../../utils/spu-list';

const app = getApp<IAppOption>();

interface Category { category_id: string; category_name: string; category_order: number; }

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

/** 某个分类的翻页进度 */
interface PageState { cursor: string | null; hasMore: boolean; }

Page({
  data: {
    boundStoreName: '',
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
    hasMore: false,
    cartCount: 0,
  },

  // 所有分类
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按 categoryId 缓存（累积已翻过的页）
  _spuCache: {} as Record<string, SpuItem[]>,

  // 每个分类的翻页进度，与 _spuCache 同生命周期
  _pageState: {} as Record<string, PageState>,

  // 当前正在展示的分类 id（shopInit 下发的是权威值，不等于 categories[0]）
  _activeCategoryId: '',

  /**
   * 数据代次。每次整体重置缓存（切门店）都自增一次。
   *
   * 翻页请求是异步的：`prev` 在 `await` 之后才从 `_spuCache` 取，若期间缓存被清空，
   * 回包会把「只有第 2 页」写回缓存并把游标推进到第 3 页 —— 第 1 页 20 条永久消失，
   * 切门店时更会把旧门店的商品写进新门店缓存。只比对 categoryId 区分不了这种情况。
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
   * 每个分类的请求序号。`_dataEpoch` 只拦得住「缓存被整体重置」，
   * 拦不住**同一分类内的乱序回包**：快速点 A → B → A 会让 A 的两个首页请求并发，
   * 旧回包会把 `_spuCache[A]` 打回第一页并让在途的翻页接错位置。
   */
  _reqSeq: {} as Record<string, number>,

  // 防止 scrolltolower 连续触发
  _isLoadingNext: false,

  _coverWindow: null as CoverWindow | null,

  onLoad() {
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
    this._coverWindow = createCoverWindow(this as any, {
      scrollSelector: '.product-scroll',
      slotSelector: '.spu-cover-slot',
      listKey: 'spuList',
    });
    this.loadShopInit();
    this.updateCartCount();
  },

  onUnload() {
    this._coverWindow?.dispose();
    this._coverWindow = null;
  },

  /**
   * shop 会被 navigateTo 到商品详情 / 购物车盖住。隐藏的页面不渲染，
   * 此时若翻页回包到达并重建观察器，一个相交回调都收不到 →
   * 800ms 后误触发 fail-open 把整列图片放开，回来时解码上限已经没了。
   */
  onHide() {
    this._isLoadingNext = false;
    this._coverWindow?.setVisible(false);
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    this._coverWindow?.setVisible(true);
    if (storeName !== this.data.boundStoreName) {
      clearCart();
      this._resetPaging();
      this._allCategories = [];
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [], hasMore: false, cartCount: 0 });
      this.loadShopInit();
    } else {
      this.updateCartCount();
      // onHide 里拆过接线，回来要重新接上
      this._coverWindow?.refresh();
    }
  },

  /** 整体重置分页态。`_spuCache` 与 `_pageState` 必须同生共死，否则会拿旧游标翻新数据集 */
  _resetPaging() {
    this._spuCache = {};
    this._pageState = {};
    this._reqSeq = {};
    this._activeCategoryId = '';
    this._isLoadingNext = false;
    this._dataEpoch++;
  },

  onSelectStore() {
    wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  // 点击"加入购物车"按钮
  async onAddToCart(e: WechatMiniprogram.TouchEvent) {
    (e as any).stopPropagation();
    const { productId } = e.currentTarget.dataset as { productId: string };
    const spu = this.data.spuList.find(s => s.product_id === productId);
    if (!spu) return;

    const skuList = spu.skuList || [];
    if (skuList.length === 0) {
      Toast.fail('暂无可购规格');
      return;
    }

    const sku = skuList[0];

    // 会员价分流：套餐组件价（bundle_price）固定不分流；普通 SKU 会员→会员价、非会员→标价。
    // 与后端 order.create 权威定价同口径，避免购物车/结算预览与实收不一致。
    const hasBundlePrice = Number(sku.bundle_price) > 0;
    const pv = priceView(getIsMember(), sku.special_price, sku.price);
    const dealPrice = hasBundlePrice ? Number(sku.bundle_price) : pv.display;
    const listPrice = hasBundlePrice ? Number(sku.bundle_price) : (pv.strike ?? pv.display);

    addToCart({
      skuId: sku.sku_id,
      spuId: spu.product_id,
      spuName: spu.name,
      skuDisplayName: sku.spec_name,
      // 购物车是 localStorage 快照，用空串表示无封面（CartItem.coverImage 非空）
      coverImage: spu.cover_image || '',
      price: dealPrice,
      listPrice,
      bigCategory: spu.category_name,
      productType: sku.product_type,
      // PR-D：DB 驱动 tag 渲染（来自 product.shopInit / spuList JOIN product_categories）
      productKind: sku.product_kind || undefined,
      kindDisplayColor: sku.kind_display_color || undefined,
      // 充值卡剥离 SKU 化（2026-05-20）：商城 SKU 已不含充值卡
    });

    this.updateCartCount();
    Toast.success('已加入购物车');
  },

  onCartTap() {
    wx.navigateTo({ url: '/pagesShop/shopping-cart/shopping-cart' });
  },

  /**
   * 列表内容变了就得重建相交观察（observeAll 不跟踪新增节点）。
   *
   * 必须挂在 setData 的**渲染完成回调**上：`wx.nextTick` 只保证「下一个时间片」，
   * 不保证视图层已渲染；新节点还没上树就 observe，observeAll 只会拿到旧节点集合，
   * 追加的那一页从此永远是占位图，且失败是静默的。
   */
  _setListData(patch: Record<string, any>) {
    // setData 会**同步**换掉 page.data 里的列表，而 refresh 要等渲染回调才跑。
    // 这中间旧 observer 的在队回调仍属当前世代，会把旧下标写进新列表 —— 先作废掉。
    this._coverWindow?.invalidate();
    this.setData(patch, () => this._coverWindow?.refresh());
  },

  async loadShopInit() {
    const epoch = this._dataEpoch;
    const token = ++this._loadingToken;
    try {
      this.setData({ isLoading: true });
      const initData = await callClientApi<{
        categories: Category[]; spuList: any[];
        spuCategoryId?: string | null; nextCursor?: string | null; hasMore?: boolean;
      }>('product.shopInit', { limit: SPU_PAGE_SIZE });
      if (epoch !== this._dataEpoch) return;

      const categories: Category[] = initData?.categories || [];
      const listWithPrice = decorateSpuRows(initData?.spuList || [], getIsMember()) as SpuItem[];

      this._allCategories = categories;

      // 这批商品归属哪个分类由后端下发（shopInit 取的是「第一个 group 下的首个二级分类」，
      // 不必然是 categories[0]）；游标必须挂在正确的分类上，否则「加载更多」会翻错分类
      const serverCatId = initData?.spuCategoryId || '';
      const serverIndex = serverCatId
        ? categories.findIndex(c => c.category_id === serverCatId)
        : -1;
      // 后端下发的分类不在 categories 里（理论上不可达）时显式回落到第一个分类并重新拉，
      // 而不是用 Math.max(0, -1) 把下标和 _activeCategoryId 悄悄指到两个不同分类上
      const activeIndex = serverIndex >= 0 ? serverIndex : 0;
      const activeId = serverIndex >= 0 ? serverCatId : (categories[0]?.category_id || '');
      this._activeCategoryId = activeId;

      // 只缓存「确实属于当前分类且有内容」的那批：空数组是 truthy，
      // 无条件写进缓存会让该分类永远命中 `if (cached)` 分支、永久显示「暂无商品」且无法重试
      if (activeId && serverIndex >= 0 && listWithPrice.length > 0) {
        this._spuCache[activeId] = listWithPrice;
        this._pageState[activeId] = {
          cursor: initData?.nextCursor ?? null,
          hasMore: Boolean(initData?.hasMore),
        };
      }

      // init 在途时用户可能已经切了别的分类（那会推进 _loadingToken，但不动 epoch）。
      // categories 必须写——用户选的分类也依赖它；但激活分类与列表不能再被 init 覆盖回去。
      if (token !== this._loadingToken) {
        this.setData({ categories });
        return;
      }

      const usable = activeId && serverIndex >= 0;
      this._setListData({
        categories,
        activeCategoryIndex: activeIndex,
        spuList: usable ? listWithPrice : [],
        hasMore: usable ? Boolean(initData?.hasMore) : false,
      });
      if (activeId && !usable) this.loadSpuList(activeId);
    } catch (err: any) {
      // 过期请求的失败不该弹 Toast 干扰用户已经切过去的分类
      if (epoch !== this._dataEpoch || token !== this._loadingToken) return;
      console.error('loadShopInit error:', err);
      Toast.fail(err?.message || '加载失败');
    } finally {
      // 只有最后启动的请求能关 loading（见 _loadingToken 注释）。
      // 不能用 isStale()：翻页成功的请求自己推进了游标，回到这里反而判定自己过期，
      // 结果谁都不关，底部永久转圈、触底入口又被 isLoading 拦住。
      if (token === this._loadingToken) this.setData({ isLoading: false });
    }
  },

  onCategoryChange(e: WxEvent<number>) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as any)?.key;
    if (typeof index !== 'number') return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const cat = categories[index];
    if (!cat) return;

    this._activeCategoryId = cat.category_id;
    const cached = this._spuCache[cat.category_id];
    if (cached && cached.length > 0) {
      // 切分类是整体替换而非追加，旧分类的图片节点随之释放
      this._setListData({
        activeCategoryIndex: index,
        spuList: cached,
        hasMore: Boolean(this._pageState[cat.category_id]?.hasMore),
      });
      return;
    }

    this.setData({ activeCategoryIndex: index, spuList: [], hasMore: false });
    this.loadSpuList(cat.category_id);
  },

  /** 触底：加载本分类下一页（shop 无「自动切下一分类」语义） */
  onScrollToLower() {
    if (this._isLoadingNext || this.data.isLoading) return;
    const categoryId = this._activeCategoryId;
    if (!categoryId) return;
    if (!this.data.hasMore) return;

    this._isLoadingNext = true;
    this.loadSpuList(categoryId, true).then(() => {
      this._isLoadingNext = false;
    });
  },

  async loadSpuList(categoryId: string, append = false) {
    const epoch = this._dataEpoch;
    // 分类内请求代次：拦住同一分类的乱序回包。**只有首页请求推进代次**，
    // 于是「首页重来」自动作废还在途的翻页回包；翻页沿用当前代次，
    // 靠下面的 cursor 幂等键去重，不能靠 ++（后发翻页会错杀先发的成功回包）。
    const seq = append
      ? (this._reqSeq[categoryId] || 0)
      : (this._reqSeq[categoryId] = (this._reqSeq[categoryId] || 0) + 1);
    const token = ++this._loadingToken;
    this.setData({ isLoading: true });
    // 翻页的幂等键：同一个 cursor 只认第一个回来的回包
    const sentCursor = append ? this._pageState[categoryId]?.cursor ?? null : null;
    const isStale = () =>
      epoch !== this._dataEpoch ||
      seq !== (this._reqSeq[categoryId] || 0) ||
      (append && (this._pageState[categoryId]?.cursor ?? null) !== sentCursor);
    try {
      const cursor = sentCursor;
      const data = await callClientApi<{ spuList: any[]; nextCursor?: string | null; hasMore?: boolean }>(
        'product.spuList',
        // cursor 为 null 时不传：云函数只把「缺省」当首页，显式 null 也接受，但别依赖
        cursor ? { categoryId, limit: SPU_PAGE_SIZE, cursor } : { categoryId, limit: SPU_PAGE_SIZE }
      );
      // 代次变了说明缓存在请求飞行期间被整体重置（切门店）。此时 prev 已是空数组，
      // 继续写下去会把「只有第 N 页」当第 1 页存起来、并把旧门店的商品塞进新门店缓存。
      // 判定必须在写 _spuCache **之前**，不能只在 setData 之前。
      if (isStale()) return;

      const prev = append ? (this._spuCache[categoryId] || []) : [];
      const rows = decorateSpuRows(data?.spuList || [], getIsMember(), { startIndex: prev.length }) as SpuItem[];
      const listWithPrice = appendUniqueSpuRows(prev, rows);

      this._spuCache[categoryId] = listWithPrice;
      this._pageState[categoryId] = {
        cursor: data?.nextCursor ?? null,
        hasMore: Boolean(data?.hasMore),
      };

      // 仅在仍在看该分类时更新（翻页期间用户可能已切走）
      if (this._activeCategoryId === categoryId) {
        this._setListData(
          append
            // 翻页只发新增的那些行，别每页都重发整列（O(N²) 的跨线程序列化）
            ? { ...buildAppendPatch('spuList', prev.length, listWithPrice), hasMore: Boolean(data?.hasMore) }
            : { spuList: listWithPrice, hasMore: Boolean(data?.hasMore) }
        );
      }
    } catch (err: any) {
      // 过期请求的失败不该打扰用户，也不该动当前列表的状态
      if (isStale()) return;
      console.error('loadSpuList error:', err);
      Toast.fail(err?.message || '加载商品失败');
      // 失败后把 hasMore 落下来：否则每次触底都会重发同一个失败请求
      if (this._pageState[categoryId]) {
        this._pageState[categoryId].hasMore = false;
        if (this._activeCategoryId === categoryId) this.setData({ hasMore: false });
      }
    } finally {
      // 只有最后启动的请求能关 loading（见 _loadingToken 注释）。
      // 不能用 isStale()：翻页成功的请求自己推进了游标，回到这里反而判定自己过期，
      // 结果谁都不关，底部永久转圈、触底入口又被 isLoading 拦住。
      if (token === this._loadingToken) this.setData({ isLoading: false });
    }
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { productId } = e.currentTarget.dataset as { productId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${productId}` });
  },
});
