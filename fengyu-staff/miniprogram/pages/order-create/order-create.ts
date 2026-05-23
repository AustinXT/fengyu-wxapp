// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';
import { calcCartTotal, calcHalfPriceTotal, allocateCouponPerLine } from '../../utils/cart-calc';
import { evaluateCouponAfterCartChange } from '../../utils/coupon-evaluator';
import { computePrepaidDeduction } from '../../utils/prepaid-card-calc';

const app = getApp<IAppOption>();

/**
 * 顶部商品类型 4 选 1（PR-B 改版）
 * - 组合套餐：走 BundlePicker 子视图（products.is_bundle=true）
 * - 普通商品：!isExperience && !isBundle（SKU 级 capability 过滤）
 * - 体验卡：isExperience=true（capability，与 product_kind 字面量解耦）
 * - 充值卡：跳转独立 card-recharge 页（2026-05-20 充值卡剥离 SKU 化）
 */
const PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡'] as const;
type ProductKindChoice = typeof PRODUCT_KIND_CHOICES[number];

/**
 * 订单类型（PR-C §C1）—— 与 DB 原生枚举 sale_order_type 对齐
 * - 销售单：默认，正常计价（支持订单级 couponId 按行均摊）
 * - 内部单：managerOnly，所有 SKU 半价（后端计算），禁优惠券
 * - 转换单：managerOnly，调 order.createConversion
 * - 寄存单：剩余次数初始化
 */
type SaleOrderType = '销售单' | '内部单' | '转换单' | '寄存单';

interface CartItem {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  /** 单价（会员价优先 specialPrice，否则 price；由 skuToDisplay / SkuItem 决定） */
  price: number;
  /** 展示用：原始挂牌价（划线原价）。缺省时降级为单价显示 */
  listPrice?: number;
  /** 展示用：特价，null 表示无特价 */
  specialPrice?: number | null;
  quantity: number;
  sessionCount: number;
  productType: string;
  workfineItemId: string;
  /** 预计算：price × quantity（"价格"列） */
  priceLine: string;
  /** 预计算：本行摊到的优惠券折扣（订单级券按行应付比例分摊；元，2 位精度） */
  couponShare: string;
  /** 预计算：行应付金额 = priceLine - couponShare（销售单 / 寄存单口径） */
  saleAmount: string;
  /** 预计算：内部单半价后行应付（price × 0.5 × quantity，再扣摊到的券） */
  halfPriceSaleAmount: string;
  /** 行实付金额（店长可向下编辑；0 ≤ received ≤ 当前订单类型下的应付） */
  received: string;
  /** 前端临时字段：同一套餐生成的多行共享此 id（PR-B §2.2），非 schema 字段 */
  refBundleId?: string;
}

interface Category {
  id: string;
  name: string;
  productKind: string;
}

/** SKU 列表项（从 product.shopInit / product.skuList 返回） */
interface SkuItem {
  skuId: string;
  specName: string;
  categoryId: string;
  categoryName: string;
  productKind: string;
  salesCategory: string;
  price: number;
  specialPrice: number | null;
  sessionCount: number | null;
  productType: string;
  serviceFee: number;
  isShengmei: boolean | null;
  /** 体验卡 capability（product_skus.is_experience） */
  isExperience?: boolean;
  /** 是否为套餐 SKU（关联任一 products.is_bundle=true 则为 true；用于"普通商品"视图过滤） */
  isBundle?: boolean;
}

/** 套餐分组（PR-A 云函数 product.shopInit 返回 mallBundleGroups[]） */
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

/** 套餐商品（bundle SPU） */
interface BundleSpu {
  productId: string;
  name: string;
  coverImage: string | null;
  description: string | null;
  price: number;
  specialPrice: number | null;
  groups: BundleGroup[];
}

/** 展示用 SPU 格式（兼容 WXML 模板） */
interface DisplayItem {
  spuId: string;
  spuName: string;
  /** 生效价（specialPrice 优先，否则 price）；计费用 */
  price: number;
  /** 原始挂牌价 sku.price（展示划线用，price 折叠后保留此字段） */
  listPrice: number;
  specialPrice: number | null;
  productKind: string;
  productType: string;
  sessionCount: number | null;
  isBundle?: boolean;
}

interface CustomerInfo {
  id: string | null;
  clientUserId: string;
  customerNo?: string | null;
  name: string;
  phone: string;
  phoneMasked?: string;
}

interface CouponInfo {
  couponId: string;
  name: string;
  discount: number;
  description?: string;
}

/** 侧边栏分组（"普通商品"模式，按 productKind 聚合） */
interface GroupedCategory {
  productKind: string;
  kindSortOrder: number;
  items: Category[];
}

interface ShopInitResponse {
  categories: Category[];
  /** PR-B：排除卡类 + EXISTS 过滤 + 按 parent.sort_order 聚合后的分组 */
  groupedCategories?: GroupedCategory[];
  skuList: SkuItem[];
  mallBundleGroups?: BundleSpu[];
  /** 体验卡 Tab 扁平 SKU 列表（is_experience=true，全量，不受分类 EXISTS 过滤影响） */
  experienceSkus?: SkuItem[];
}

interface OrderCreateResponse {
  saleOrderId: string;
  /** 订单初始状态；全额储值卡抵扣时云端直接结清为 '已支付'（无需进 QR/收款页） */
  status?: string;
}

interface CouponAvailableResponse {
  coupons: CouponInfo[];
}

/** 顾客储值卡余额（Wave 2B 新增 customer.customerBalance；跨店统一余额） */
interface CustomerBalanceResponse {
  balance: number;
  cardId: string | null;
}

/** 将后端 SKU 项映射为兼容 WXML 的展示格式 */
function skuToDisplay(sku: SkuItem): DisplayItem {
  return {
    spuId: sku.skuId,
    spuName: sku.specName,
    price: Number(sku.specialPrice || sku.price) || 0,
    listPrice: Number(sku.price) || 0,
    specialPrice: sku.specialPrice ? Number(sku.specialPrice) : null,
    productKind: sku.productKind,
    productType: sku.productType,
    sessionCount: sku.sessionCount,
    isBundle: !!sku.isBundle,
  }
}

/**
 * 商品类型过滤器（按 SKU 级 capability 判定）
 * - 普通商品：非体验卡、非套餐
 * - 体验卡：isExperience=true
 * - 充值卡：本视图不渲染，由 onBigCategoryChange 截走跳 card-recharge 页（2026-05-20）
 * - 组合套餐：不走 SKU 列表，由 BundlePicker 接管
 */
function filterSkusByKindChoice(skus: SkuItem[], choice: ProductKindChoice): SkuItem[] {
  if (choice === '组合套餐') return [];
  if (choice === '普通商品') {
    return skus.filter(s => !s.isExperience && !s.isBundle);
  }
  if (choice === '体验卡') {
    return skus.filter(s => s.isExperience === true);
  }
  // 充值卡 Tab 已由 nextChoice 截走跳转，此处不应到达
  return [];
}

