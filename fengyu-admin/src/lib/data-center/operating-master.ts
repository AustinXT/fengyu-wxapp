/**
 * 经营数据主表（#372）的列定义与行装配（纯逻辑，页面 / Server Action / 导出共用）。
 *
 * 列结构照抄《经营数据主表.xlsx》「凤御·经营」B~Y 列：表头两行，上行是分组标题（B–D 留空），
 * 下行是明细列。页面（MatrixTable）与导出（export-worker）从本文件的同一份列定义出发，
 * 表头 / 单位 / 合计口径不会漂移。
 *
 * 取数列（#372 首版 D / P / R / V / W / X；#373 补 E–I、K–M、S–U、Y）。比率列（G / I / M / Y）按模板公式
 * G=F/E、I=H/F、M=K/E、Y=X/U 由同行分子分母现算，小计 / 合计行用合计后的分子分母重算（不取各行比率平均）。
 * 小计与合计按「有 value 的列」挑取（见 METRIC_COLUMNS）。
 *
 * 「时间点」T（#373 拍板）：页面仍选月份，T = min(所选月末, 今天)；「当月」= 月初 ~ T，「年度」= 当年 1 月 1 日 ~ T。
 * 过去月份的 T 就是月末；当月的 T 是今天（今天之后的日期本就没有服务单 / 款项，按月末取数等价）。
 * 唯一依赖 T 本身的是 E 保有会员（截至 T 近 90 天到店），见 retainedAsOf。
 *
 * 目标列 J、N、O、Q（#374，2026-09-25 拍板本期固定「—」、合计行也「—」）仍是占位列。
 *
 * 口径登记：notes/references/metrics.md §经营数据主表。
 */
import { computeMatrixTotals, type MatrixColumnGroup, type MatrixTotals } from './matrix'
import type { MatrixExportColumnSpec } from './matrix-export'
import { monthRange } from './report-period'
import { addDays, shanghaiToday } from './time-range'
import type { DataCenterScope, MetricUnit, ResolvedRange } from './types'

/** 能取数的列（服务端按门店给值） */
export const OPERATING_MASTER_METRIC_KEYS = [
  'beauticianCount',
  'retainedMembers',
  'returnOnceHeads',
  'returnTwiceHeads',
  'managedYearCustomers',
  'managedMonthCustomers',
  'monthRevenue',
  'ytdRevenue',
  'monthFootfall',
  'preSaleFootfall',
  'afterSaleFootfall',
  'shengmeiProjectCount',
  'monthConsume',
  'shengmeiConsume',
] as const
export type OperatingMasterMetricKey = (typeof OPERATING_MASTER_METRIC_KEYS)[number]

export type OperatingMasterMetrics = Record<OperatingMasterMetricKey, number>

export interface OperatingMasterRow {
  /** 门店行 = store_id；市场小计行 = `subtotal:<市场 id>` */
  rowKey: string
  kind: 'store' | 'subtotal'
  marketId: string
  marketName: string
  storeId: string | null
  /** 小计行为「小计」 */
  storeName: string
  /** 只含可加列（比率列由 value 现算）。小计行的值来自 computeMatrixTotals（可能为 null）；门店行恒有值（无数据 = 0） */
  values: Partial<Record<OperatingMasterMetricKey, number | null>>
}

/** 占位列的口径来源 */
export type OperatingMasterPending = '#374'

export interface OperatingMasterColumn extends MatrixExportColumnSpec<OperatingMasterRow> {
  /** 模板列号（B~Y），便于对账与评审 */
  letter: string
  hint?: string
  align?: 'left' | 'center' | 'right'
  /** 占位列：本期显示「—」，合计行也显示「—」 */
  pending?: OperatingMasterPending
}

// ─── 分组表头（模板 E2 / J2 / N2 / S2 全文，含口径说明行） ─────────────────────

/**
 * B–D 上方是模板里空的合并格（B2:D2）。冻结边界（市场、门店冻结，D 不冻结）两侧不能共用一个分组
 * （分组格跨冻结边界会整块钉住，见 computeFrozenPositions），所以拆成两个空白分组。
 */
const BLANK_FROZEN_GROUP: MatrixColumnGroup = { key: 'blank-frozen', header: '' }
const BLANK_GROUP: MatrixColumnGroup = { key: 'blank', header: '' }

