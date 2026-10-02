/**
 * 日常数据一览表（#369）的纯逻辑：三视角（经营类型 / 具体品项 / 二级品项）的列、逐店金额、尾差吸收、合计。
 *
 * 取数在 `actions/data-center/daily-overview.ts`，页面（MatrixTable）与异步导出（export-worker）
 * 都从这里的 `buildDailyOverviewColumns` 出列定义，表头 / 数值 / 合计不会在两边漂移。
 *
 * ## 口径（☆ 为默认口径，交付前待甲方确认）
 *
 * - ☆ 业绩 = 销售板「总业绩」：款项按归属日期计入，不带「父订单已结清」过滤（与 #300 同方向）；
 *   销售单 / 转换单按子项拆到经营类型与品项，充值单没有商品明细，单列「充值」。业绩合计含充值。
 * - 拆分：每行 receipt × 该款项金额 ÷ 该款项全部 receipts 之和（储值卡抵扣份额、转换单折抵残差自然剔除）。
 *   分母为 0 / 款项无 receipts / sku 为空 / SKU 挂在一级 / sales_category 为空 → 进「未分类」，不丢钱。
 * - 服务 = 销售板「总实耗」：单次优惠价 × 本次次数，已完成服务单、按 service_date、剔除寄存单退款专用单。
 * - 经营类型只看二级品项上的 sales_category（静态标签）；「他销他耗」不表示跨店核销。
 *
 * ## 尾差吸收规则（三视角同一条）
 *
 * 拆分后的金额是按比例缩放出来的，逐格四舍五入到分后与款项实收可能差几分。规则：
 *   1. 行合计（销售单 + 转换单部分）取款项金额的**精确值**（本身就是 2 位小数），充值原样计入；
 *   2. 各拆分格先四舍五入到分；
 *   3. 差额（分）并入该行拆分格中**绝对值最大**的一格（并列取展示顺序靠前者；舍入后全为 0 时退到**原始值**绝对值最大的一格；原始值也全为 0 才并入「未分类」）。
 * 于是逐店「∑拆分格 + 充值 = 业绩合计」精确成立，表尾合计 = 逐店之和，也精确成立。
 * 视角②（一级）由视角③（二级）按组求和得到，所以「组内 ∑二级 = 该一级」同样精确成立。
 */
import { SALES_CATEGORIES, type SalesCategory } from '@/lib/sales-categories'
import type { MatrixExportColumnSpec } from './matrix-export'

// ─── 视角 ────────────────────────────────────────────────────────────────────

export const DAILY_OVERVIEW_TABS = ['business', 'primary', 'secondary'] as const
export type DailyOverviewTab = (typeof DAILY_OVERVIEW_TABS)[number]

export const DAILY_OVERVIEW_TAB_LABELS: Record<DailyOverviewTab, string> = {
  business: '经营类型汇总',
  primary: '具体品项汇总',
  secondary: '二级品项汇总',
}

export const DEFAULT_DAILY_OVERVIEW_TAB: DailyOverviewTab = 'business'

/** URL `tab` 参数解析：非法值回落默认视角（URL 可被手改，不值得整页报错）。 */
export function parseDailyOverviewTab(raw: string | null | undefined): DailyOverviewTab {
  return (DAILY_OVERVIEW_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as DailyOverviewTab)
    : DEFAULT_DAILY_OVERVIEW_TAB
}

/**
 * 本页经营类型的**展示顺序**（原型 §5.1）。
 *
 * 有意偏离「`SALES_CATEGORIES` 的数组顺序即展示顺序」的仓库约定：原型把「他销他耗」排在「他销自耗」前。
 *
 * **不写四个分类的字面量**，而是从单源按位置取值再换位：本文件若再出现完整四元组，就成了
 * staffApi `sales-categories-enum-snapshot.test.js` 负向扫描要拦的「白名单外副本」。
 * 单源顺序由 sales-categories.test 钉死；枚举增删值时 sales-categories.test 的「集合相等」断言当场红，
 * 本页展示顺序的字面量快照在 daily-overview.test 里。
 */