/**
 * 分类过滤器（按选中商品类型裁剪侧边栏候选分类）
 *
 * Category 行只有 productKind 字面量（分类层），没有 SKU capability。
 * 普通商品 Tab 走 groupedCategories 渲染（后端已 EXISTS 过滤过卡类 SKU），
 * 不调用本函数。本函数仅服务于体验卡/充值卡 Tab，按分类名匹配。
 */
function filterCategoriesByKindChoice(categories: Category[], choice: ProductKindChoice): Category[] {
  if (choice === '组合套餐' || choice === '普通商品') return [];
  return categories.filter(c => c.productKind === choice);
}

Page({
  data: {
    isManager: false,
    // 顶部商品类型 4 选 1（PR-B）
    productKindChoices: PRODUCT_KIND_CHOICES as unknown as string[],
    productKindChoiceIndex: 1, // 默认"普通商品"
    productKindChoice: '普通商品' as ProductKindChoice,
    // 商品目录（侧边栏分类 + SKU 列表）
    catalogLoading: false,
    categories: [] as Category[],
    activeCategoryIndex: 0,
    /** PR-B：普通商品模式下的分组结构（其他 Tab 用平坦 categories） */
    groupedCategories: [] as GroupedCategory[],
    /** PR-B：普通商品模式下，当前选中的 category id（驱动 active 样式 + SKU 刷新） */
    activeCategoryId: '' as string,
    spuList: [] as DisplayItem[],
    /** 普通商品名称模糊查询关键词 */
    productKeyword: '',
    /** 是否处于搜索态（普通商品跨分类匹配；驱动空态文案 + 恢复分类逻辑） */
    searching: false,
    // 组合套餐（BundlePicker 数据源）
    bundleSpus: [] as BundleSpu[],
    skuMap: {} as Record<string, SkuItem>,
    /** 卡类型（体验卡/充值卡）→ grid 简化布局 */
    isCardType: false,
    // 购物车
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: '0.00',
    cartPopupVisible: false,
    // 结算底部弹层
    showCheckout: false,
    checkoutStep: 0,   // 0=选顾客 2=确认（Step 1 历史遗留编号，已废弃）
    // Step 0: 顾客
    customerKeyword: '',
    customerSearching: false,
    customerInfo: null as null | CustomerInfo,
    customerResults: [] as CustomerInfo[],
    recentCustomers: [] as CustomerInfo[],
    // Step 2 顶部：订单类型 4 选 1（PR-C §C1）
    saleOrderType: '销售单' as SaleOrderType,
    /** 内部单半价合计（行原价 × 0.5 之和） */
    halfPriceTotal: '0.00',
    /** 应付合计：销售单/寄存单 = cartTotal - couponDiscount；内部单 = halfPriceTotal - couponDiscount */
    payableTotal: '0.00',
    /** 实付合计：Σ(cart[i].received)；店长可改行实付 → 此处即时更新 */
    receivedTotal: '0.00',
    // Step 2: 确认 + 备注
    remark: '',
    submitting: false,
    /**
     * 销售单 / 内部单的支付方式（默认微信）
     * - 仅作用于 saleOrderType ∈ {销售单, 内部单}（转换单的支付方式由 ConversionPanel 内部管理）
     * - 白名单：'微信' | '支付宝' | '线下'
     */
    paymentMethod: '微信' as '微信' | '支付宝' | '线下',
    /**
     * 充值卡抵扣（预选 Wave 3G；DB 字段 prepaid_card_amount 命名保持不变，UI 文案统一为「充值卡」）
     * - customerCardBalance：顾客当前余额（跨店统一），由 customer.customerBalance 加载
     * - useCard：店长预选开关，默认根据余额自动开（>0 开）
     * - prepaidCardAmount / paidAmount：computePrepaidDeduction 计算结果（不影响后端 balance，仅作 payload 与 UI 展示）
     * - showPayMethodGroup：paid > 0 时展示支付方式按钮组；paid = 0 时隐藏
     * - prepaidCardLoaded：避免重复请求；customerBalanceLoading：拉取中态
     */
    customerCardBalance: 0 as number,
    useCard: false as boolean,
    prepaidCardAmount: 0 as number,
    paidAmount: '0.00' as string,
    showPayMethodGroup: true as boolean,
    prepaidCardLoaded: false as boolean,
    customerBalanceLoading: false as boolean,
    // 转换单（ConversionPanel 反馈 → 主页记录用于提交）
    conversionSelectedSaleItemIds: [] as string[],
    conversionDeductibleSum: 0,
    conversionPriceDiff: 0,
    conversionPaymentMethod: null as null | '微信' | '线下',
    /** 转换单补差额充值卡抵扣额（ConversionPanel 反馈） */
    conversionPrepaidCardAmount: 0,
    /** 转换单抵扣后仍需付现金（priceDiff - prepaidCardAmount） */
    conversionRemaining: 0,
    // 优惠券
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    couponTotal: '',
    showCouponPopup: false,
    availableCoupons: [] as CouponInfo[],
    couponsLoading: false,
    // 指定美容师（可选，用于默认分配）
    preferredStaffWfId: '' as string,
    preferredStaffName: '',
    showStaffPicker: false,
    staffListForPicker: [] as Array<{ staffWfId: string; name: string; department: string; skills?: string[] }>,
    staffPickerColumns: [] as string[],
  },

  // 所有分类（未过滤）
  _allCategories: [] as Category[],
  /**
   * PR-B：从 shopInit 获取的"普通商品"分组结构（已排除卡类 + 空分类）。
   * 仅在 productKindChoice === '普通商品' 时使用。
   */
  _allGroupedCategories: [] as GroupedCategory[],
  // 所有 SKU（未过滤，shopInit 一次性返回全量）
  _allSkus: [] as SkuItem[],
  /** 体验卡 Tab 扁平 SKU 列表（is_experience=true，不与 _allSkus 混用以免污染普通商品过滤语义） */
  _experienceSkus: [] as SkuItem[],
  // SKU 缓存：按 `${productKindChoice}:${categoryId}` 缓存已加载的展示列表
  _spuCache: {} as Record<string, DisplayItem[]>,
  /** 普通商品搜索防抖计时器 */
  _kwTimer: null as ReturnType<typeof setTimeout> | null,

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isManager: isManager() });
    if (this._allCategories.length === 0) {
      this.loadShopInit();
    }
    try {
      const recent: CustomerInfo[] = wx.getStorageSync('recentCustomers') || [];
      const valid = recent.filter((c) => c && c.id);
      if (valid.length !== recent.length) {
        wx.setStorageSync('recentCustomers', valid);
      }
      this.setData({ recentCustomers: valid });
    } catch (_) {}

    // 从商品详情页返回：检查 pendingCartItem
    const pending = app.globalData.pendingCartItem;
    if (pending) {
      app.globalData.pendingCartItem = null;

      // 组合套餐商品不加入购物车，只能直接下单（清空购物车后单独放入）
      if (pending.productType === '组合套餐') {
        const cart: CartItem[] = [{
          spuId: pending.spuId,
          skuId: pending.skuId,
          spuName: pending.spuName,
          specName: pending.specName,
          price: pending.price,
          listPrice: pending.price,
          specialPrice: null,
          quantity: pending.quantity,
          sessionCount: pending.sessionCount || 0,
          productType: pending.productType,
          workfineItemId: pending.workfineItemId || '',
          priceLine: '', couponShare: '0.00', saleAmount: '', halfPriceSaleAmount: '', received: '',
        }];
        this.updateCart(cart);
      } else {
        const cart = [...this.data.cart];
        // 购物车中有组合套餐商品时不允许混入其他商品
        if (cart.some(c => c.productType === '组合套餐')) {
          wx.showToast({ title: '组合套餐订单需单独下单', icon: 'none' });
          return;
        }
        const existing = cart.findIndex(c => c.skuId === pending.skuId);
        if (existing >= 0) {
          cart[existing].quantity += pending.quantity;
        } else {
          cart.push({
            spuId: pending.spuId,
            skuId: pending.skuId,
            spuName: pending.spuName,
            specName: pending.specName,
            price: pending.price,
            listPrice: pending.price,
            specialPrice: null,
            quantity: pending.quantity,
            sessionCount: pending.sessionCount || 0,
            productType: pending.productType,
            workfineItemId: pending.workfineItemId || '',
            priceLine: '', couponShare: '0.00', saleAmount: '', halfPriceSaleAmount: '', received: '',
          });
        }
        this.updateCart(cart);
      }
      if (pending.directCheckout) {
        // PR-C §C6：旧 orderType='promotion' 分支删除；saleOrderType 默认 '销售单'
        this.setData({ showCheckout: true, checkoutStep: 0, saleOrderType: '销售单' });
      }
    }
  },

  // ===== 商品目录（三级导航 + 缓存） =====

  async loadShopInit() {
    this.setData({ catalogLoading: true });
    try {
      const data = await callStaffApi<ShopInitResponse>('product.shopInit');
      const categories: Category[] = data.categories || [];
      const groupedCategories: GroupedCategory[] = data.groupedCategories || [];
      const rawSkus: SkuItem[] = data.skuList || [];
      const bundleSpus: BundleSpu[] = data.mallBundleGroups || [];
      const experienceSkus: SkuItem[] = data.experienceSkus || [];

      this._allCategories = categories;
      this._allGroupedCategories = groupedCategories;
      this._allSkus = rawSkus;
      this._experienceSkus = experienceSkus;
      this._spuCache = {};

      const skuMap: Record<string, SkuItem> = {};
      for (const s of rawSkus) skuMap[s.skuId] = s;
      // 体验卡 SKU 也写入 skuMap（购物车/详情页查 skuMap 时需要），但不并入 _allSkus 以保持其"非卡类首分类预取"语义。
      for (const s of experienceSkus) skuMap[s.skuId] = s;

      this.setData({ bundleSpus, skuMap, catalogLoading: false });
      this.applyKindChoice(this.data.productKindChoice);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ catalogLoading: false });
    }
  },

  /**
   * 按 productKindChoice 过滤侧边栏 + SKU 列表
   * 组合套餐不走此路径（由 BundlePicker 接管，主区域通过 wx:if 切视图）
   *
   * PR-B：
   * - 普通商品模式下使用后端返回的 `groupedCategories`（已排除卡类 + EXISTS 过滤）
   *   渲染自定义分组侧边栏；activeCategoryId 驱动 active 样式
   * - 其他 Tab 仍用平坦 `categories` + `<van-sidebar>`
   */
  applyKindChoice(choice: ProductKindChoice) {
    const isCardType = choice === '体验卡' || choice === '充值卡';
    this.setData({ isCardType });

    if (choice === '组合套餐') {
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: [],
      });
      return;
    }

    // 普通商品模式：用后端返回的分组结构渲染侧边栏
    if (choice === '普通商品') {
      // 防御：过滤掉 items 为空的组（ticket §6.3 空防御）
      const groups = this._allGroupedCategories.filter(g => g.items && g.items.length > 0);
      if (groups.length === 0) {
        this.setData({
          categories: [],
          groupedCategories: [],
          activeCategoryIndex: 0,
          activeCategoryId: '',
          spuList: [],
        });
        return;
      }
      // 平坦 categories（向后兼容：其他消费方可能仍读 categories 数组）
      const flatCategories = groups.reduce<Category[]>((acc, g) => acc.concat(g.items), []);
      const firstCat = groups[0].items[0];
      const firstCatId = firstCat.id;
      const cacheKey = `${choice}:${firstCatId}`;
      let list = this._spuCache[cacheKey];
      if (!list) {
        const skusInCat = this._allSkus.filter(s => s.categoryId === firstCatId);
        list = filterSkusByKindChoice(skusInCat, choice).map(skuToDisplay);
        this._spuCache[cacheKey] = list;
      }
      this.setData({
        categories: flatCategories,
        groupedCategories: groups,
        activeCategoryIndex: 0,
        activeCategoryId: firstCatId,
        spuList: list,
      });
      return;
    }

    // 体验卡：扁平 SKU 列表（无分类侧边栏，参照 admin TrialCardPicker）
    if (choice === '体验卡') {
      const list = this._experienceSkus.map(skuToDisplay);
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: list,
        isCardType: false,
      });
      return;
    }

    // 充值卡：保留平坦 <van-sidebar>（实际由 onBigCategoryChange 截走跳转 card-recharge，不会真渲染）
    const filtered = filterCategoriesByKindChoice(this._allCategories, choice);
    if (filtered.length === 0) {
      this.setData({
        categories: [],
        groupedCategories: [],
        activeCategoryIndex: 0,
        activeCategoryId: '',
        spuList: [],
      });
      return;
    }

    const firstCatId = filtered[0].id;
    const cacheKey = `${choice}:${firstCatId}`;
    let list = this._spuCache[cacheKey];
    if (!list) {
      // 首次进入该 choice 的首分类：从 _allSkus 本地过滤
      const skusInCat = this._allSkus.filter(s => s.categoryId === firstCatId);
      list = filterSkusByKindChoice(skusInCat, choice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
    }

    // 先把 activeCategoryIndex 置 -1 强制 van-sidebar 刷新
    this.setData({
      categories: filtered,
      groupedCategories: [],
      activeCategoryIndex: -1,
      activeCategoryId: firstCatId,
      spuList: [],
    }, () => {
      this.setData({ activeCategoryIndex: 0, spuList: list });
    });
  },

  onBigCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as { index?: number })?.index;
    if (typeof index !== 'number' || index === this.data.productKindChoiceIndex) return;
    const nextChoice = PRODUCT_KIND_CHOICES[index];
    if (!nextChoice) return;

    // 充值卡 Tab 走独立流程：不进购物车/结算弹层，直接跳 card-recharge 页
    // 点完后保留原 Tab 选择（让 Tab 组件视觉上"弹回"），避免切换后的 SKU 列表被清空
    // 所有员工均可浏览充值卡面板；真正提交时在 card-recharge.onSubmit 处统一校验店长权限
    if (nextChoice === '充值卡') {
      const customer = this.data.customerInfo;
      const params: string[] = [];
      if (customer?.clientUserId) {
        params.push(`clientUserId=${encodeURIComponent(customer.clientUserId)}`);
        if (customer.name) params.push(`customerName=${encodeURIComponent(customer.name)}`);
        if (customer.phone) params.push(`customerPhone=${encodeURIComponent(customer.phone)}`);
      }
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      wx.navigateTo({ url: `/packageOrder/card-recharge/card-recharge${qs}` });
      // Tab 回弹到原选择（不改 productKindChoiceIndex / productKindChoice）
      return;
    }

    const apply = () => {
      if (this._kwTimer) clearTimeout(this._kwTimer);
      this.setData({
        productKindChoiceIndex: index,
        productKindChoice: nextChoice,
        productKeyword: '',
        searching: false,
      });
      this.applyKindChoice(nextChoice);
    };

    // 切商品类型时购物车非空 → 确认清空（B4）
    if (this.data.cart.length > 0) {
      wx.showModal({
        title: '切换商品类型',
        content: '切换后将清空购物车，是否继续？',
        confirmColor: '#C0322A',
        success: (res) => {
          if (res.confirm) {
            this.updateCart([]);
            apply();
          }
        },
      });
      return;
    }
    apply();
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === 'number' ? e.detail : (e.detail as { key?: number })?.key;
    if (typeof index !== 'number') return;
    const { categories, productKindChoice } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const cat = categories[index];
    if (!cat) return;

    const cacheKey = `${productKindChoice}:${cat.id}`;
    const cached = this._spuCache[cacheKey];
    if (cached) {
      this.setData({ activeCategoryIndex: index, activeCategoryId: cat.id, spuList: cached });
      return;
    }

    this.setData({ activeCategoryIndex: index, activeCategoryId: cat.id, spuList: [] });
    this.loadSpuList(cat.id);
  },

  /**
   * PR-B：普通商品模式下的 category 子项点击（自定义分组侧边栏）
   * group header 不可点击，子项通过 data-id 传递 categoryId
   */
  onGroupedCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const categoryId = e.currentTarget.dataset.id as string;
    if (!categoryId) return;
    // 点分类即退出搜索态（清空关键词）
    const wasSearching = this.data.searching;
    if (this.data.productKeyword) {
      if (this._kwTimer) clearTimeout(this._kwTimer);
      this.setData({ productKeyword: '', searching: false });
    }
    // 点回当前分类：搜索态下需用缓存恢复分类列表，非搜索态则无变化
    if (categoryId === this.data.activeCategoryId) {
      if (wasSearching) {
        const cacheKey = `${this.data.productKindChoice}:${categoryId}`;
        this.setData({ spuList: this._spuCache[cacheKey] || [] });
      }
      return;
    }

    const { productKindChoice } = this.data;
    // 同步 activeCategoryIndex（在扁平 categories 中找到对应索引，保证 van-sidebar 回退场景时一致）
    const index = this.data.categories.findIndex(c => c.id === categoryId);

    const cacheKey = `${productKindChoice}:${categoryId}`;
    const cached = this._spuCache[cacheKey];
    if (cached) {
      this.setData({
        activeCategoryId: categoryId,
        activeCategoryIndex: index >= 0 ? index : this.data.activeCategoryIndex,
        spuList: cached,
      });
      return;
    }

    this.setData({
      activeCategoryId: categoryId,
      activeCategoryIndex: index >= 0 ? index : this.data.activeCategoryIndex,
      spuList: [],
    });
    this.loadSpuList(categoryId);
  },

  async loadSpuList(categoryId: string) {
    const { productKindChoice } = this.data;
    const cacheKey = `${productKindChoice}:${categoryId}`;

    // 优先用本地 _allSkus 过滤（shopInit 已返全量）
    const localSkus = this._allSkus.filter(s => s.categoryId === categoryId);
    if (localSkus.length > 0) {
      const list = filterSkusByKindChoice(localSkus, productKindChoice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list });
      return;
    }

    // 本地无缓存兜底：发请求（普通商品传 excludeCards 让后端按 capability 排除卡类 SKU）
    this.setData({ catalogLoading: true });
    try {
      const skus = await callStaffApi<SkuItem[]>('product.skuList', {
        categoryId,
        excludeCards: productKindChoice === '普通商品',
      });
      // 追加到 _allSkus（便于后续缓存命中）
      this._allSkus = this._allSkus.concat(skus || []);
      const list = filterSkusByKindChoice(skus || [], productKindChoice).map(skuToDisplay);
      this._spuCache[cacheKey] = list;
      this.setData({ spuList: list, catalogLoading: false });
    } catch (_) {
      this.setData({ spuList: [], catalogLoading: false });
    }
  },

  // ===== 普通商品名称模糊查询（跨分类全量匹配）=====

  onProductKeywordChange(e: WechatMiniprogram.CustomEvent) {
    const kw = ((e.detail as unknown as string) || '').trim();
    this.setData({ productKeyword: kw });
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this._kwTimer = setTimeout(() => this.applyProductSearch(), 200);
  },

  onProductKeywordClear() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this.setData({ productKeyword: '' });
    this.applyProductSearch();
  },

  /**
   * 应用普通商品搜索：
   * - 关键词为空 → 恢复当前分类视图（读 _spuCache）
   * - 关键词非空 → 在全量普通商品 SKU 中按名称模糊匹配（忽略当前分类）
   */
  applyProductSearch() {
    const kw = this.data.productKeyword.trim().toLowerCase();
    if (!kw) {
      const cacheKey = `普通商品:${this.data.activeCategoryId}`;
      this.setData({ searching: false, spuList: this._spuCache[cacheKey] || [] });
      return;
    }
    const matched = filterSkusByKindChoice(this._allSkus, '普通商品')
      .filter(s => (s.specName || '').toLowerCase().includes(kw))
      .map(skuToDisplay);
    this.setData({ searching: true, spuList: matched });
  },

  // ===== BundlePicker 选完后覆盖购物车并直接进入下单流程 =====
  // 组合套餐独占：不进共享购物车（避免与普通商品混单），点 "去下单" 一步到结算

  onBundlePickerSelect(e: WechatMiniprogram.CustomEvent) {
    const { cartItems } = (e.detail || {}) as { cartItems?: CartItem[]; bundleName?: string };
    if (!cartItems || cartItems.length === 0) return;
    this.updateCart(cartItems);
    // 与 admin 一致：选完直接弹结算面板（Step 0：选顾客）
    this.onOpenCheckout();
  },

  // ===== SPU 点击 → 跳转详情页 =====

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const item = e.currentTarget.dataset.spu as DisplayItem;
    if (!item?.spuId) return;

    // SKU 扁平化后直接加入购物车（qty=1）
    const cart = [...this.data.cart];

    // 购物车中有组合套餐行（refBundleId / productType='组合套餐'）时不允许混入其他商品
    if (cart.some(c => c.refBundleId || c.productType === '组合套餐')) {
      wx.showToast({ title: '组合套餐订单需单独下单', icon: 'none' });
      return;
    }

    const existing = cart.findIndex(c => c.skuId === item.spuId);
    if (existing >= 0) {
      if (cart[existing].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      cart[existing].quantity += 1;
    } else {
      cart.push({
        spuId: item.spuId,
        skuId: item.spuId,
        spuName: item.spuName,
        specName: item.spuName,
        price: item.price,
        listPrice: item.listPrice,
        specialPrice: item.specialPrice,
        quantity: 1,
        sessionCount: item.sessionCount || 0,
        productType: item.productKind || item.productType,
        workfineItemId: '',
        priceLine: '', couponShare: '0.00', saleAmount: '', halfPriceSaleAmount: '', received: '',
      });
    }
    this.updateCart(cart);
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 800 });
  },

  // ===== 购物车 =====

  onOpenCartPopup() {
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }
    this.setData({ cartPopupVisible: true });
  },

  onCloseCartPopup() {
    this.setData({ cartPopupVisible: false });
  },

  onClearCart() {
    wx.showModal({
      title: '清空已选项目',
      content: '确定清空购物车？组合套餐项目会保留。',
      confirmColor: '#C0322A',
      success: (res) => {
        if (!res.confirm) return;
        // 组合套餐项目受保护（与逐项删除逻辑一致）
        const cart = this.data.cart.filter(c => c.productType === '组合套餐' || c.refBundleId);
        this.updateCart(cart);
        if (cart.length === 0) this.setData({ cartPopupVisible: false });
      },
    });
  },

  onCartItemRemove(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const item = this.data.cart.find(c => c.skuId === skuId);
    // PR-B: 组合套餐生成的多行（refBundleId 同源）整组清空
    if (item?.refBundleId) {
      const refId = item.refBundleId;
      const cart = this.data.cart.filter(c => c.refBundleId !== refId);
      this.updateCart(cart);
      return;
    }
    if (item?.productType === '组合套餐') {
      wx.showToast({ title: '组合套餐项目不可删除', icon: 'none' });
      return;
    }
    const cart = this.data.cart.filter(c => c.skuId !== skuId);
    this.updateCart(cart);
  },

  onCartQtyChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const qty = parseInt(e.detail as unknown as string) || 1;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx >= 0) {
      if (cart[idx].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      cart[idx].quantity = qty;
    }
    this.updateCart(cart);
  },

  /**
   * 行级「实付金额」编辑（店长可向下调；区间 0 ≤ received ≤ 行应付金额）。
   * - 销售单/寄存单：上限 = saleAmount（priceLine - couponShare）
   * - 内部单：上限 = halfPriceSaleAmount
   * - 空字符串等同于默认（=应付金额）
   */
  onReceivedChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = (e.detail?.value ?? '') as string;
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx < 0) return;
    const row = cart[idx];
    const cap = parseFloat(
      this.data.saleOrderType === '内部单' ? row.halfPriceSaleAmount : row.saleAmount
    ) || 0;
    const parsed = parseFloat(raw);
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      row.received = cap.toFixed(2);
    } else {
      const clamped = Math.min(parsed, cap);
      row.received = (Math.round(clamped * 100) / 100).toFixed(2);
    }
    this.updateCart(cart, { preserveReceived: true });
  },

  /**
   * 重算 cart 行的预算字段（价格 / 摊到的券 / 应付 / 半价应付 / 实付默认）
   * - opts.preserveReceived = true：保留用户手动改过的 received（仅在 saleAmount/halfPriceSaleAmount 因外部 input 变化时归一化裁剪到上限）
   * - 否则 received 全部回归默认值（= 当前订单类型下的应付）
   */
  updateCart(cart: CartItem[], opts?: { preserveReceived?: boolean }) {
    // 1) 先填 priceLine（"价格"列）
    for (const c of cart) {
      c.priceLine = (c.price * c.quantity).toFixed(2);
    }
    // 2) 按订单类型确定"摊券基线"：销售单/寄存单 = price × qty；内部单 = price × 0.5 × qty
    const isInternal = this.data.saleOrderType === '内部单';
    const baseLines = cart.map(c => {
      if (isInternal) {
        const halfUnit = Math.round(c.price * 50) / 100;
        return halfUnit * c.quantity;
      }
      return c.price * c.quantity;
    });
    // 3) 按行应付比例摊订单级优惠券折扣（couponDiscount 已在 onCouponPick 时落到 data）
    const shares = allocateCouponPerLine(baseLines, this.data.couponDiscount || 0);
    for (let i = 0; i < cart.length; i++) {
      const c = cart[i];
      const share = shares[i] || 0;
      c.couponShare = share.toFixed(2);
      // 销售单/寄存单的应付金额（不走半价）
      const saleAmountNum = Math.max(0, Math.round((c.price * c.quantity - share) * 100) / 100);
      c.saleAmount = saleAmountNum.toFixed(2);
      // 内部单专用的应付金额（先半价、再扣摊到的券）
      const halfUnit = Math.round(c.price * 50) / 100;
      const halfSaleNum = Math.max(0, Math.round((halfUnit * c.quantity - (isInternal ? share : 0)) * 100) / 100);
      c.halfPriceSaleAmount = halfSaleNum.toFixed(2);
      // 实付默认 = 当前订单类型下的应付
      const cap = (isInternal ? halfSaleNum : saleAmountNum);
      if (opts?.preserveReceived && c.received) {
        const prev = parseFloat(c.received) || 0;
        c.received = Math.min(prev, cap).toFixed(2);
      } else {
        c.received = cap.toFixed(2);
      }
    }
    const { count, total } = calcCartTotal(cart);
    const halfPriceTotal = calcHalfPriceTotal(cart);
    // 应付合计 = Σ(行应付)；实付合计 = Σ(行实付)
    let payableSum = 0, receivedSum = 0;
    for (const c of cart) {
      payableSum += parseFloat(isInternal ? c.halfPriceSaleAmount : c.saleAmount) || 0;
      receivedSum += parseFloat(c.received) || 0;
    }
    const update: Record<string, any> = {
      cart, cartCount: count, cartTotal: total, halfPriceTotal,
      payableTotal: payableSum.toFixed(2),
      receivedTotal: receivedSum.toFixed(2),
    };
    if (this.data.couponDiscount > 0) {
      update.couponTotal = payableSum.toFixed(2);
    }
    // 空车时自动关闭已选项目弹层
    if (count === 0 && this.data.cartPopupVisible) {
      update.cartPopupVisible = false;
    }
    this.setData(update);
    // cart 变动后重新评估已选优惠券（未选券时内部短路，零开销）
    void this.revalidateCoupon();
    // cart 变动后重算充值卡预选（仅在弹层 Step 2 已加载余额时生效）
    this.recomputePrepaidAmounts();
  },

  // ===== 结算面板 =====

  onOpenCheckout() {
    if (this.data.cart.length === 0) {
      wx.showToast({ title: '请先添加商品', icon: 'none' });
      return;
    }
    this.setData({
      showCheckout: true,
      checkoutStep: 0,
      saleOrderType: '销售单',
      // 重置转换单 state
      conversionSelectedSaleItemIds: [],
      conversionDeductibleSum: 0,
      conversionPriceDiff: 0,
      conversionPaymentMethod: null,
      conversionPrepaidCardAmount: 0,
      conversionRemaining: 0,
      // 重置储值卡预选 state（避免上次 customer 残值；进入 Step 2 时再加载）
      customerCardBalance: 0,
      useCard: false,
      prepaidCardAmount: 0,
      paidAmount: '0.00',
      showPayMethodGroup: true,
      prepaidCardLoaded: false,
    });
  },

  onCloseCheckout() {
    this.setData({ showCheckout: false });
  },

  // Step 0: 选顾客
  onCustomerKeywordChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customerKeyword: e.detail as unknown as string, customerInfo: null, customerResults: [] });
  },

  async onSearchCustomer() {
    const keyword = this.data.customerKeyword.trim();
    if (!keyword) {
      wx.showToast({ title: '请输入顾客姓名或手机号', icon: 'none' });
      return;
    }
    this.setData({ customerSearching: true });
    try {
      // 跨门店模糊检索：绑定任意门店的顾客均可开单
      const results = await callStaffApi<CustomerInfo[]>('customer.search', { keyword, crossStore: true });
      if (!results || results.length === 0) {
        this.setData({ customerInfo: null, customerResults: [] });
        wx.showToast({ title: '未找到该顾客（需已绑定门店）', icon: 'none' });
      } else if (results.length === 1) {
        this.setData({ customerInfo: results[0], customerResults: [] });
      } else {
        this.setData({ customerInfo: null, customerResults: results });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '查询失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onSelectCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = e.currentTarget.dataset.customer as CustomerInfo;
    this.setData({ customerInfo: customer, customerResults: [], customerKeyword: customer.phone || customer.name });
  },

  onSelectRecentCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = e.currentTarget.dataset.customer as CustomerInfo;
    this.setData({ customerInfo: customer, customerKeyword: customer.phone, customerResults: [] });
  },

  onStep0Next() {
    if (!this.data.customerInfo) {
      wx.showModal({
        title: '无法开单',
        content: '请先用手机号搜索并选择已绑定门店的顾客。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    // PR-B: Step 1 "选开单模式" 已废除；Step 0 → Step 2 直跳确认页。
    // Step 1 当前为空占位，PR-C 将填入"订单类型 3 选 1"。
    this.setData({ checkoutStep: 2 });
    // 进入 Step 2：拉取顾客储值卡余额（跨店统一）。失败静默兜底为 0
    void this.loadCustomerBalance();
  },

  // ===== 储值卡预选（Wave 3G）=====

  /**
   * 拉取顾客储值卡余额（跨店统一）。
   * - 仅在 Step 2 入场时调用一次（prepaidCardLoaded=true 后直到关闭弹层不再拉）
   * - 余额 > 0 时 useCard 默认开（决策 #1：能抵多少抵多少）
   * - 失败兜底为 0：UI 退化为"无可用余额"，不阻塞开单
   */
  async loadCustomerBalance() {
    const customer = this.data.customerInfo;
    if (!customer?.clientUserId || this.data.prepaidCardLoaded) {
      // 即便已加载，进入 Step 2 仍触发一次 recompute（覆盖切回 Step 0 修改后再回来的场景）
      this.recomputePrepaidAmounts();
      return;
    }
    this.setData({ customerBalanceLoading: true });
    try {
      const data = await callStaffApi<CustomerBalanceResponse>('customer.customerBalance', {
        customerUserId: customer.clientUserId,
      });
      const balance = Math.max(0, Number(data?.balance) || 0);
      this.setData({
        customerCardBalance: balance,
        useCard: balance > 0,
        prepaidCardLoaded: true,
      });
    } catch (_) {
      // 静默兜底：拉取失败则视为 0 余额、useCard=off，不阻塞开单
      this.setData({
        customerCardBalance: 0,
        useCard: false,
        prepaidCardLoaded: true,
      });
    } finally {
      this.setData({ customerBalanceLoading: false });
      this.recomputePrepaidAmounts();
    }
  },

  /**
   * 重算充值卡抵扣额与实付额（与顾客端 checkout 算法口径一致）
   * - 仅当弹层处于 Step 2 且 saleOrderType ∈ {销售单, 内部单} 时生效
   *   （转换单走 ConversionPanel 内部金额管理；不参与本预选 UI）
   * - 应付合计已在 updateCart 中算好（payableTotal 字段，含券摊算与内部单半价）
   */
  recomputePrepaidAmounts() {
    if (this.data.saleOrderType === '转换单') {
      this.setData({ prepaidCardAmount: 0, paidAmount: '0.00', showPayMethodGroup: true });
      return;
    }
    const payable = parseFloat(this.data.payableTotal) || 0;
    const result = computePrepaidDeduction({
      payableAmount: payable,
      customerCardBalance: this.data.customerCardBalance || 0,
      useCard: !!this.data.useCard,
    });
    this.setData({
      prepaidCardAmount: result.prepaidCardAmount,
      paidAmount: result.paidAmount.toFixed(2),
      showPayMethodGroup: result.showPayMethodGroup,
    });
  },

  /** 切换"预选抵扣"开关 */
  onTogglePrepaidCard(e: WechatMiniprogram.CustomEvent) {
    // van-switch 的 detail 是 boolean
    const next = !!e.detail;
    if (next === this.data.useCard) return;
    if (next && this.data.customerCardBalance <= 0) {
      // 余额为 0 时禁止开启（UI 已 disabled，防御性再拒）
      return;
    }
    this.setData({ useCard: next });
    this.recomputePrepaidAmounts();
  },

  /**
   * PR-C §C1 / §C5 — 订单类型 4 选 1 切换
   * - 所有员工均可选中任一订单类型；店长权限只在 onSubmitOrder 入口统一校验
   * - 转换单/寄存单守卫：clientUserId 必填（未注册顾客禁用对应 tab）
   * - 切走销售单/转换单后清空优惠券（内部单/转换单均不允许券）
   * - 切出转换单清空转换 state
   */
  onSelectSaleOrderType(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.type as SaleOrderType;
    if (!next || next === this.data.saleOrderType) return;
    if ((next === '转换单' || next === '寄存单') && !this.data.customerInfo) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    const update: Record<string, any> = { saleOrderType: next };
    if (next !== '销售单' && this.data.selectedCoupon) {
      update.selectedCoupon = null;
      update.couponDiscount = 0;
      update.couponTotal = '';
    }
    if (next !== '转换单') {
      update.conversionSelectedSaleItemIds = [];
      update.conversionDeductibleSum = 0;
      update.conversionPriceDiff = 0;
      update.conversionPaymentMethod = null;
      update.conversionPrepaidCardAmount = 0;
      update.conversionRemaining = 0;
    } else {
      // PR-D1：切到转换单时重置销售/内部单的 paymentMethod，避免脏值（转换单走 ConversionPanel 内部 picker）
      update.paymentMethod = '微信';
    }
    // B5：寄存单清空储值卡预选（不允许任何抵扣）
    if (next === '寄存单') {
      update.useCard = false;
      update.prepaidCardAmount = 0;
    }
    // saleOrderType 切换会改变行的 saleAmount（销售单/寄存单 vs 内部单），
    // 需要重算应付/实付汇总（updateCart 末尾自动触发 recomputePrepaidAmounts）
    this.setData(update);
    this.updateCart(this.data.cart);
  },

  /** PR-C §C3 — ConversionPanel 子组件 change 事件：同步选卡/差额到主 state */
  onConversionPanelChange(e: WechatMiniprogram.CustomEvent) {
    const { selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod, prepaidCardAmount, remaining } = (e.detail || {}) as {
      selectedSaleItemIds?: string[];
      deductibleSum?: number;
      priceDiff?: number;
      paymentMethod?: '微信' | '线下' | null;
      prepaidCardAmount?: number;
      remaining?: number;
    };
    this.setData({
      conversionSelectedSaleItemIds: selectedSaleItemIds || [],
      conversionDeductibleSum: Number(deductibleSum) || 0,
      conversionPriceDiff: Number(priceDiff) || 0,
      conversionPaymentMethod: paymentMethod ?? null,
      conversionPrepaidCardAmount: Number(prepaidCardAmount) || 0,
      conversionRemaining: Number(remaining) || 0,
    });
  },

  /**
   * 支付方式切换（仅销售单/内部单生效；转换单的支付方式由 ConversionPanel 内部管理）
   * 白名单：'微信' | '支付宝' | '线下'
   */
  onPaymentMethodTap(e: WechatMiniprogram.TouchEvent) {
    const next = e.currentTarget.dataset.method as '微信' | '支付宝' | '线下';
    if (!next || (next !== '微信' && next !== '支付宝' && next !== '线下')) return;
    if (next === this.data.paymentMethod) return;
    this.setData({ paymentMethod: next });
  },

  // Step 2: 确认订单
  onRemarkChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as unknown as string) ?? '' });
  },

  onStep2Back() {
    // PR-B: 直接返回 Step 0（跳过空占位 Step 1）
    this.setData({ checkoutStep: 0 });
  },

  // ===== 优惠券选择 =====

  async onSelectCoupon() {
    const { customerInfo, cart } = this.data;
    if (!customerInfo?.phone) return;

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: c.price * c.quantity,
      }));
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      this.setData({ availableCoupons: data?.coupons || [] });
    } catch {
      this.setData({ availableCoupons: [] });
    } finally {
      this.setData({ couponsLoading: false });
    }
  },

  onCloseCouponPopup() {
    this.setData({ showCouponPopup: false });
  },

  onCouponPick(e: WechatMiniprogram.TouchEvent) {
    const { couponId, name, discount } = e.currentTarget.dataset as {
      couponId: string; name: string; discount: number;
    };
    const d = Number(discount) || 0;
    this.setData({
      selectedCoupon: { couponId, name, discount: d },
      couponDiscount: d,
      showCouponPopup: false,
    });
    // 券变化触发 cart 行 couponShare/saleAmount/received 全量重算
    this.updateCart(this.data.cart);
  },

  onClearCoupon() {
    this.setData({ selectedCoupon: null, couponDiscount: 0, couponTotal: '', showCouponPopup: false });
    this.updateCart(this.data.cart);
  },

  /**
   * cart 变动后重新评估已选优惠券
   * - 未选券 / 未选顾客时短路返回
   * - 原券仍在可用列表 → discount 变化则更新（品项券可能因 cart 变化而变）
   * - 原券已不在列表 → 清空选择并 Toast 提示
   * 决策纯函数在 utils/coupon-evaluator.ts，便于单测
   */
  async revalidateCoupon() {
    const { selectedCoupon, customerInfo, cart } = this.data;
    if (!selectedCoupon || !customerInfo?.phone) return;
    try {
      const items = cart.map(c => ({
        skuId: c.skuId,
        quantity: c.quantity,
        amount: Math.round(c.price * c.quantity * 100) / 100,
      }));
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      const result = evaluateCouponAfterCartChange(
        selectedCoupon.couponId,
        selectedCoupon.discount,
        data?.coupons || []
      );
      if (result.kind === 'cleared') {
        this.setData({
          selectedCoupon: null,
          couponDiscount: 0,
          couponTotal: '',
        });
        // 券失效后需重算行 couponShare/saleAmount/received（updateCart 已含逻辑）
        this.updateCart(this.data.cart);
        wx.showToast({ title: '商品已变动，原优惠券已失效', icon: 'none' });
      } else if (result.kind === 'updated') {
        this.setData({
          selectedCoupon: { ...selectedCoupon, discount: result.discount },
          couponDiscount: result.discount,
        });
        this.updateCart(this.data.cart);
      }
    } catch {
      // 评估失败保持原状，提交时由后端兜底拒绝
    }
  },

  // ===== 指定美容师 =====

  async onSelectPreferredStaff() {
    if (this.data.staffListForPicker.length === 0) {
      try {
        const data = await callStaffApi<{ staffList: Array<{ staffWfId: string; name: string; department: string; skills?: string[] }> }>('staff.list');
        const list = data?.staffList || [];
        const roleTag = (skills?: string[]) => (skills || []).filter(s => s === '美容师' || s === '养生师').join('/');
        this.setData({
          staffListForPicker: list,
          staffPickerColumns: ['不指定', ...list.map(s => `${s.name}（${[roleTag(s.skills), s.department].filter(Boolean).join('·') || '未分组'}）`)],
        });
      } catch {
        return;
      }
    }
    this.setData({ showStaffPicker: true });
  },

  onStaffPickerClose() {
    this.setData({ showStaffPicker: false });
  },

  onPreferredStaffConfirm(e: WechatMiniprogram.CustomEvent) {
    const picked = e.detail.value as string;
    if (picked === '不指定') {
      this.setData({ preferredStaffWfId: '', preferredStaffName: '', showStaffPicker: false });
      return;
    }
    const idx = this.data.staffPickerColumns.indexOf(picked) - 1; // offset by "不指定"
    const staff = this.data.staffListForPicker[idx];
    if (staff) {
      this.setData({
        preferredStaffWfId: staff.staffWfId,
        preferredStaffName: staff.name,
        showStaffPicker: false,
      });
    }
  },

  async onSubmitOrder() {
    const { customerInfo, saleOrderType, cart, remark, submitting } = this.data;
    if (!customerInfo || submitting) return;

    // 统一店长权限网关：所有订单类型（销售单/内部单/转换单/寄存单）的最终提交都走此处
    if (!this.data.isManager) {
      wx.showToast({ title: '您无开单权限，请联系店长', icon: 'none', duration: 2500 });
      return;
    }

    // PR-C §C4 — 分支到 createConversion
    if (saleOrderType === '转换单') {
      return this._submitConversion();
    }
    // B5 — 分支到 createDeposit（寄存单，剩余次数初始化）
    if (saleOrderType === '寄存单') {
      return this._submitDeposit();
    }

    this.setData({ submitting: true });
    try {
      // Wave 3G — 充值卡预选（不扣卡，仅作为后端写订单的预选值）
      // 决策 #6：店长开单 = 预选；balance 不动，extraField useCard + prepaidCardAmount 透传给云函数
      const useCard = this.data.useCard && this.data.prepaidCardAmount > 0;
      const prepaidCardAmount = useCard ? this.data.prepaidCardAmount : 0;
      const res = await callStaffApi<OrderCreateResponse>('order.create', {
        clientUserId: customerInfo.clientUserId,
        clientPhone: customerInfo.phone,
        clientName: customerInfo.name || customerInfo.phone,
        // 销售单 / 内部单可选 微信 / 支付宝 / 线下；转换单不走此分支
        // Wave 3G：实付=0 时由后端强制覆盖为 '无'，前端仍传 paymentMethod 作为建议通道
        paymentMethod: this.data.paymentMethod,
        saleOrderType,
        items: cart.map(c => ({
          skuId: c.skuId,
          workfineItemId: c.workfineItemId,
          spuName: c.spuName,
          specName: c.specName,
          quantity: c.quantity,
          // 行实付金额（店长可向下调整；默认=当前订单类型下的应付金额）
          received: parseFloat(c.received) || 0,
        })),
        remark,
        // 内部单不允许优惠券（云函数已守卫）
        couponId: saleOrderType === '销售单'
          ? (this.data.selectedCoupon?.couponId || undefined)
          : undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
        // Wave 3G — 储值卡预选（决策 #6：店长不扣卡，云函数仅写订单字段）
        useCard,
        prepaidCardAmount,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      // Wave 3G 契约：店长 create 不扣卡，因此前端不做 customerCardBalance 乐观更新
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        selectedCoupon: null,
        couponDiscount: 0,
        paymentMethod: '微信',
      });
      // 全额储值卡抵扣（payable=0）→ 云端已结清为 '已支付'，无现金可收，不进 QR/收款页
      if (res.status === '已支付') {
        wx.showToast({ title: '储值卡已全额抵扣，订单已结清', icon: 'none', duration: 2500 });
      } else {
        wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '开单失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * PR-C §C3/§C4 — 转换单提交：order.createConversion
   * - convertOutSaleItemIds 来自 ConversionPanel change 事件
   * - convertInItems 来自当前购物车（只取 skuId + quantity）
   * - paymentMethod：差额>0 必填；差额<=0 后端忽略但仍需字段，默认 '微信'
   * - Toast 按差额方向差异化
   */
  async _submitConversion() {
    const {
      customerInfo, cart, remark, submitting,
      conversionSelectedSaleItemIds, conversionPriceDiff, conversionPaymentMethod,
      conversionPrepaidCardAmount, conversionRemaining,
    } = this.data;
    if (!customerInfo) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    if (conversionSelectedSaleItemIds.length === 0) {
      wx.showToast({ title: '请选择折抵卡', icon: 'none' });
      return;
    }
    // 抵扣后仍需付现金（remaining > 0）才必选支付方式；全额储值卡抵扣无需选
    if (conversionRemaining > 0 && !conversionPaymentMethod) {
      wx.showToast({ title: '请选择支付方式', icon: 'none' });
      return;
    }
    if (submitting) return;
    this.setData({ submitting: true });
    try {
      // remaining > 0 用所选方式；否则（全额抵扣 / 差额<=0）后端忽略但需合法值，默认 '微信'
      const paymentMethod: '微信' | '线下' =
        conversionRemaining > 0 ? (conversionPaymentMethod as '微信' | '线下') : '微信';
      const res = await callStaffApi<{
        saleOrderId: string; priceDiff: number; prepaidCardCredit: number; prepaidCardAmount: number; status: string;
      }>('order.createConversion', {
        clientUserId: customerInfo.clientUserId,
        convertOutSaleItemIds: conversionSelectedSaleItemIds,
        convertInItems: cart.map(c => ({ skuId: c.skuId, quantity: c.quantity })),
        paymentMethod,
        prepaidCardAmount: conversionPrepaidCardAmount > 0 ? conversionPrepaidCardAmount : undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
        remark: remark || undefined,
      });
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        conversionSelectedSaleItemIds: [],
        conversionDeductibleSum: 0,
        conversionPriceDiff: 0,
        conversionPaymentMethod: null,
        conversionPrepaidCardAmount: 0,
        conversionRemaining: 0,
      });
      // Toast 差异化
      const diff = Number(res.priceDiff) || 0;
      const card = Number(res.prepaidCardAmount) || 0;
      const remaining = Math.max(0, Math.round((diff - card) * 100) / 100);
      let title = '转换成功';
      if (diff > 0 && remaining > 0) {
        title = paymentMethod === '微信'
          ? `请微信支付差额 ¥${remaining.toFixed(2)}`
          : `请确认补差额收款 ¥${remaining.toFixed(2)}`;
      } else if (diff > 0 && remaining <= 0) {
        title = `储值卡全额抵扣 ¥${card.toFixed(2)}，已结清`;
      } else if (diff < 0) {
        const credit = Math.abs(diff).toFixed(2);
        title = `差额 ¥${credit} 已充入储值卡`;
      }
      wx.showToast({ title, icon: 'none', duration: 2500 });
      // 抵扣后仍需付现金 → 跳订单码继续收款；否则（全额抵扣 / 差额<=0）直接完成
      if (remaining > 0) {
        wx.navigateTo({ url: `/packageOrder/order-qrcode/order-qrcode?saleOrderId=${res.saleOrderId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '转换失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * B5 — 寄存单提交：order.createDeposit
   * - 不收钱、不抵扣、status='已支付'
   * - 仅传 clientUserId + items[{skuId,quantity}] + remark
   * - 提交成功后直接返回上一页（无付款码流程）
   */
  async _submitDeposit() {
    const { customerInfo, cart, remark, submitting } = this.data;
    if (!customerInfo) {
      wx.showToast({ title: '请先用手机号确认顾客身份', icon: 'none' });
      return;
    }
    if (!customerInfo.clientUserId) {
      wx.showToast({ title: '顾客尚未注册小程序', icon: 'none' });
      return;
    }
    if (cart.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }
    if (submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await callStaffApi<{ saleOrderId: string; itemCount: number; status: string }>(
        'order.createDeposit',
        {
          clientUserId: customerInfo.clientUserId,
          items: cart.map(c => ({ skuId: c.skuId, quantity: c.quantity })),
          remark: remark || undefined,
        }
      );
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
      });
      wx.showToast({
        title: `寄存单已创建（${res.itemCount} 项）`,
        icon: 'success',
        duration: 2000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '寄存失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  saveRecentCustomer(customer: CustomerInfo) {
    try {
      let recent: CustomerInfo[] = wx.getStorageSync('recentCustomers') || [];
      recent = recent.filter(c => c.phone !== customer.phone);
      recent.unshift(customer);
      recent = recent.slice(0, 5);
      wx.setStorageSync('recentCustomers', recent);
      this.setData({ recentCustomers: recent });
    } catch (_) {}
  },
});