const RETAINED_GROUP: MatrixColumnGroup = {
  key: 'retained',
  header: '保有会员（售前不算）\n会员标准：单笔订单≥1990元(购买疗程有余卡顾客)\n当月回店1次的人头目标：80%\n当月回店人头到店2次的目标：60%',
  color: '#EAF2FB',
}
const MANAGED_GROUP: MatrixColumnGroup = {
  key: 'managed',
  header: '被经营顾客目标(拆分季度/月度)\n核算标准：消费≥1990算人数\n一季度目标:20%-30%，二季度目标:50%-60%\n三季度目标:70%-80%，四季度目标:100%完成',
  color: '#EDF6EA',
}
const SALES_GROUP: MatrixColumnGroup = {
  key: 'sales',
  header: '销售业绩目标',
  color: '#FFF3E0',
}
const FOOTFALL_GROUP: MatrixColumnGroup = {
  key: 'footfall',
  header: '客流及客耗\n美容师:3人/250客流 4人/300客量 5人/400客流\n美容师消耗：每天1000元\n客流目标：售前20%  售后80%',
  color: '#F3EEF9',
}

/** 两行表头高度：分组标题最多 4 行、列名 2 行 */
export const OPERATING_MASTER_HEADER_HEIGHTS = [84, 44] as const

// ─── 列定义 ───────────────────────────────────────────────────────────────────

/**
 * 列宽按列名最长的一行估算（text-xs 约 12px/字 + 左右内边距与「?」说明图标约 48px），
 * 保证模板两行列名不被挤成三四行；数值列再按单位给下限。
 */
function headerWidth(header: string, min: number): number {
  const longest = Math.max(...header.split('\n').map((line) => line.length))
  return Math.max(min, longest * 12 + 48)
}

/**
 * 导出列宽（Excel 字符宽度）：按列名最长一行估，中文按 2、其余按 1，再加 2 的余量——
 * 流式写出的行高只按换行数给，列宽不够导致 Excel 再自动折行时文字会被裁掉。
 */
function headerExportWidth(header: string, min: number): number {
  const longest = Math.max(...header.split('\n').map((line) =>
    [...line].reduce((sum, char) => sum + (/[\u0000-\u00ff]/.test(char) ? 1 : 2), 0)))
  return Math.max(min, longest + 2)
}

function metric(key: OperatingMasterMetricKey) {
  return (row: OperatingMasterRow) => row.values[key] ?? null
}

function pendingColumn(
  letter: string,
  key: string,
  header: string,
  group: MatrixColumnGroup,
  unit: MetricUnit,
  pending: OperatingMasterPending,
): OperatingMasterColumn {
  return {
    letter,
    key,
    header,
    group,
    unit,
    pending,
    align: 'right',
    width: headerWidth(header, 96),
    hint: '目标列：本期不取数（#374）',
    exportValue: () => '—',
    exportWidth: headerExportWidth(header, 12),
  }
}

/** 数值列的公共部分（右对齐、按单位给列宽下限） */
function numberColumn(
  letter: string,
  key: string,
  header: string,
  group: MatrixColumnGroup,
  unit: MetricUnit,
  hint: string,
): OperatingMasterColumn {
  return {
    letter,
    key,
    header,
    group,
    unit,
    align: 'right',
    width: headerWidth(header, unit === 'amount' ? 120 : 96),
    hint,
    exportWidth: headerExportWidth(header, unit === 'amount' ? 16 : 12),
  }
}

/** 可加列：服务端按门店给值，小计 / 合计逐店相加 */
function metricColumn(
  letter: string,
  key: OperatingMasterMetricKey,
  header: string,
  group: MatrixColumnGroup,
  unit: MetricUnit,
  hint: string,
): OperatingMasterColumn {
  return { ...numberColumn(letter, key, header, group, unit, hint), value: metric(key), aggregate: { kind: 'sum' } }
}

/** 比率：分母 ≤ 0 或任一侧为空 → null（与 computeMatrixTotals 的合计口径一致） */
function ratioOf(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  return denominator > 0 ? numerator / denominator : null
}

/** 比率列：门店 / 小计行由同行分子分母现算；合计行用合计后的分子分母重算 */
function ratioColumn(
  letter: string,
  key: string,
  header: string,
  group: MatrixColumnGroup,
  unit: MetricUnit,
  numerator: OperatingMasterMetricKey,
  denominator: OperatingMasterMetricKey,
  hint: string,
): OperatingMasterColumn {
  const top = metric(numerator)
  const bottom = metric(denominator)
  return {
    ...numberColumn(letter, key, header, group, unit, hint),
    value: (row) => ratioOf(top(row), bottom(row)),
    aggregate: { kind: 'ratio', numerator: top, denominator: bottom },
  }
}