const [SELF_SELF, OTHER_SELF, OTHER_OTHER, ECO] = SALES_CATEGORIES
export const DAILY_OVERVIEW_SALES_CATEGORY_ORDER: readonly SalesCategory[] = Object.freeze([
  SELF_SELF,
  OTHER_OTHER,
  OTHER_SELF,
  ECO,
])

// ─── 列 key ──────────────────────────────────────────────────────────────────

export const UNCLASSIFIED = 'unclassified'

export const DAILY_OVERVIEW_KEYS = {
  store: 'store',
  market: 'market',
  performance: (category: SalesCategory) => `perf:${category}`,
  performanceUnclassified: `perf:${UNCLASSIFIED}`,
  recharge: 'recharge',
  performanceTotal: 'perfTotal',
  service: (category: SalesCategory) => `svc:${category}`,
  serviceUnclassified: `svc:${UNCLASSIFIED}`,
  serviceTotal: 'svcTotal',
  primary: (categoryId: string) => `pri:${categoryId}`,
  secondary: (categoryId: string) => `sec:${categoryId}`,
  itemUnclassified: `item:${UNCLASSIFIED}`,
} as const

// ─── 取数输入（SQL 结果的归一形态）──────────────────────────────────────────

export interface DailyOverviewStore {
  storeId: string
  storeName: string
  marketId: string
  marketName: string
}

export interface DailyOverviewCategoryRow {
  categoryId: string
  categoryName: string
  /** 一级行为 null；二级行为所属一级的 category_name */
  productKind: string | null
  sortOrder: number
  isValid: boolean
}

export interface DailyOverviewInput {
  /** scope 内全部启用门店（含零业绩门店） */
  stores: readonly DailyOverviewStore[]
  categories: readonly DailyOverviewCategoryRow[]
  /**
   * 销售单 / 转换单业绩的拆分片段（未舍入的缩放金额）。
   * salesCategory 为 null → 经营类型「未分类」；categoryId 为 null 或不是有效二级 → 品项「未分类」。
   * 无 receipts / 分母为 0 的款项整笔以 (null, null) 出现。
   */
  performanceParts: ReadonlyArray<{ storeId: string; salesCategory: string | null; categoryId: string | null; amount: string | number }>
  /** 销售单 / 转换单款项金额的精确合计（逐店，2 位小数） */
  performanceTotals: ReadonlyArray<{ storeId: string; amount: string | number }>
  /** 充值单款项金额（逐店，2 位小数） */
  recharge: ReadonlyArray<{ storeId: string; amount: string | number }>
  /** 实耗按 service_items.sales_category 分组（逐店，2 位小数） */
  service: ReadonlyArray<{ storeId: string; salesCategory: string | null; amount: string | number }>
}

// ─── 输出 ────────────────────────────────────────────────────────────────────

export interface DailyOverviewRow extends DailyOverviewStore {
  /** 列 key → 金额（元，已按尾差规则精确到分） */
  values: Record<string, number>
}

export interface DailyOverviewCategoryColumn {
  categoryId: string
  name: string
}

export interface DailyOverviewSecondaryGroup extends DailyOverviewCategoryColumn {
  children: DailyOverviewCategoryColumn[]
}

export interface DailyOverviewData {
  rows: DailyOverviewRow[]
  /** 表尾合计（= 全部门店行之和，按分精确求和） */
  totals: Record<string, number>
  /** 视角② 的一级列（按一级 sort_order） */
  primaries: DailyOverviewCategoryColumn[]
  /** 视角③ 的二级列，按一级打组 */
  secondaryGroups: DailyOverviewSecondaryGroup[]
  /** 各「未分类」兜底列是否有数（没有数时隐藏） */
  showUnclassified: { performance: boolean; service: boolean; item: boolean }
  /** 范围跨市场：表格显示所属市场列 */
  multiMarket: boolean
}

// ─── 金额工具（一律按「分」整数运算，避免浮点累加误差）─────────────────────

