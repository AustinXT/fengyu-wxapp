// pages/order-create/order-create.ts — 开单
import { callStaffApi } from '../../utils/cloud';
import { isManager, getCurrentStoreId } from '../../utils/role';
import { calcHalfPriceTotal, allocateCouponPerLine, calcTierLineAmount } from '../../utils/cart-calc';
import { evaluateCouponAfterCartChange } from '../../utils/coupon-evaluator';
import { computePrepaidDeduction } from '../../utils/prepaid-card-calc';
import { buildCouponDisplay, formatDate } from '../../utils/formatters';
import { on, EVENT_STORE_CHANGED } from '../../utils/event-bus';

const app = getApp<IAppOption>();

/**
 * 顶部商品类型 4 选 1（PR-B 改版）
 * - 组合套餐：走 BundlePicker 子视图（products.is_bundle=true）
 * - 普通商品：!isExperience（SKU 级 capability 过滤；进过套餐的 SKU 仍可单卖，2026-05-26 取消套餐排除）
 * - 体验卡：isExperience=true（capability，与 product_kind 字面量解耦）
 * - 充值卡：跳转独立 card-recharge 页（2026-05-20 充值卡剥离 SKU 化）
 */
const PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡'] as const;
type ProductKindChoice = typeof PRODUCT_KIND_CHOICES[number];

/**
 * 订单类型（PR-C §C1）—— 与 DB 原生枚举 sale_order_type 对齐
 * - 销售单：默认，正常计价（支持订单级 couponId 按行均摊）
 * - 内部单：managerOnly，所有 SKU 半价（后端计算），禁优惠券
 * - 转换单：managerOnly，调 order.createConversion（仅正补差额可用订单级优惠券）
 * - 寄存单：剩余次数初始化
 */
type SaleOrderType = '销售单' | '内部单' | '转换单' | '寄存单';

interface CartItem {
  spuId: string;
  skuId: string;
  spuName: string;
  specName: string;
  categoryId?: string;
  categoryName?: string;
  /** 单价（会员价优先 specialPrice，否则 price；由 skuToDisplay / SkuItem 决定） */
  price: number;
  /** 展示用：原始挂牌价（划线原价）。缺省时降级为单价显示 */
  listPrice?: number;
  /** 展示用：特价，null 表示无特价 */
  specialPrice?: number | null;
  /** 每单限购次数；null/undefined=不限购 */
  purchaseLimit?: number | null;
  quantity: number;
  sessionCount: number;
  unit: string;
  productType: string;
  workfineItemId: string;
  /** 预计算：price × quantity（"价格"列） */
  priceLine: string;
  /** 预计算：本行摊到的优惠券折扣（订单级券按行应付比例分摊；元，2 位精度） */
  couponShare: string;
  /** 券前行应付金额（优惠券可用性/重验的权威前端基数，含阶梯价和店长特价） */
  couponBaseAmount?: string;
  /** 预计算：行应付金额 = priceLine - couponShare（销售单 / 寄存单口径） */
  saleAmount: string;
  /** 预计算：内部单半价后行应付（price × 0.5 × quantity，再扣摊到的券） */
  halfPriceSaleAmount: string;
  /** 行实付金额（店长可向下编辑；0 ≤ received ≤ 当前订单类型下的应付） */
  received: string;
  /** 店长特别优惠 capability（product_skus.is_manager_special）：true 时销售单/转换单可改应付 */
  isManagerSpecial?: boolean;
  /** 体验卡 capability（product_skus.is_experience）：体验卡不参与同名疗程阶梯价 */
  isExperience?: boolean;
  /** 店长手填的应付金额（仅店长特价行；undefined=未改，用 price×quantity） */
  saleAmountOverride?: string;
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
  unit: string;
  purchaseLimit?: number | null;
  productType: string;
  serviceFee: number;
  isShengmei: boolean | null;
  /** 体验卡 capability（product_skus.is_experience） */
  isExperience?: boolean;
  /** 店长特别优惠 capability（product_skus.is_manager_special） */
  isManagerSpecial?: boolean;
}

/** 套餐分组（PR-A 云函数 product.shopInit 返回 mallBundleGroups[]） */
interface BundleGroupSku {
  skuId: string;
  specName: string;
  sessionCount: number | null;
  unit: string;
  purchaseLimit?: number | null;
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
  categoryId: string;
  categoryName: string;
  /** 生效价（specialPrice 优先，否则 price）；计费用 */
  price: number;
  /** 原始挂牌价 sku.price（展示划线用，price 折叠后保留此字段） */
  listPrice: number;
  specialPrice: number | null;
  productKind: string;
  productType: string;
  sessionCount: number | null;
  unit: string;
  purchaseLimit?: number | null;
  /** 店长特别优惠 capability（仅普通商品开单时放开应付编辑） */
  isManagerSpecial?: boolean;
  /** 体验卡 capability */
  isExperience?: boolean;
}

interface CustomerInfo {
  id: string | null;
  clientUserId: string;
  customerNo?: string | null;
  name: string;
  phone: string;
  phoneMasked?: string;
  /** 顾客绑定门店 ID（后端 customer.search 返回，用于实时判断是否本店） */
  boundStoreId?: string | null;
  /** 顾客绑定门店名（搜索结果展示「非本店」标签用） */
  storeName?: string;
  /** 临时跨门店标记（需求21，后端 customer.search 返回）；true 时允许被外店开单/充值 */
  isCrossStoreTemp?: boolean;
  /** 是否非本店顾客（前端按 boundStoreId vs 当前门店实时计算；缺 boundStoreId 时为 false，放行后端兜底） */
  crossStore?: boolean;
  /** 顾客分类（后端 customer.search 返回）；'会员客' 即会员 */
  customerType?: string | null;
  /** 会员等级（后端 customer.search 返回）；非空即会员 */
  memberLevel?: string | null;
}

/** 标注一条顾客是否非本店（boundStoreId 缺失时返回 false，由后端兜底校验） */
function markCrossStore(c: CustomerInfo): CustomerInfo {
  return { ...c, crossStore: !!c.boundStoreId && c.boundStoreId !== getCurrentStoreId() };
}

interface CouponInfo {
  couponId: string;
  name: string;
  discount: number;
  description?: string;
  /** 券有效期（后端返回原始 timestamp，前端格式化为 YYYY-MM-DD 供「有效期至」展示） */
  expireAt?: string;
  /** 券面值（真实属性，不受订单金额限制） */
  faceValue?: number;
  /** 券类型（现金券/折扣券/品项券） */
  couponType?: string;
  /** 券配置值：折扣券为折率，金额型券为面值 */
  discountValue?: number | string;
  /** 预计算券面值与本单可用金额文案，供 WXML 直接绑定 */
  discountLabel?: string;
  availableAmountLabel?: string;
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
  /** 订单初始状态；应付实金=0（券/卡全额抵扣）时云端直接结清为 '已支付'（无需进 QR/收款页） */
  status?: string;
  /** 储值卡抵扣金额；用于区分"卡全额抵扣"与"券全额抵扣"的结清 Toast 文案 */
  prepaidCardAmount?: number;
  pointsDiscount?: number;
}

interface CouponAvailableResponse {
  coupons: CouponInfo[];
}

/** 顾客储值卡余额（Wave 2B 新增 customer.customerBalance；跨店统一余额） */
interface CustomerBalanceResponse {
  balance: number;
  cardId: string | null;
  pointsBalance?: number;
  pointsToYuanRate?: number;
  pointsDeductionMaxRate?: number;
}