/**
 * 列键全部唯一：市场 / 门店是 `marketName` / `storeName`，不与被经营率、当月客流等数值列共用键
 * （原型 §5.3 易错点；reports 单测断言唯一）。
 */
export const OPERATING_MASTER_COLUMNS: readonly OperatingMasterColumn[] = [
  {
    letter: 'B',
    key: 'marketName',
    header: '市场',
    group: BLANK_FROZEN_GROUP,
    freeze: 'left',
    width: 112,
    exportValue: (row) => row.marketName,
    exportWidth: 14,
  },
  {
    letter: 'C',
    key: 'storeName',
    header: '门店',
    group: BLANK_FROZEN_GROUP,
    freeze: 'left',
    width: 148,
    exportValue: (row) => row.storeName,
    exportWidth: 16,
  },
  metricColumn('D', 'beauticianCount', '美容师\n人数', BLANK_GROUP, 'count',
    '统计月末在职、技能含「美容师」的员工，按当前归属门店计（调店不做历史化）；直挂市场 / 部门的员工不属于任何门店，不计入'),

  metricColumn('E', 'retainedMembers', '保有会员\n近90天到店人头', RETAINED_GROUP, 'count',
    '截至统计时点（所选月末；当月为今天）前 90 天内有已完成服务单、且已成为会员的顾客，按顾客绑定门店计。'
    + '与客量板「有效保有会员」同口径（即顾客状态「保有会员-稳定 / 有效」按时点还原）'),
  metricColumn('F', 'returnOnceHeads', '回店1次\n当月人头', RETAINED_GROUP, 'count',
    '保有会员（E）中当月到店天数 ≥1 的人头：到店天数按服务日期去重（同日多单算 1 天），不限到店门店'),
  ratioColumn('G', 'returnOnceRate', '回店1次\n达成率', RETAINED_GROUP, 'percent', 'returnOnceHeads', 'retainedMembers',
    '回店1次当月人头 ÷ 保有会员（F / E）'),
  metricColumn('H', 'returnTwiceHeads', '回店≥2次\n当月人头', RETAINED_GROUP, 'count',
    '保有会员（E）中当月到店天数 ≥2 的人头（H ⊆ F）'),
  ratioColumn('I', 'returnTwiceRate', '回店≥2次\n达成率', RETAINED_GROUP, 'percent', 'returnTwiceHeads', 'returnOnceHeads',
    '回店≥2次当月人头 ÷ 回店1次当月人头（H / F）'),

  pendingColumn('J', 'managedYearTarget', '被经营顾客\n年度目标', MANAGED_GROUP, 'count', '#374'),
  metricColumn('K', 'managedYearCustomers', '被经营顾客\n年度消费人数', MANAGED_GROUP, 'count',
    '当年 1 月 1 日至统计时点，在本店的消费（销售单 + 转换单款项，含退款冲减；不含充值、储值卡抵扣、寄存单）累计 ≥ 会员门槛（系统设置）的顾客数，按下单门店计。'
    + '不含 WorkFine 历史单；跨店消费的顾客可能在多家店各计一次，合计为逐店相加'),
  metricColumn('L', 'managedMonthCustomers', '被经营顾客\n当月消费人数', MANAGED_GROUP, 'count',
    '当月在本店的消费（同 K 的款项口径）累计 ≥ 会员门槛的顾客数，按下单门店计'),
  ratioColumn('M', 'managedRate', '被经营率\n年度标准60%', MANAGED_GROUP, 'percent', 'managedYearCustomers', 'retainedMembers',
    '被经营顾客年度消费人数 ÷ 保有会员（K / E）'),

  pendingColumn('N', 'salesYearTarget', '年度销售\n业绩目标', SALES_GROUP, 'amount', '#374'),
  pendingColumn('O', 'salesMonthTarget', '当月业绩\n目标', SALES_GROUP, 'amount', '#374'),
  metricColumn('P', 'monthRevenue', '当月\n完成', SALES_GROUP, 'amount',
    '当月总业绩：与销售板「门店」明细的「总业绩」同口径（款项按业绩归属日期计入，含退款冲减）'),
  pendingColumn('Q', 'salesCompletionRate', '当月\n完成率', SALES_GROUP, 'percent', '#374'),
  metricColumn('R', 'ytdRevenue', '年度\n累计达成', SALES_GROUP, 'amount',
    '当年 1 月至所选月份各月「当月完成」之和。只含新系统上线后的数据，不含 WorkFine 历史单'),

  metricColumn('S', 'monthFootfall', '当月服务\n到店天数', FOOTFALL_GROUP, 'count',
    '当月在本店有已完成服务单的「顾客 × 服务日期」数（同一顾客同一天多单只算 1 天，剔除寄存单退款专用单）。'
    + '与客量板「客流量（次）」按单数计不同'),
  metricColumn('T', 'preSaleFootfall', '当月售前\n到店天数', FOOTFALL_GROUP, 'count',
    '当天在本店的服务单核销过体验项目的到店天数（查询时判定，不读服务单开单时的售前 / 售后标记）'),
  metricColumn('U', 'afterSaleFootfall', '当月售后\n到店天数', FOOTFALL_GROUP, 'count',
    '服务到店天数 − 售前到店天数（S − T）'),
  metricColumn('V', 'shengmeiProjectCount', '当月\n生美项目数', FOOTFALL_GROUP, 'count',
    '已完成服务单中生美项目的核销次数之和（剔除寄存单退款专用单）。与人效板、门店榜的「项目数」（按经营类型统计）口径不同'),
  metricColumn('W', 'monthConsume', '当月\n总实耗', FOOTFALL_GROUP, 'amount',
    '与销售板「门店」明细的「总实耗」同口径'),
  metricColumn('X', 'shengmeiConsume', '当月\n生美实耗', FOOTFALL_GROUP, 'amount',
    '与销售板「门店」明细的「生美实耗」同口径（按服务项目的「是否生美」标记）'),
  ratioColumn('Y', 'shengmeiConsumePerVisit', '单次\n生美客耗', FOOTFALL_GROUP, 'amount', 'shengmeiConsume', 'afterSaleFootfall',
    '当月生美实耗 ÷ 当月售后到店天数（X / U）'),
]