/** 元（数值或 PG numeric 字符串）→ 分。非有限值按 0（取数层已 COALESCE，这里只是兜底）。 */
export function toCents(value: string | number | null | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed == null || !Number.isFinite(parsed)) return 0
  return Math.round(parsed * 100)
}

function fromCents(cents: number): number {
  // `|| 0` 把 -0 归一成 0：正负抵消后的格子否则会显示成「-0.00」
  return cents / 100 || 0
}

/**
 * 把一组未舍入的拆分金额（元）舍入到分，差额并入绝对值最大的一格，使 ∑ = exactTotalCents。
 * @param order 展示顺序：并列时取靠前者；全为 0 时并入 fallbackKey
 */
export function absorbRounding(
  raw: ReadonlyMap<string, number>,
  exactTotalCents: number,
  order: readonly string[],
  fallbackKey: string,
): Map<string, number> {
  const cents = new Map<string, number>()
  for (const key of order) cents.set(key, Math.round((raw.get(key) ?? 0) * 100) || 0)
  let sum = 0
  for (const value of cents.values()) sum += value
  const diff = exactTotalCents - sum
  if (diff !== 0) {
    // 舍入误差每格不超过半分：差额明显超过格数说明拆分片段与款项合计对不上（SQL 回归），
    // 照样吸收保证合计不错，但留下日志，不让它被静默吞掉
    if (Math.abs(diff) > order.length) {
      console.warn(`[daily-overview] 拆分片段与款项合计相差 ${diff} 分，超出舍入误差`)
    }
    // 目标格：舍入后绝对值最大者；全为 0 时退到原始值绝对值最大者（不让不足一分的正常拆分冒成「未分类」）；
    // 两者都为 0 才并入兜底格
    const pick = (magnitudeOf: (key: string) => number) => {
      let target: string | null = null
      let best = 0
      for (const key of order) {
        const magnitude = magnitudeOf(key)
        if (magnitude > best) {
          best = magnitude
          target = key
        }
      }
      return target
    }
    const target = pick((key) => Math.abs(cents.get(key) ?? 0))
      ?? pick((key) => Math.abs(raw.get(key) ?? 0))
      ?? fallbackKey
    cents.set(target, (cents.get(target) ?? 0) + diff)
  }
  return cents
}

// ─── 品项树 ──────────────────────────────────────────────────────────────────

interface CategoryTree {
  /** 按（一级 sort_order，二级 sort_order，category_id）排好的一级，各自带二级 */
  primaries: Array<DailyOverviewCategoryRow & { children: DailyOverviewCategoryRow[] }>
  /** 有效挂接的二级 category_id → 所属一级 category_id */
  parentOf: Map<string, string>
}

function compareCategory(a: DailyOverviewCategoryRow, b: DailyOverviewCategoryRow): number {
  return a.sortOrder - b.sortOrder || (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0)
}

/**
 * 二级按 `product_kind` 文本挂到同名一级下；不能按 category_name 分组（不同一级下可能有同名二级，
 * prod 就有一级「招牌」下的二级「招牌」）。一级重名时挂到排序靠前的那个；找不到一级的二级视为未挂接（进未分类）。
 */
function buildCategoryTree(categories: readonly DailyOverviewCategoryRow[]): CategoryTree {
  const primaries = categories
    .filter((row) => row.productKind === null)
    .sort(compareCategory)
    .map((row) => ({ ...row, children: [] as DailyOverviewCategoryRow[] }))
  const primaryByName = new Map<string, (typeof primaries)[number]>()
  for (const primary of primaries) {
    if (!primaryByName.has(primary.categoryName)) primaryByName.set(primary.categoryName, primary)
  }
  const parentOf = new Map<string, string>()
  for (const row of [...categories].sort(compareCategory)) {
    if (row.productKind === null) continue
    const parent = primaryByName.get(row.productKind)
    if (!parent) continue
    parent.children.push(row)
    parentOf.set(row.categoryId, parent.categoryId)
  }
  return { primaries, parentOf }
}