/** 顾客是否会员：会员客 或 有钻石等级（与后端 member-pricing 同口径） */
function deriveIsMember(c: { customerType?: string | null; memberLevel?: string | null } | null): boolean {
  return !!c && (c.customerType === '会员客' || (c.memberLevel != null && c.memberLevel !== ''));
}

/**
 * 将后端 SKU 项映射为兼容 WXML 的展示格式。
 * 会员价「展示」与「计价」分离（issue #26 子项1）：
 *   - specialPrice（展示）：只要存在会员价且 < 标价即非空，驱动 wxml 三处「划线标价 + 会员价」双行——
 *     不论当前顾客是否会员，列表/购物车弹层始终双行展示。
 *   - price（计价）：仅会员享会员价（useSpecial），非会员按标价；最终以云函数 order.create 权威定价为准。
 *     即非会员列表看到会员价、但加购/确认页/二维码按标价收（展示与计价对非会员不一致，系产品决策）。
 * 体验卡同口径（#6=B，不再豁免）。
 */
function skuToDisplay(sku: SkuItem, isMember: boolean): DisplayItem {
  const list = Number(sku.price) || 0;
  const special = sku.specialPrice != null ? Number(sku.specialPrice) : null;
  const hasSpecial = special != null && special < list;
  const useSpecial = isMember && hasSpecial; // 计价：仅会员享会员价
  return {
    spuId: sku.skuId,
    spuName: sku.specName,
    categoryId: sku.categoryId,
    categoryName: sku.categoryName,
    price: useSpecial ? special : list,
    listPrice: list,
    specialPrice: hasSpecial ? special : null, // 展示：有会员价即双行（与会员身份解耦）
    productKind: sku.productKind,
    productType: sku.productType,
    sessionCount: sku.sessionCount,
    unit: sku.unit || (sku.productType === '家居产品' ? '盒' : '次'),
    purchaseLimit: sku.purchaseLimit ?? null,
    isManagerSpecial: !!sku.isManagerSpecial,
    isExperience: !!sku.isExperience,
  }
}

function purchaseLimitMessage(item: { specName?: string; spuName?: string; purchaseLimit?: number | null }): string {
  return `${item.specName || item.spuName || '该商品'}每单最多可购买 ${item.purchaseLimit} 件`;
}