// ─── 期间 ─────────────────────────────────────────────────────────────────────

/** R / K 列的年度累计区间：当年 1 月 1 日 ~ 所选月末。1 月时与当月区间相同（R = P、K = L）。 */
export function ytdRange(month: string): ResolvedRange {
  return { start: `${month.slice(0, 4)}-01-01`, end: monthRange(month).end }
}

/** 统计时点 T = min(所选月末, 今天)（#373「选时间点」拍板）：E 保有会员截至这一天 */
export function retainedAsOf(month: string, today: string = shanghaiToday()): string {
  const end = monthRange(month).end
  return end < today ? end : today
}

/** E 保有会员的到店窗口 [T − 90 天, T]（与客量板有效保有会员的 `T::date - INTERVAL '90 days'` 同一天） */
export function retainedWindow(month: string, today?: string): ResolvedRange {
  const end = retainedAsOf(month, today)
  return { start: addDays(end, -90), end }
}

// ─── 行装配 ───────────────────────────────────────────────────────────────────

export interface OperatingMasterStore {
  storeId: string
  storeName: string
  marketId: string
  marketName: string
}

export interface OperatingMasterTable {
  rows: OperatingMasterRow[]
  /** 表尾合计（跨市场时即「总计」）：含全部取数列（比率列为合计后重算的比率）；占位列不在内 */
  totals: MatrixTotals
  /** 门店行数（不含小计） */
  storeCount: number
  /** 行跨了不止一个市场：每个市场后插一行小计，表尾标签为「总计」 */
  multiMarket: boolean
}

/** 有 value 的列 = 参与小计 / 合计的列（可加列求和、比率列重算） */
const METRIC_COLUMNS = OPERATING_MASTER_COLUMNS.filter((column) => column.value)
const metricColumnKeys = METRIC_COLUMNS.map((column) => column.key)

/**
 * 门店骨架 + 各指标 → 表格行。门店按传入顺序（调用方已按市场、门店排好）；
 * 跨市场时每个市场的门店之后插一行小计。小计与合计都只由门店行算出（computeMatrixTotals：
 * 可加列求和，比率列用合计后的分子分母重算）——小计行不参与合计，同一笔钱不会算两遍。
 */