// ─── 组装 ────────────────────────────────────────────────────────────────────

function byStore<T extends { storeId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const list = map.get(row.storeId)
    if (list) list.push(row)
    else map.set(row.storeId, [row])
  }
  return map
}

function sumCentsByStore(rows: ReadonlyArray<{ storeId: string; amount: string | number }>): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows) map.set(row.storeId, (map.get(row.storeId) ?? 0) + toCents(row.amount))
  return map
}

const collator = new Intl.Collator('zh-CN', { numeric: true })

export function buildDailyOverview(input: DailyOverviewInput): DailyOverviewData {
  const K = DAILY_OVERVIEW_KEYS
  const tree = buildCategoryTree(input.categories)
  const salesCategories = new Set<string>(DAILY_OVERVIEW_SALES_CATEGORY_ORDER)
  const isSalesCategory = (value: string | null): value is SalesCategory => value !== null && salesCategories.has(value)

  const partsByStore = byStore(input.performanceParts)
  const serviceByStore = byStore(input.service)
  const performanceTotals = sumCentsByStore(input.performanceTotals)
  const recharge = sumCentsByStore(input.recharge)

  const businessKeys = [...DAILY_OVERVIEW_SALES_CATEGORY_ORDER.map((c) => K.performance(c)), K.performanceUnclassified]
  const secondaryKeys = [
    ...tree.primaries.flatMap((primary) => primary.children.map((child) => K.secondary(child.categoryId))),
    K.itemUnclassified,
  ]

  // 门店顺序：市场名 → 门店名 → store_id（唯一键兜底，#282）
  const stores = [...input.stores].sort(
    (a, b) =>
      collator.compare(a.marketName, b.marketName) ||
      collator.compare(a.storeName, b.storeName) ||
      (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0),
  )

  const totalsCents = new Map<string, number>()
  const addTotal = (key: string, cents: number) => totalsCents.set(key, (totalsCents.get(key) ?? 0) + cents)

  const rows: DailyOverviewRow[] = stores.map((store) => {
    const cents = new Map<string, number>()
    const parts = partsByStore.get(store.storeId) ?? []
    const exactPerformance = performanceTotals.get(store.storeId) ?? 0
    const rechargeCents = recharge.get(store.storeId) ?? 0

    // 视角①：经营类型
    const businessRaw = new Map<string, number>()
    // 视角③：二级品项
    const secondaryRaw = new Map<string, number>()
    for (const part of parts) {
      const amount = typeof part.amount === 'string' ? Number(part.amount) : part.amount
      if (!Number.isFinite(amount)) continue
      const businessKey = isSalesCategory(part.salesCategory)
        ? K.performance(part.salesCategory)
        : K.performanceUnclassified
      businessRaw.set(businessKey, (businessRaw.get(businessKey) ?? 0) + amount)
      // SKU 挂在一级上、分类已删除、二级找不到一级：都不是可展示的二级 → 未分类
      const secondaryKey = part.categoryId && tree.parentOf.has(part.categoryId)
        ? K.secondary(part.categoryId)
        : K.itemUnclassified
      secondaryRaw.set(secondaryKey, (secondaryRaw.get(secondaryKey) ?? 0) + amount)
    }
    for (const [key, value] of absorbRounding(businessRaw, exactPerformance, businessKeys, K.performanceUnclassified)) {
      cents.set(key, value)
    }
    const secondaryCents = absorbRounding(secondaryRaw, exactPerformance, secondaryKeys, K.itemUnclassified)
    for (const [key, value] of secondaryCents) cents.set(key, value)
    for (const primary of tree.primaries) {
      let sum = 0
      for (const child of primary.children) sum += secondaryCents.get(K.secondary(child.categoryId)) ?? 0
      cents.set(K.primary(primary.categoryId), sum)
    }
    cents.set(K.recharge, rechargeCents)
    cents.set(K.performanceTotal, exactPerformance + rechargeCents)

    // 服务：金额本身就是 2 位小数，逐格精确
    let serviceTotal = 0
    for (const category of DAILY_OVERVIEW_SALES_CATEGORY_ORDER) cents.set(K.service(category), 0)
    cents.set(K.serviceUnclassified, 0)
    for (const row of serviceByStore.get(store.storeId) ?? []) {
      const key = isSalesCategory(row.salesCategory)
        ? K.service(row.salesCategory)
        : K.serviceUnclassified
      const value = toCents(row.amount)
      cents.set(key, (cents.get(key) ?? 0) + value)
      serviceTotal += value
    }
    cents.set(K.serviceTotal, serviceTotal)

    const values: Record<string, number> = {}
    for (const [key, value] of cents) {
      values[key] = fromCents(value)
      addTotal(key, value)
    }
    return { ...store, values }
  })

  const totals: Record<string, number> = {}
  for (const [key, value] of totalsCents) totals[key] = fromCents(value)

  const hasData = (key: string) => rows.some((row) => (row.values[key] ?? 0) !== 0)

  // 停用的分类只要期间内有数就仍然显示；有效分类恒显示（新增二级刷新即出列）
  const secondaryGroups: DailyOverviewSecondaryGroup[] = []
  const primaries: DailyOverviewCategoryColumn[] = []
  for (const primary of tree.primaries) {
    const children = primary.children
      .filter((child) => child.isValid || hasData(K.secondary(child.categoryId)))
      .map((child) => ({ categoryId: child.categoryId, name: child.categoryName }))
    if (children.length > 0) {
      secondaryGroups.push({ categoryId: primary.categoryId, name: primary.categoryName, children })
    }
    // 视角③显示了该组，视角②就必须有这一列，否则两视角对不上
    if (primary.isValid || hasData(K.primary(primary.categoryId)) || children.length > 0) {
      primaries.push({ categoryId: primary.categoryId, name: primary.categoryName })
    }
  }

  return {
    rows,
    totals,
    primaries,
    secondaryGroups,
    showUnclassified: {
      performance: hasData(K.performanceUnclassified),
      service: hasData(K.serviceUnclassified),
      item: hasData(K.itemUnclassified),
    },
    multiMarket: new Set(stores.map((store) => store.marketId)).size > 1,
  }
}