function findCartPurchaseLimitViolation(cart: CartItem[]): CartItem | null {
  const totals = new Map<string, { item: CartItem; quantity: number }>();
  for (const item of cart) {
    const current = totals.get(item.skuId);
    totals.set(item.skuId, {
      item,
      quantity: (current?.quantity || 0) + item.quantity,
    });
  }
  for (const row of totals.values()) {
    if (row.item.purchaseLimit != null && row.quantity > row.item.purchaseLimit) return row.item;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function moneyToCents(value: number | string | null | undefined): number {
  return Math.max(0, Math.round((Number(value) || 0) * 100));
}

function pointsToDiscountCents(points: number, rate: number): number {
  return Math.floor(points * rate * 100 + 1e-6);
}

function computePointsDeduction(input: {
  enabled: boolean;
  pointsBalance: number;
  rawTotal: number;
  currentAmount: number;
  pointsToYuanRate: number;
  pointsDeductionMaxRate: number;
}) {
  const balance = Math.max(0, Math.floor(input.pointsBalance));
  const rate = Number(input.pointsToYuanRate) || 0.01;
  const maxRate = Number(input.pointsDeductionMaxRate) || 0;
  const capCents = Math.min(
    moneyToCents(input.currentAmount),
    Math.floor(Math.max(0, Number(input.rawTotal) || 0) * maxRate * 100 + 1e-6),
  );
  const maxPointsUsable = rate > 0
    ? Math.max(0, Math.min(balance, Math.floor(capCents / (rate * 100))))
    : 0;
  if (!input.enabled || balance <= 0 || capCents <= 0 || maxPointsUsable <= 0) {
    return { pointsUsed: 0, pointsDiscount: 0, maxPointsUsable };
  }
  const discountCents = Math.min(capCents, pointsToDiscountCents(maxPointsUsable, rate));
  return discountCents > 0
    ? { pointsUsed: maxPointsUsable, pointsDiscount: roundMoney(discountCents / 100), maxPointsUsable }
    : { pointsUsed: 0, pointsDiscount: 0, maxPointsUsable };
}

function resolveSkuUnitPrice(sku: { price: number; specialPrice?: number | null }, isMember: boolean): number {
  const list = Number(sku.price) || 0;
  const special = sku.specialPrice != null ? Number(sku.specialPrice) : null;
  return isMember && special != null && special < list ? special : list;
}

function buildTreatmentTierLineMap(cart: CartItem[], skus: SkuItem[], isMember: boolean): Map<string, number> {
  const result = new Map<string, number>();
  const groups = new Map<string, CartItem[]>();

  for (const item of cart) {
    if (
      item.productType !== '疗程卡' ||
      item.refBundleId ||
      item.isExperience ||
      item.isManagerSpecial ||
      item.saleAmountOverride != null ||
      !item.categoryId ||
      !item.specName ||
      !item.sessionCount ||
      item.sessionCount <= 0
    ) {
      continue;
    }
    const key = `${item.categoryId}::${item.specName}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  for (const [key, groupedItems] of groups.entries()) {
    const [categoryId, specName] = key.split('::');
    const totalSessions = groupedItems.reduce(
      (sum, item) => sum + (Number(item.sessionCount) || 0) * (Number(item.quantity) || 1),
      0,
    );
    if (totalSessions <= 1) continue;

    const candidates = skus
      .filter(s =>
        s.categoryId === categoryId &&
        s.specName === specName &&
        s.productType === '疗程卡' &&
        !s.isExperience &&
        !s.isManagerSpecial &&
        s.sessionCount != null &&
        Number(s.sessionCount) > 1 &&
        Number(s.sessionCount) <= totalSessions
      )
      .sort((a, b) => {
        const sessionDelta = Number(b.sessionCount) - Number(a.sessionCount);
        if (sessionDelta !== 0) return sessionDelta;
        const aUnit = resolveSkuUnitPrice(a, isMember) / (Number(a.sessionCount) || 1);
        const bUnit = resolveSkuUnitPrice(b, isMember) / (Number(b.sessionCount) || 1);
        return aUnit - bUnit;
      });
    const tier = candidates[0];
    if (!tier || !tier.sessionCount || tier.sessionCount <= 1) continue;

    const tierAmount = resolveSkuUnitPrice(tier, isMember);
    const tierSessions = Number(tier.sessionCount);
    for (const item of groupedItems) {
      const lineSessions = (Number(item.sessionCount) || 0) * (Number(item.quantity) || 1);
      result.set(item.skuId, calcTierLineAmount(tierAmount, tierSessions, lineSessions));
    }
  }

  return result;
}

/**
 * 商品类型过滤器（按 SKU 级 capability 判定）
 * - 普通商品：非体验卡（进过套餐的 SKU 仍允许单卖，2026-05-26 取消套餐排除）
 * - 体验卡：isExperience=true
 * - 充值卡：本视图不渲染，由 onBigCategoryChange 截走跳 card-recharge 页（2026-05-20）
 * - 组合套餐：不走 SKU 列表，由 BundlePicker 接管
 */
function filterSkusByKindChoice(skus: SkuItem[], choice: ProductKindChoice): SkuItem[] {
  if (choice === '组合套餐') return [];
  if (choice === '普通商品') {
    return skus.filter(s => !s.isExperience);
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
    buyerIsMember: false,   // 选中顾客是否会员（会员价分流展示用；非会员只看标价、会员看会员价划线）
    customerResults: [] as CustomerInfo[],
    recentCustomers: [] as CustomerInfo[],
    // Step 2 顶部：订单类型 4 选 1（PR-C §C1）
    saleOrderType: '销售单' as SaleOrderType,
    /** 寄存单各行历史实收（skuId → 金额字符串）；仅记账，默认 0，不影响次数/统计 */
    depositReceivedMap: {} as Record<string, string>,
    /** 内部单半价合计（行原价 × 0.5 之和） */
    halfPriceTotal: '0.00',
    /** 应付合计：销售单/转换单/寄存单 = 券前金额 - couponDiscount；内部单 = halfPriceTotal */
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
     * - useCard：店长预选开关，默认关闭
     * - prepaidCardAmountInput：店长手填金额，默认 0.00；实际抵扣额按上限钳制
     * - prepaidCardAmount / paidAmount：computePrepaidDeduction 计算结果（不影响后端 balance，仅作 payload 与 UI 展示）
     * - showPayMethodGroup：paid > 0 时展示支付方式按钮组；paid = 0 时隐藏
     * - prepaidCardLoaded：避免重复请求；customerBalanceLoading：拉取中态
     */
    customerCardBalance: 0 as number,
    useCard: false as boolean,
    prepaidCardAmountInput: '0.00' as string,
    prepaidCardMax: '0.00' as string,
    customerPointsBalance: 0 as number,
    usePoints: false as boolean,
    pointsUsed: 0 as number,
    pointsDiscount: 0 as number,
    maxPointsUsable: 0 as number,
    pointsToYuanRate: 0.01 as number,
    pointsDeductionMaxRate: 0.03 as number,
    prepaidCardAmount: 0 as number,
    paidAmount: '0.00' as string,
    showPayMethodGroup: true as boolean,
    prepaidCardLoaded: false as boolean,
    customerBalanceLoading: false as boolean,
    /** 活动单标记（纯标识，店长开单时勾选；透传 order.create 写 sale_orders.is_activity） */
    isActivity: false as boolean,
    // 转换单（ConversionPanel 反馈 → 主页记录用于提交）
    conversionSelectedSaleItemIds: [] as string[],
    conversionDeductibleSum: 0,
    conversionPriceDiff: 0,
    conversionPaymentMethod: null as null | '微信' | '支付宝' | '线下',
    /** 转换单补差额充值卡抵扣额（ConversionPanel 反馈） */
    conversionPrepaidCardAmount: 0,
    /** 转换单抵扣后仍需付现金（priceDiff - prepaidCardAmount） */
    conversionRemaining: 0,
    /** 转换单活动勾选（ConversionPanel 自管，change 事件上报；与销售/内部单 isActivity 独立） */
    conversionIsActivity: false as boolean,
    /** 转换单券前转入合计，用于按折抵总额判断是否仍有可抵扣的正补差额 */
    conversionCouponBaseTotal: 0,
    /** 原始补差额 > 0 时才允许选择优惠券；券后差额为 0 仍保留已选券 */
    conversionCouponEnabled: false,
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
  /** 商品目录世代；切换门店后使仍在飞行中的旧请求失效。 */
  _catalogGeneration: 0,

  onLoad() {
    // 订阅门店切换事件：切换门店时强制刷新商品目录
    this._unsubscribeStoreChange = on(EVENT_STORE_CHANGED, (storeId: string) => {
      console.log('[order-create] 门店已切换:', storeId, '→ 清空商品缓存 + 购物车');
      this.onStoreChanged();
    });
  },

  onUnload() {
    if (this._unsubscribeStoreChange) this._unsubscribeStoreChange();
    if (this._kwTimer) clearTimeout(this._kwTimer);
  },

  _unsubscribeStoreChange: null as (() => void) | null,

  onShow() {
    if (!app.globalData.staffWfId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isManager: isManager() });
    // Tab 页常驻不销毁：重新进入开单页时完全重置上一单残留的表单态 + 购物车（用户决策）。
    this.resetOrderState();
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
  },

  // ===== 商品目录（三级导航 + 缓存） =====

  async loadShopInit() {
    const catalogGeneration = this._catalogGeneration;
    this.setData({ catalogLoading: true });
    try {
      const data = await callStaffApi<ShopInitResponse>('product.shopInit');
      if (catalogGeneration !== this._catalogGeneration) return;

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

      // 体验卡 SKU 不并入 _allSkus（保持其"非卡类首分类预取"语义）；refreshForCustomer 重算时
      // 会同时索引 _allSkus + _experienceSkus，故此处无需再建持久化 skuMap。
      this.setData({ bundleSpus, catalogLoading: false });
      this.applyKindChoice(this.data.productKindChoice);
    } catch (err: unknown) {
      if (catalogGeneration !== this._catalogGeneration) return;

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
        list = filterSkusByKindChoice(skusInCat, choice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
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
      const list = this._experienceSkus.map((s) => skuToDisplay(s, this.data.buyerIsMember));   // 体验卡按会员价分流（#6=B：会员=会员价，非会员=标价）
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
      list = filterSkusByKindChoice(skusInCat, choice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
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
      // 临时跨门店顾客（需求21）允许被外店充值/开单；仅非本店且无临时标记才拦截
      if (customer?.crossStore && !customer?.isCrossStoreTemp) {
        wx.showModal({
          title: '无法充值',
          content: `该顾客属于「${customer.storeName || '其他'}」门店，非本店顾客无法充值。`,
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
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
      const list = filterSkusByKindChoice(localSkus, productKindChoice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
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
      // 追加懒加载分类的 SKU 到 _allSkus。shopInit 只返首分类，其余分类经此远程补全；
      // refreshForCustomer 选顾客后直接从 _allSkus + _experienceSkus 现建索引重算会员价，
      // 故此处只需保证 _allSkus 完整、无需手动回填任何 SKU 索引（避免漏同步重现「会员按标价收」bug）。
      this._allSkus = this._allSkus.concat(skus || []);
      const list = filterSkusByKindChoice(skus || [], productKindChoice).map((s) => skuToDisplay(s, this.data.buyerIsMember));
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
      .map((s) => skuToDisplay(s, this.data.buyerIsMember));
    this.setData({ searching: true, spuList: matched });
  },

  // ===== BundlePicker 选完后覆盖购物车并直接进入下单流程 =====
  // 组合套餐独占：不进共享购物车（避免与普通商品混单），点 "去下单" 一步到结算

  onBundlePickerSelect(e: WechatMiniprogram.CustomEvent) {
    const { cartItems } = (e.detail || {}) as { cartItems?: CartItem[]; bundleName?: string };
    if (!cartItems || cartItems.length === 0) return;
    const violation = findCartPurchaseLimitViolation(cartItems);
    if (violation) {
      wx.showToast({ title: purchaseLimitMessage(violation), icon: 'none' });
      return;
    }
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
      if (cart[existing].purchaseLimit != null && cart[existing].quantity + 1 > cart[existing].purchaseLimit) {
        wx.showToast({ title: purchaseLimitMessage(cart[existing]), icon: 'none' });
        return;
      }
      cart[existing].quantity += 1;
    } else {
      cart.push({
        spuId: item.spuId,
        skuId: item.spuId,
        spuName: item.spuName,
        specName: item.spuName,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        price: item.price,
        listPrice: item.listPrice,
        specialPrice: item.specialPrice,
        purchaseLimit: item.purchaseLimit ?? null,
        quantity: 1,
        sessionCount: item.sessionCount || 0,
        unit: item.unit || (item.productType === '家居产品' ? '盒' : '次'),
        productType: item.productType,
        workfineItemId: '',
        isManagerSpecial: !!item.isManagerSpecial,
        isExperience: !!item.isExperience,
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
      // 组合套餐行数量在 bundle-picker 内锁定（refBundleId 标记）；真实 productType 是
      // 疗程卡/家居，故不能只判 productType==='组合套餐'，须一并判 refBundleId。
      if (cart[idx].refBundleId || cart[idx].productType === '组合套餐') {
        wx.showToast({ title: '组合套餐项目不可修改数量', icon: 'none' });
        return;
      }
      if (cart[idx].purchaseLimit != null && qty > cart[idx].purchaseLimit) {
        wx.showToast({ title: purchaseLimitMessage(cart[idx]), icon: 'none' });
        cart[idx].quantity = cart[idx].purchaseLimit;
      } else {
        cart[idx].quantity = qty;
      }
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
   * 行级「应付金额」编辑（仅店长特别优惠 SKU + 销售单/转换单 + 普通商品）。
   * - 区间 0 ≤ 应付 ≤ price×quantity（向下调，不许涨价）
   * - 空字符串等同于默认（=标准价线 price×quantity）
   * - 改应付后实付默认回归新应付（不保留旧实付，避免实付>应付）
   */
  applySaleAmountOverride(skuId: string, raw: string) {
    const cart = [...this.data.cart];
    const idx = cart.findIndex(c => c.skuId === skuId);
    if (idx < 0) return;
    const row = cart[idx];
    // 仅店长特价行 + 销售单/转换单 + 普通商品放行（组合套餐不适用）
    const supportsManagerSpecial =
      this.data.saleOrderType === '销售单' || this.data.saleOrderType === '转换单';
    if (!supportsManagerSpecial || !row.isManagerSpecial
        || row.refBundleId || row.productType === '组合套餐') {
      return;
    }
    const stdLine = row.price * row.quantity;
    const parsed = parseFloat(raw);
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      row.saleAmountOverride = undefined;
    } else {
      const clamped = Math.min(parsed, stdLine);
      row.saleAmountOverride = (Math.round(clamped * 100) / 100).toFixed(2);
    }
    // 改应付后实付回归默认（=新应付），避免残留旧实付超过新应付
    this.updateCart(cart);
  },

  onSaleAmountChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = (e.detail?.value ?? '') as string;
    this.applySaleAmountOverride(skuId, raw);
  },

  onConversionSaleAmountChange(e: WechatMiniprogram.CustomEvent) {
    const detail = (e.detail || {}) as { skuId?: string; value?: string };
    if (!detail.skuId) return;
    this.applySaleAmountOverride(detail.skuId, String(detail.value ?? ''));
  },

  /** 寄存单历史实收输入（独立于 cart.received，避免和销售单实付逻辑纠缠） */
  onDepositReceivedChange(e: WechatMiniprogram.CustomEvent) {
    const skuId = e.currentTarget.dataset.skuId as string;
    const raw = String(e.detail.value ?? '');
    const parsed = parseFloat(raw);
    const next = { ...this.data.depositReceivedMap };
    if (!raw || Number.isNaN(parsed) || parsed < 0) {
      delete next[skuId];
    } else {
      next[skuId] = (Math.round(parsed * 100) / 100).toFixed(2);
    }
    this.setData({ depositReceivedMap: next });
  },

  /**
   * 重算 cart 行的预算字段（价格 / 摊到的券 / 应付 / 半价应付 / 实付默认）
   * - opts.preserveReceived = true：保留用户手动改过的 received（仅在 saleAmount/halfPriceSaleAmount 因外部 input 变化时归一化裁剪到上限）
   * - 否则 received 全部回归默认值（= 当前订单类型下的应付）
   */
  updateCart(cart: CartItem[], opts?: { preserveReceived?: boolean }) {
    const saleOrderType = this.data.saleOrderType;
    const isInternal = saleOrderType === '内部单';
    const isSales = saleOrderType === '销售单';
    const isConversion = saleOrderType === '转换单';
    const supportsManagerSpecial = isSales || isConversion;
    // 销售单 + 转换单均需计算疗程卡梯度累加价（寄存单/内部单不计算）
    const tierLineMap = (isSales || isConversion)
      ? buildTreatmentTierLineMap(cart, this._allSkus, this.data.buyerIsMember)
      : new Map<string, number>();
    // 店长特别优惠（销售单/转换单 + 普通商品，组合套餐不适用）：pre-coupon 应付基线 = 手填覆盖，
    // 钳制到 [0, price×qty]（向下调，不许涨价）；未改时回退标准价线 price×qty。
    const effBase = cart.map(c => {
      const stdLine = c.price * c.quantity;
      const tierLine = tierLineMap.get(c.skuId);
      const editable = supportsManagerSpecial && !!c.isManagerSpecial && !c.refBundleId && c.productType !== '组合套餐';
      if (editable && c.saleAmountOverride != null && c.saleAmountOverride !== '') {
        const v = parseFloat(c.saleAmountOverride);
        if (!Number.isNaN(v)) return Math.max(0, Math.min(v, stdLine));
      }
      if (tierLine != null) return tierLine;
      return stdLine;
    });
    // 1) priceLine（"价格"列）= 阶梯价/标准价 pre-coupon 基线；店长手动改价不影响价格列展示。
    for (let i = 0; i < cart.length; i++) {
      const c = cart[i];
      const tierLine = tierLineMap.get(c.skuId);
      c.priceLine = (tierLine != null ? tierLine : c.price * c.quantity).toFixed(2);
    }
    // 2) 按订单类型确定"摊券基线"：销售单/转换单/寄存单 = 店长特价基线 effBase；内部单 = 标价 listPrice × 0.5 × qty（不取会员价，与后端 order.js / admin orders.ts 一致）
    const baseLines = cart.map((c, i) => {
      if (isInternal) {
        const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100;
        return halfUnit * c.quantity;
      }
      return effBase[i];
    });
    const couponBaseTotal = Math.round(baseLines.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
    // 转换单的券只可抵扣正补差额。selectedCoupon.discount 始终保留券按转入项目算出的原始金额，
    // couponDiscount 则是本次实际抵扣额；这样折抵卡增减后可重新放大/缩小，不会丢失券面计算额。
    const selectedCouponDiscount = Number(this.data.selectedCoupon?.discount ?? 0);
    const rawCouponDiscount = Number.isFinite(selectedCouponDiscount)
      ? Math.max(0, Math.round(selectedCouponDiscount * 100) / 100)
      : 0;
    const conversionCouponCap = isConversion
      ? Math.max(0, Math.round((couponBaseTotal - (Number(this.data.conversionDeductibleSum) || 0)) * 100) / 100)
      : couponBaseTotal;
    const effectiveCouponDiscount = !isInternal && this.data.selectedCoupon
      ? Math.round(Math.min(rawCouponDiscount, conversionCouponCap) * 100) / 100
      : 0;
    const shouldClearConversionCoupon = isConversion
      && !!this.data.selectedCoupon
      && conversionCouponCap <= 0.005;

    // 3) 按行应付比例摊订单级优惠券折扣。
    const shares = allocateCouponPerLine(baseLines, effectiveCouponDiscount);
    for (let i = 0; i < cart.length; i++) {
      const c = cart[i];
      const share = shares[i] || 0;
      c.couponBaseAmount = (baseLines[i] || 0).toFixed(2);
      c.couponShare = share.toFixed(2);
      // 销售单/寄存单的应付金额（不走半价；店长特价行用 effBase 基线）
      const saleAmountNum = Math.max(0, Math.round((effBase[i] - share) * 100) / 100);
      c.saleAmount = saleAmountNum.toFixed(2);
      // 内部单专用的应付金额（标价 listPrice ×0.5，与后端一致；不取会员价；先半价、再扣摊到的券）
      const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100;
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
    const count = cart.reduce((sum, c) => sum + c.quantity, 0);
    const total = cart.reduce((sum, c) => sum + (parseFloat(c.priceLine) || 0), 0).toFixed(2);
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
      couponDiscount: effectiveCouponDiscount,
      couponTotal: effectiveCouponDiscount > 0 ? payableSum.toFixed(2) : '',
      conversionCouponBaseTotal: isConversion ? couponBaseTotal : 0,
      conversionCouponEnabled: isConversion && conversionCouponCap > 0.005,
    };
    if (shouldClearConversionCoupon) {
      update.selectedCoupon = null;
      update.couponDiscount = 0;
      update.couponTotal = '';
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
      conversionIsActivity: false,
      conversionCouponBaseTotal: 0,
      conversionCouponEnabled: false,
      // 重置储值卡预选 state（避免上次 customer 残值；进入 Step 2 时再加载）
      customerCardBalance: 0,
      useCard: false,
      prepaidCardAmountInput: '0.00',
      prepaidCardMax: '0.00',
      customerPointsBalance: 0,
      usePoints: false,
      pointsUsed: 0,
      pointsDiscount: 0,
      maxPointsUsable: 0,
      prepaidCardAmount: 0,
      paidAmount: '0.00',
      showPayMethodGroup: true,
      prepaidCardLoaded: false,
      isActivity: false,
    });
  },

  onCloseCheckout() {
    // 放弃结算：完全重置结算面板表单态（保留购物车），避免下次重开结算串入上次的支付方式/活动/顾客/券等
    this.resetCheckoutForm();
  },

  /**
   * 重置结算面板的全部临时表单态（恢复 data 初始默认值），保留购物车与商品浏览态。
   * 供「放弃结算」（onCloseCheckout）与「完全重置」（resetOrderState）复用。
   */
  resetCheckoutForm() {
    this.setData({
      showCheckout: false,
      checkoutStep: 0,
      // Step 0 顾客
      customerKeyword: '',
      customerSearching: false,
      customerInfo: null,
      customerResults: [],
      buyerIsMember: false,   // 顾客清空→会员身份归位非会员，配合下方清 _spuCache 让商品列表按标价重算
      // Step 2 订单类型
      saleOrderType: '销售单',
      depositReceivedMap: {},
      // Step 2 备注 / 提交态
      remark: '',
      submitting: false,
      // 支付方式
      paymentMethod: '微信',
      // 储值卡预选
      customerCardBalance: 0,
      useCard: false,
      prepaidCardAmountInput: '0.00',
      prepaidCardMax: '0.00',
      customerPointsBalance: 0,
      usePoints: false,
      pointsUsed: 0,
      pointsDiscount: 0,
      maxPointsUsable: 0,
      pointsToYuanRate: 0.01,
      pointsDeductionMaxRate: 0.03,
      prepaidCardAmount: 0,
      paidAmount: '0.00',
      showPayMethodGroup: true,
      prepaidCardLoaded: false,
      customerBalanceLoading: false,
      // 活动单
      isActivity: false,
      // 转换单
      conversionSelectedSaleItemIds: [],
      conversionDeductibleSum: 0,
      conversionPriceDiff: 0,
      conversionPaymentMethod: null,
      conversionPrepaidCardAmount: 0,
      conversionRemaining: 0,
      conversionIsActivity: false,
      conversionCouponBaseTotal: 0,
      conversionCouponEnabled: false,
      // 优惠券
      selectedCoupon: null,
      couponDiscount: 0,
      couponTotal: '',
      showCouponPopup: false,
      availableCoupons: [],
      couponsLoading: false,
      // 指定美容师
      preferredStaffWfId: '',
      preferredStaffName: '',
      showStaffPicker: false,
      // 购物车弹层
      cartPopupVisible: false,
    });
    // 顾客已清空（buyerIsMember=false）→ 清商品展示缓存，避免上一顾客的会员价缓存串入；下次切分类/选顾客按非会员重算
    this._spuCache = {};
    // 券/特价等表单态已重置（couponDiscount=0、selectedCoupon=null）后，按保留的购物车重算应付/实付合计
    // 及各行 saleAmount/received；否则重开结算面板会沿用上次折后 payableTotal，且提交时行 received
    // 仍为折后值（券已清）→ 应付 / 实付 / 券记录不一致。setData 已同步更新 this.data，updateCart 即按无券重算。
    if (this.data.cart.length > 0) {
      this.updateCart(this.data.cart);
    }
  },

  /**
   * 完全重置开单页（含购物车 + 商品类型 Tab），使每次重新进入都是全新开单状态。
   * 由 Tab 页 onShow 每次重新进入时调用。
   * 保留：isManager / recentCustomers / staffListForPicker / staffPickerColumns
   *      及全部 `_` 前缀缓存（_allCategories/_allSkus/_experienceSkus/...）+ bundleSpus。
   */
  resetOrderState() {
    this.resetCheckoutForm();
    this.updateCart([]); // 清空购物车并归零所有金额合计
    if (this._kwTimer) {
      clearTimeout(this._kwTimer);
      this._kwTimer = null;
    }
    this.setData({
      productKindChoiceIndex: 1,
      productKindChoice: '普通商品',
      productKeyword: '',
      searching: false,
    });
    // 商品类型回到「普通商品」后刷新侧边栏 + spuList；
    // _allCategories 为空时 applyKindChoice 安全设空，随后 loadShopInit 回来会再次填充。
    this.applyKindChoice('普通商品');
  },

  /**
   * 门店切换后的清理与刷新（2026-08-06 新增）
   *
   * 切换门店时需要完全重置的数据：
   * 1. 商品目录缓存（不同门店的商品/分类/SKU 不同，必须重新加载）
   * 2. 购物车（防止跨门店混单，避免下单不属于当前市场的商品）
   * 3. 已选顾客（顾客可能不属于新门店，需重新搜索确认）
   * 4. 优惠券（券与顾客/门店绑定，切换后失效）
   * 5. 结算表单的所有临时状态
   *
   * 由 EVENT_STORE_CHANGED 事件触发，确保用户切换门店后不会残留旧门店数据。
   */
  onStoreChanged() {
    // 先失效旧门店的在途 shopInit；其成功/失败回调均不得再触碰当前目录状态。
    this._catalogGeneration += 1;

    // 1. 清空商品目录缓存（强制重新从云端拉取新门店的商品数据）
    this._allCategories = [];
    this._allGroupedCategories = [];
    this._allSkus = [];
    this._experienceSkus = [];
    this._spuCache = {};

    // 2. 完全重置开单状态（购物车 + 结算表单 + 商品类型 Tab）
    this.resetOrderState();

    // 3. 重新加载新门店的商品目录
    this.loadShopInit();

    // 4. Toast 提示用户（避免用户困惑为何购物车清空）
    wx.showToast({
      title: '已切换门店，购物车已清空',
      icon: 'none',
      duration: 2000,
    });
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
      // 跨门店模糊检索：可搜到任意门店顾客，但非本店者在下一步被拦截（crossStore 标记）
      const raw = await callStaffApi<CustomerInfo[]>('customer.search', { keyword, crossStore: true });
      const results = (raw || []).map(markCrossStore);
      if (results.length === 0) {
        this.setData({ customerInfo: null, customerResults: [] });
        wx.showToast({ title: '未找到该顾客（需已绑定门店）', icon: 'none' });
      } else if (results.length === 1) {
        // 单结果自动选中：与 onSelectCustomer / onSelectRecentCustomer 一致经 refreshForCustomer 同步会员身份 + 重算价
        this.setData({ customerInfo: results[0], customerResults: [] });
        this.refreshForCustomer(results[0]);
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
    const customer = markCrossStore(e.currentTarget.dataset.customer as CustomerInfo);
    this.setData({ customerInfo: customer, customerResults: [], customerKeyword: customer.phone || customer.name });
    this.refreshForCustomer(customer);
  },

  onSelectRecentCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = markCrossStore(e.currentTarget.dataset.customer as CustomerInfo);
    this.setData({ customerInfo: customer, customerKeyword: customer.phone, customerResults: [] });
    this.refreshForCustomer(customer);
  },

  /**
   * 顾客（及其会员身份）变更后的统一刷新（FINDING #9）：
   * 清商品展示缓存 + 按新会员身份重算「当前已渲染 spuList」与「购物车各行价格快照」，
   * 避免沿用上一顾客的会员价分流（旧实现仅清 _spuCache，须再次切分类才生效）。
   * onSelectCustomer / onSelectRecentCustomer / onSearchCustomer 单结果自动选中三处共用，防止分叉。
   * - 体验卡同口径按会员分流（#6=B，不再豁免；会员=会员价，非会员=标价）。
   * - 组合套餐行价格固定（refBundleId / 组合套餐），跳过不重算。
   * - SKU 索引未命中（套餐/直购单品）时保留原值。最终结算仍以云函数 order.create 权威定价为准。
   */
  refreshForCustomer(customer: CustomerInfo) {
    const buyerIsMember = deriveIsMember(customer);
    this._spuCache = {};   // 会员身份变化→清商品展示缓存，重选商品时按新身份重算会员价分流
    // 从 _allSkus（含懒加载分类）+ _experienceSkus 现建索引（单一来源；购物车/列表 SKU 必已加载其中）。
    // 不依赖持久化 skuMap，避免各 ingestion 点手动回填漏同步即重现「会员按标价收」的 bug。
    const skuMap: Record<string, SkuItem> = {};
    for (const s of this._allSkus) skuMap[s.skuId] = s;
    for (const s of this._experienceSkus) skuMap[s.skuId] = s;
    // 1) 重算当前已渲染的 spuList（按新会员身份分流）
    const spuList = this.data.spuList.map((row) => {
      const sku = skuMap[row.spuId];
      return sku ? skuToDisplay(sku, buyerIsMember) : row;
    });
    this.setData({ buyerIsMember, spuList });
    // 2) 刷新购物车各行价格快照（组合套餐行价格固定跳过），再 updateCart 按新行价重算 priceLine/saleAmount/received 及合计
    const cart = this.data.cart.map((c) => {
      if (c.refBundleId || c.productType === '组合套餐') return c;
      const sku = skuMap[c.skuId];
      if (!sku) return c;
      const disp = skuToDisplay(sku, buyerIsMember);
      return {
        ...c,
        categoryId: disp.categoryId,
        categoryName: disp.categoryName,
        price: disp.price,
        listPrice: disp.listPrice,
        specialPrice: disp.specialPrice,
        productType: disp.productType,
        isManagerSpecial: !!disp.isManagerSpecial,
        isExperience: !!disp.isExperience,
      };
    });
    this.updateCart(cart);
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
    // 临时跨门店顾客（需求21）允许被外店开单；仅非本店且无临时标记才拦截
    if (this.data.customerInfo.crossStore && !this.data.customerInfo.isCrossStoreTemp) {
      wx.showModal({
        title: '无法开单',
        content: `该顾客属于「${this.data.customerInfo.storeName || '其他'}」门店，非本店顾客无法开单。`,
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
   * - 余额加载后仍保持 useCard 关闭、手填金额为 0.00
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
      const pointsBalance = Math.max(0, Math.floor(Number(data?.pointsBalance) || 0));
      this.setData({
        customerCardBalance: balance,
        customerPointsBalance: pointsBalance,
        pointsToYuanRate: Number(data?.pointsToYuanRate) || 0.01,
        pointsDeductionMaxRate: Number(data?.pointsDeductionMaxRate) || 0.03,
        useCard: false,
        usePoints: false,
        prepaidCardAmountInput: '0.00',
        prepaidCardLoaded: true,
      });
    } catch (_) {
      // 静默兜底：拉取失败则视为 0 余额、useCard=off，不阻塞开单
      this.setData({
        customerCardBalance: 0,
        customerPointsBalance: 0,
        useCard: false,
        usePoints: false,
        prepaidCardAmountInput: '0.00',
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
    if (this.data.saleOrderType !== '销售单' && this.data.saleOrderType !== '内部单') {
      this.setData({
        prepaidCardAmount: 0,
        prepaidCardMax: '0.00',
        pointsUsed: 0,
        pointsDiscount: 0,
        maxPointsUsable: 0,
        paidAmount: '0.00',
        showPayMethodGroup: true,
      });
      return;
    }
    const payableTotal = parseFloat(this.data.payableTotal) || 0;
    const pointsResult = computePointsDeduction({
      enabled: this.data.saleOrderType === '销售单' && !!this.data.usePoints,
      pointsBalance: this.data.customerPointsBalance || 0,
      rawTotal: payableTotal + (Number(this.data.couponDiscount) || 0),
      currentAmount: payableTotal,
      pointsToYuanRate: this.data.pointsToYuanRate,
      pointsDeductionMaxRate: this.data.pointsDeductionMaxRate,
    });
    // 充值卡从「当下实付」（receivedTotal = Σ行实付 = 客户当下要付的钱，欠款时已逐行下调）里抵，
    // 而非应付合计。无欠款时 receivedTotal === payableTotal，口径等价；与后端 create maxPrepayable
    // = min(total, Σpending_received) 对齐，避免卡抵超过当下实付。
    const baseForPrepaid = Math.max(0, roundMoney((parseFloat(this.data.receivedTotal) || 0) - pointsResult.pointsDiscount));
    const result = computePrepaidDeduction({
      payableAmount: baseForPrepaid,
      customerCardBalance: this.data.customerCardBalance || 0,
      useCard: !!this.data.useCard,
      prepaidCardAmount: this.data.prepaidCardAmountInput,
    });
    this.setData({
      prepaidCardMax: result.maxPrepaidCardAmount.toFixed(2),
      pointsUsed: pointsResult.pointsUsed,
      pointsDiscount: pointsResult.pointsDiscount,
      maxPointsUsable: pointsResult.maxPointsUsable,
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
    this.setData({ useCard: next, prepaidCardAmountInput: '0.00' });
    this.recomputePrepaidAmounts();
  },

  /** 输入过程中保持受控状态；实际抵扣额会立即按当前上限重新计算。 */
  onPrepaidCardAmountInput(e: WechatMiniprogram.CustomEvent) {
    const raw = String((e.detail as unknown as { value?: string })?.value ?? e.detail ?? '');
    this.setData({ prepaidCardAmountInput: raw });
    this.recomputePrepaidAmounts();
  },

  /** 充值卡抵扣金额输入：按当前实付和余额上限钳制，并统一回填两位小数。 */
  onPrepaidCardAmountChange(e: WechatMiniprogram.CustomEvent) {
    const raw = String((e.detail as unknown as { value?: string })?.value ?? e.detail ?? '').trim();
    const requested = Number(raw);
    const baseForPrepaid = parseFloat(this.data.receivedTotal) || 0;
    const maxAmount = Math.min(
      Math.max(0, Number(this.data.customerCardBalance) || 0),
      Math.max(0, baseForPrepaid),
    );
    const amount = Number.isFinite(requested) ? Math.max(0, Math.min(requested, maxAmount)) : 0;
    this.setData({ prepaidCardAmountInput: amount.toFixed(2) });
    this.recomputePrepaidAmounts();
  },

  /** 切换积分抵扣开关 */
  onTogglePoints(e: WechatMiniprogram.CustomEvent) {
    const next = !!e.detail;
    if (next === this.data.usePoints) return;
    if (next && (this.data.customerPointsBalance <= 0 || this.data.maxPointsUsable <= 0 || this.data.saleOrderType !== '销售单')) {
      return;
    }
    this.setData({ usePoints: next });
    this.recomputePrepaidAmounts();
  },

  /** 活动单开关（纯标识，不影响金额/提成口径） */
  onToggleActivity(e: WechatMiniprogram.CustomEvent) {
    this.setData({ isActivity: !!e.detail });
  },

  /**
   * PR-C §C1 / §C5 — 订单类型 4 选 1 切换
   * - 所有员工均可选中任一订单类型；店长权限只在 onSubmitOrder 入口统一校验
   * - 转换单/寄存单守卫：clientUserId 必填（未注册顾客禁用对应 tab）
   * - 内部单/寄存单不允许券；销售单与转换单均可保留已选券
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
    // 每种订单类型的抵扣口径独立，切换后从 0.00 重新填写。
    update.useCard = false;
    update.prepaidCardAmountInput = '0.00';
    update.prepaidCardAmount = 0;
    update.prepaidCardMax = '0.00';
    if (next !== '销售单' && next !== '转换单' && this.data.selectedCoupon) {
      update.selectedCoupon = null;
      update.couponDiscount = 0;
      update.couponTotal = '';
    }
    if (next !== '销售单') {
      update.usePoints = false;
      update.pointsUsed = 0;
      update.pointsDiscount = 0;
      update.maxPointsUsable = 0;
    }
    if (next !== '转换单') {
      update.conversionSelectedSaleItemIds = [];
      update.conversionDeductibleSum = 0;
      update.conversionPriceDiff = 0;
      update.conversionPaymentMethod = null;
      update.conversionPrepaidCardAmount = 0;
      update.conversionRemaining = 0;
      update.conversionIsActivity = false;
      update.conversionCouponBaseTotal = 0;
      update.conversionCouponEnabled = false;
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
    const { selectedSaleItemIds, deductibleSum, priceDiff, paymentMethod, prepaidCardAmount, remaining, isActivity } = (e.detail || {}) as {
      selectedSaleItemIds?: string[];
      deductibleSum?: number;
      priceDiff?: number;
      paymentMethod?: '微信' | '支付宝' | '线下' | null;
      prepaidCardAmount?: number;
      remaining?: number;
      isActivity?: boolean;
    };
    const previousDeductibleSum = Number(this.data.conversionDeductibleSum) || 0;
    const nextDeductibleSum = Number(deductibleSum) || 0;
    this.setData({
      conversionSelectedSaleItemIds: selectedSaleItemIds || [],
      conversionDeductibleSum: nextDeductibleSum,
      conversionPriceDiff: Number(priceDiff) || 0,
      conversionPaymentMethod: paymentMethod ?? null,
      conversionPrepaidCardAmount: Number(prepaidCardAmount) || 0,
      conversionRemaining: Number(remaining) || 0,
      conversionIsActivity: !!isActivity,
    });
    // 折抵卡金额改变会收窄/放宽转换单可抵扣的正补差额。
    // 仅在折抵总额确实变化时重算，避免 convertInAmount observer 的回调循环。
    if (Math.abs(nextDeductibleSum - previousDeductibleSum) > 0.005) {
      this.updateCart(this.data.cart);
    }
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

  /**
   * 券可用性查询必须传券前成交行金额，不能使用已摊券的 saleAmount。
   * couponBaseAmount 在 updateCart 中按阶梯价/店长特价预算，和转换单服务端定价口径一致。
   */
  buildCouponRequestItems(cart: CartItem[]) {
    return cart.map(c => {
      const amount = Number(c.couponBaseAmount ?? c.priceLine ?? c.price * c.quantity);
      return {
        skuId: c.skuId,
        quantity: c.quantity,
        amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
      };
    });
  },

  async onSelectCoupon() {
    const { customerInfo, cart } = this.data;
    if (!customerInfo?.phone) return;
    if (this.data.saleOrderType === '转换单' && !this.data.conversionCouponEnabled) {
      wx.showToast({ title: '当前无正补差额，不能使用优惠券', icon: 'none' });
      return;
    }

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      const items = this.buildCouponRequestItems(cart);
      const data = await callStaffApi<CouponAvailableResponse>('coupon.available', {
        clientPhone: customerInfo.phone,
        items,
      });
      // expireAt 为原始 timestamp（序列化成 UTC 串），格式化为 YYYY-MM-DD 供「有效期至」展示
      const coupons = (data?.coupons || []).map(c => ({
        ...c,
        expireAt: c.expireAt ? formatDate(c.expireAt) : c.expireAt,
        ...buildCouponDisplay(c),
      }));
      this.setData({ availableCoupons: coupons });
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
      const items = this.buildCouponRequestItems(cart);
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
      // 2026-07-08 修复 T1：顾客未在小程序填写姓名时禁止开单。
      // 后端 sale_orders.customer_name 兜底逻辑是「客户档案权威 > 写入侧入参」，
      // 但这里拒绝让顾客在「未填写姓名」状态下开单，避免下游订单列表展示手机号当姓名。
      // 引导顾客先在小程序个人中心补全姓名（auth.updateProfile）。
      if (!customerInfo.name || !customerInfo.name.trim()) {
        wx.showModal({
          title: '无法开单',
          content: '该顾客尚未在小程序内填写姓名，请先让顾客在「我的-个人资料」补全姓名后再开单。',
          showCancel: false,
          confirmText: '知道了',
        });
        this.setData({ submitting: false });
        return;
      }
      // Wave 3G — 充值卡预选（不扣卡，仅作为后端写订单的预选值）
      // 决策 #6：店长开单 = 预选；balance 不动，extraField useCard + prepaidCardAmount 透传给云函数
      const useCard = this.data.useCard && this.data.prepaidCardAmount > 0;
      const prepaidCardAmount = useCard ? this.data.prepaidCardAmount : 0;
      const usePoints = saleOrderType === '销售单' && this.data.usePoints && this.data.pointsUsed > 0;
      const res = await callStaffApi<OrderCreateResponse>('order.create', {
        clientUserId: customerInfo.clientUserId,
        clientPhone: customerInfo.phone,
        clientName: customerInfo.name,
        // 销售单 / 内部单可选 微信 / 支付宝 / 线下；转换单不走此分支
        // Wave 3G：实付=0 时由后端强制覆盖为 '无'，前端仍传 paymentMethod 作为建议通道
        paymentMethod: this.data.paymentMethod,
        saleOrderType,
        items: cart.map(c => {
          // 店长特别优惠（仅销售单 + 普通商品）：手填应付覆盖 pre-coupon 行小计与成交单价。
          // 钳制 [0, price×qty]；未改时使用 priceLine（可能已由疗程阶梯价重算）。
          const editable = saleOrderType === '销售单' && !!c.isManagerSpecial
            && !c.refBundleId && c.productType !== '组合套餐';
          const hasOv = editable && c.saleAmountOverride != null && c.saleAmountOverride !== '';
          const effSale = hasOv
            ? Math.max(0, Math.min(parseFloat(c.saleAmountOverride as string) || 0, c.price * c.quantity))
            : (parseFloat(c.priceLine) || c.price * c.quantity);
          const effUnit = c.quantity > 0 ? effSale / c.quantity : effSale;
          return {
            skuId: c.skuId,
            workfineItemId: c.workfineItemId,
            spuName: c.spuName,
            specName: c.specName,
            quantity: c.quantity,
            // 价格三件套（套餐场景下 c.price=bundle_price、c.listPrice=sku 标价）：
            //   unitPrice     = sku 标价 per-card（落 sale_items.unit_price 标价快照）
            //   unitRealPrice = 成交价 per-card（落 unit_real_price；套餐 = bundle_price；店长特价 = 应付÷数量）
            //   saleAmount    = pre-coupon 行小计（= price × quantity，与 c.priceLine 同义；店长特价 = 手填应付）
            //                   ⚠️ 不是 c.saleAmount 那个已扣券值，避免后端摊券时双扣
            // 内部单后端会忽略价格字段强制 sku.price × 50% 重算
            unitPrice: ((c.listPrice ?? c.price) || 0).toFixed(2),
            unitRealPrice: effUnit.toFixed(2),
            saleAmount: effSale.toFixed(2),
            manualSaleAmountOverride: hasOv,
            // 行实付金额（店长可向下调整；默认=当前订单类型下的应付金额）
            received: parseFloat(c.received) || 0,
          };
        }),
        remark,
        // 内部单不允许优惠券（云函数已守卫）
        couponId: saleOrderType === '销售单'
          ? (this.data.selectedCoupon?.couponId || undefined)
          : undefined,
        preferredStaffWfId: this.data.preferredStaffWfId || undefined,
        // Wave 3G — 储值卡预选（决策 #6：店长不扣卡，云函数仅写订单字段）
        usePoints,
        pointsUsed: usePoints ? this.data.pointsUsed : undefined,
        useCard,
        prepaidCardAmount,
        // 活动单标记（纯标识）
        isActivity: this.data.isActivity,
        // 组合套餐：透传 bundleProductId（套餐 SPU id），云函数据此校验子项归属/配额并取下沉单价
        bundleProductId: cart.find(c => c.refBundleId)?.refBundleId || undefined,
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
        isActivity: false,
        usePoints: false,
        pointsUsed: 0,
        pointsDiscount: 0,
        maxPointsUsable: 0,
      });
      // 应付实金=0（券/卡全额抵扣，payable=0）→ 云端已结清为 '已支付'，无现金可收，不进 QR/收款页
      if (res.status === '已支付') {
        const title = Number(res.prepaidCardAmount || 0) > 0
          ? '储值卡已全额抵扣，订单已结清'
          : Number(res.pointsDiscount || 0) > 0
            ? '积分已全额抵扣，订单已结清'
          : '优惠券已全额抵扣，订单已结清';
        wx.showToast({ title, icon: 'none', duration: 2500 });
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
      conversionPrepaidCardAmount, conversionRemaining, selectedCoupon,
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
      const paymentMethod: '微信' | '支付宝' | '线下' =
        conversionRemaining > 0 ? (conversionPaymentMethod as '微信' | '支付宝' | '线下') : '微信';
      const res = await callStaffApi<{
        saleOrderId: string; priceDiff: number; prepaidCardCredit: number; prepaidCardAmount: number; status: string;
      }>('order.createConversion', {
        clientUserId: customerInfo.clientUserId,
        convertOutSaleItemIds: conversionSelectedSaleItemIds,
        convertInItems: cart.map(c => {
          const editable = !!c.isManagerSpecial && !c.refBundleId && c.productType !== '组合套餐';
          const hasOv = editable && c.saleAmountOverride != null && c.saleAmountOverride !== '';
          const effSale = hasOv
            ? Math.max(0, Math.min(parseFloat(c.saleAmountOverride as string) || 0, c.price * c.quantity))
            : (parseFloat(c.saleAmount) || c.price * c.quantity);
          const effUnit = c.quantity > 0 ? effSale / c.quantity : effSale;
          const item: Record<string, unknown> = {
            skuId: c.skuId,
            quantity: c.quantity,
          };
          if (hasOv) {
            item.unitPrice = ((c.listPrice ?? c.price) || 0).toFixed(2);
            item.unitRealPrice = effUnit.toFixed(2);
            item.saleAmount = effSale.toFixed(2);
            item.manualSaleAmountOverride = true;
          }
          return item;
        }),
        paymentMethod,
        couponId: selectedCoupon?.couponId || undefined,
        // 默认值也显式透传，保持转换单与普通开单的充值卡金额契约一致。
        prepaidCardAmount: conversionPrepaidCardAmount,
        isActivity: this.data.conversionIsActivity,
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
        conversionIsActivity: false,
      });
      // Toast 差异化
      const diff = Number(res.priceDiff) || 0;
      const card = Number(res.prepaidCardAmount) || 0;
      const remaining = Math.max(0, Math.round((diff - card) * 100) / 100);
      let title = '转换成功';
      if (diff > 0 && remaining > 0) {
        title = paymentMethod === '线下'
          ? `请确认补差额收款 ¥${remaining.toFixed(2)}`
          : `请${paymentMethod}支付差额 ¥${remaining.toFixed(2)}`;
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
    const { customerInfo, cart, remark, submitting, depositReceivedMap } = this.data;
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
      const res = await callStaffApi<{ saleOrderId: string; itemCount: number; status: string; message?: string }>(
        'order.createDeposit',
        {
          clientUserId: customerInfo.clientUserId,
          items: cart.map(c => ({
            skuId: c.skuId,
            quantity: c.quantity,
            received: Math.max(0, parseFloat(depositReceivedMap[c.skuId] || '0') || 0),
          })),
          remark: remark || undefined,
        }
      );
      this.saveRecentCustomer(customerInfo);
      this.updateCart([]);
      this.setData({
        showCheckout: false,
        saleOrderType: '销售单',
        depositReceivedMap: {},
      });
      wx.showToast({
        title: res.message || `寄存单已提交审批（${res.itemCount} 项）`,
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