export function buildOperatingMasterTable(
  stores: readonly OperatingMasterStore[],
  metrics: ReadonlyMap<string, Partial<OperatingMasterMetrics>>,
): OperatingMasterTable {
  const storeRows: OperatingMasterRow[] = stores.map((store) => {
    const found = metrics.get(store.storeId)
    const values = Object.fromEntries(
      OPERATING_MASTER_METRIC_KEYS.map((key) => [key, found?.[key] ?? 0]),
    ) as OperatingMasterMetrics
    return {
      rowKey: store.storeId,
      kind: 'store',
      marketId: store.marketId,
      marketName: store.marketName,
      storeId: store.storeId,
      storeName: store.storeName,
      values,
    }
  })

  const marketIds = Array.from(new Set(storeRows.map((row) => row.marketId)))
  const multiMarket = marketIds.length > 1
  const totalsOf = (rows: readonly OperatingMasterRow[]) => computeMatrixTotals(METRIC_COLUMNS, rows, { paginated: false })

  const rows: OperatingMasterRow[] = []
  if (multiMarket) {
    for (const marketId of marketIds) {
      const marketRows = storeRows.filter((row) => row.marketId === marketId)
      rows.push(...marketRows, {
        rowKey: `subtotal:${marketId}`,
        kind: 'subtotal',
        marketId,
        marketName: marketRows[0].marketName,
        storeId: null,
        storeName: '小计',
        // 小计行只存可加列：比率列的 value 由这一行的分子分母现算（= 合计后重算），与表尾合计同一规则
        values: pickAdditive(totalsOf(marketRows)),
      })
    }
  } else {
    rows.push(...storeRows)
  }

  const totals = totalsOf(storeRows)
  return {
    rows,
    totals: Object.fromEntries(metricColumnKeys.map((key) => [key, totals[key] ?? null])),
    storeCount: storeRows.length,
    multiMarket,
  }
}

function pickAdditive(totals: MatrixTotals): Record<OperatingMasterMetricKey, number | null> {
  return Object.fromEntries(OPERATING_MASTER_METRIC_KEYS.map((key) => [key, totals[key] ?? null])) as Record<
    OperatingMasterMetricKey,
    number | null
  >
}

export function isOperatingMasterSubtotal(row: OperatingMasterRow): boolean {
  return row.kind === 'subtotal'
}

export function operatingMasterTotalsLabel(multiMarket: boolean): string {
  return multiMarket ? '总计' : '合计'
}

/**
 * 范围合法、却没有一家在营门店时（如所选市场下门店全部停用）表格的空行文案。
 * 「选中已停用门店」由 #293 在页面入口拦下（scope 置 null → ScopeEmptyState，不取数），走不到这里；
 * 在营门店本期无数据照常出行显示 0。
 */
export const OPERATING_MASTER_EMPTY_TEXT = '所选范围内没有在营门店，暂无数据'

/**
 * 导出参数：取页面**生效**的范围与月份（非法 URL 已回落），而不是原样转发地址栏——
 * 否则地址栏写了非法月份时，页面显示回落后的月份，导出却按 worker 的解析结果出另一个月。
 */
export function operatingMasterExportParams(scope: DataCenterScope, month: string): Record<string, string> {
  const params: Record<string, string> = { month }
  if (scope.type === 'authorized') params.scope = 'authorized'
  if (scope.type === 'market' || scope.type === 'store') {
    params.scope = scope.type
    params.scopeId = scope.id
  }
  return params
}

/**
 * 导出参数里的 scope：**fail-closed** 解析（与 URL 容错的 parseScope 刻意不同）。
 * 只有完全不带 scope 才解释为「全部」；声明了 market / store 却缺 scopeId、或未知 scope 值一律拒绝——
 * 否则总部账号会静默导出全集团，范围比请求的大、元信息也对不上。
 */
export function parseOperatingMasterExportScope(raw: { scope?: string; scopeId?: string }): DataCenterScope {
  if (!raw.scope) {
    if (raw.scopeId) throw new Error('INVALID_PARAMS: 导出范围缺少类型')
    return { type: 'all' }
  }
  if (raw.scope === 'authorized' && !raw.scopeId) return { type: 'authorized' }
  if ((raw.scope === 'market' || raw.scope === 'store') && raw.scopeId) return { type: raw.scope, id: raw.scopeId }
  throw new Error('INVALID_PARAMS: 导出范围参数不完整或无效')
}

/** 导出元信息的范围描述：带上范围类型（「市场 · 南昌凤御」「门店 · 汇东店」），同名时也能自证 */
export function operatingMasterScopeMeta(scope: DataCenterScope, name: string): string {
  if (scope.type === 'market') return `市场 · ${name}`
  if (scope.type === 'store') return `门店 · ${name}`
  return name
}

/**
 * 导出列：页面上 B–D 上方的空白表头因冻结边界拆成两个分组（见 BLANK_FROZEN_GROUP），
 * Excel 没有这个限制，按模板归一成一个分组 → 合并成一整块（模板 B2:D2）。
 */
export function operatingMasterExportGroup(column: OperatingMasterColumn): MatrixColumnGroup | undefined {
  return column.group?.key === BLANK_GROUP.key ? BLANK_FROZEN_GROUP : column.group
}