// ─── 指标卡 ──────────────────────────────────────────────────────────────────

export interface DailyOverviewKpiValues {
  performanceTotal: number
  serviceTotal: number
  /** 自销自耗业绩 ÷ 业绩合计（☆ 分母含充值，跟业绩口径走）；遇负数照常计算（验收要求），分母为 0 → null */
  selfShare: number | null
  /** 生态合作业绩 ÷ 业绩合计；同上 */
  ecoShare: number | null
  /** 业绩合计 ÷ n（n = 表格门店行数，含零业绩门店）；n = 0 → null */
  averagePerStore: number | null
  storeCount: number
}

export function computeDailyOverviewKpis(data: DailyOverviewData): DailyOverviewKpiValues {
  const K = DAILY_OVERVIEW_KEYS
  const total = data.totals[K.performanceTotal] ?? 0
  // 验收：「占比遇到负数照常计算」——只有分母为 0 算不出。与 #310 不冲突：#310 管的是增幅徽章的负基期
  const share = (key: string) => (total !== 0 ? (data.totals[key] ?? 0) / total || 0 : null)
  const storeCount = data.rows.length
  return {
    performanceTotal: total,
    serviceTotal: data.totals[K.serviceTotal] ?? 0,
    selfShare: share(K.performance(SELF_SELF)),
    ecoShare: share(K.performance(ECO)),
    averagePerStore: storeCount > 0 ? total / storeCount : null,
    storeCount,
  }
}

// ─── 列定义（页面与导出共用）────────────────────────────────────────────────

export interface DailyOverviewColumn extends MatrixExportColumnSpec<DailyOverviewRow> {
  /** 文本列（门店 / 所属市场）；其余为金额列 */
  text?: 'store' | 'market'
  /** 服务类列：浅绿底（原型 §5.1） */
  band?: 'service'
  hint?: string
}

const STORE_WIDTH = 140
const MARKET_WIDTH = 110
const AMOUNT_WIDTH = 120

function amountColumn(key: string, header: string, extra: Partial<DailyOverviewColumn> = {}): DailyOverviewColumn {
  return {
    key,
    header,
    width: AMOUNT_WIDTH,
    unit: 'amount',
    value: (row) => row.values[key] ?? 0,
    aggregate: { kind: 'sum' },
    exportWidth: 14,
    ...extra,
  }
}

function leadingColumns(data: DailyOverviewData): DailyOverviewColumn[] {
  const K = DAILY_OVERVIEW_KEYS
  const columns: DailyOverviewColumn[] = [
    {
      key: K.store,
      header: '门店',
      text: 'store',
      width: STORE_WIDTH,
      freeze: 'left',
      exportValue: (row) => row.storeName,
      exportWidth: 18,
    },
  ]
  if (data.multiMarket) {
    columns.push({
      key: K.market,
      header: '所属市场',
      text: 'market',
      width: MARKET_WIDTH,
      freeze: 'left',
      exportValue: (row) => row.marketName,
      exportWidth: 14,
    })
  }
  return columns
}

const PERFORMANCE_TOTAL_HINT = '= 各经营类型业绩 + 未分类 + 充值，与销售板「总业绩」同口径'
const RECHARGE_HINT = '充值单没有商品明细，单列；储值卡消费不再重复计入各品项'
const UNCLASSIFIED_HINT = '经营类型或品项无法判定的业绩（无子项明细、SKU 未挂二级品项等），计入合计、不丢钱'

/** 按视角出列。门店列左冻结；跨市场时追加「所属市场」列。 */
export function buildDailyOverviewColumns(tab: DailyOverviewTab, data: DailyOverviewData): DailyOverviewColumn[] {
  const K = DAILY_OVERVIEW_KEYS
  const columns = leadingColumns(data)

  if (tab === 'business') {
    for (const category of DAILY_OVERVIEW_SALES_CATEGORY_ORDER) {
      columns.push(amountColumn(K.performance(category), `${category}业绩`))
    }
    if (data.showUnclassified.performance) {
      columns.push(amountColumn(K.performanceUnclassified, '未分类业绩', { hint: UNCLASSIFIED_HINT }))
    }
    columns.push(amountColumn(K.recharge, '充值', { hint: RECHARGE_HINT }))
    columns.push(amountColumn(K.performanceTotal, '业绩合计', { hint: PERFORMANCE_TOTAL_HINT }))
    for (const category of DAILY_OVERVIEW_SALES_CATEGORY_ORDER) {
      columns.push(amountColumn(K.service(category), `${category}服务`, { band: 'service' }))
    }
    if (data.showUnclassified.service) {
      columns.push(amountColumn(K.serviceUnclassified, '未分类服务', { band: 'service' }))
    }
    columns.push(amountColumn(K.serviceTotal, '服务合计', {
      band: 'service',
      hint: '单次优惠价 × 本次次数，按服务日期、已完成服务单，剔除寄存单退款专用单；含寄存单老卡核销。与销售板「总实耗」同口径',
    }))
    return columns
  }

  if (tab === 'primary') {
    for (const primary of data.primaries) {
      columns.push(amountColumn(K.primary(primary.categoryId), primary.name))
    }
  } else {
    for (const group of data.secondaryGroups) {
      for (const child of group.children) {
        columns.push(amountColumn(K.secondary(child.categoryId), child.name, {
          group: { key: group.categoryId, header: group.name },
        }))
      }
    }
  }
  if (data.showUnclassified.item) {
    columns.push(amountColumn(K.itemUnclassified, '未分类', { hint: UNCLASSIFIED_HINT }))
  }
  columns.push(amountColumn(K.recharge, '充值', { hint: RECHARGE_HINT }))
  columns.push(amountColumn(K.performanceTotal, '品项业绩合计', { hint: PERFORMANCE_TOTAL_HINT }))
  return columns
}
