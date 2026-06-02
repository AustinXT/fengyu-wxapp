/**
 * 数据中心看板 — 全板块共享类型契约（★契约根，地基冻结后只读）
 *
 * 4 个板块（销售/客量/人效/品项）的 action 入参与返回结构统一在此定义。
 * 板块特有的「指标 key / 列名」一律走 Record<string, ...> 松散键，
 * 板块 agent 可自由增减键而无需回写本文件（保持契约稳定、零文件冲突）。
 *
 * 口径权威：notes/references/metrics.md。
 */

// ─────────────────────────────────────────────
// scope（集团/市场/门店三级）
// ─────────────────────────────────────────────
export type DataCenterScope =
  | { type: 'all' }
  | { type: 'market'; id: string }
  | { type: 'store'; id: string }

// ─────────────────────────────────────────────
// 时间维度
// ─────────────────────────────────────────────
export type TimeRangePreset = 'today' | 'week' | 'month' | 'year' | 'custom'

export type TimeRangeInput =
  | { preset: 'today' | 'week' | 'month' | 'year' }
  | { preset: 'custom'; start: string; end: string } // YYYY-MM-DD

/** 解析后的单个日期区间（闭区间，YYYY-MM-DD） */
export interface ResolvedRange {
  start: string
  end: string
}

/** resolveTimeRange 的输出：本期 + 上期(环比) + 去年同期(同比) */
export interface ResolvedTimeRange {
  current: ResolvedRange
  previous: ResolvedRange | null // 环比：上一个等长周期
  lastYear: ResolvedRange | null // 同比：去年同期
  presetLabel: string // '今日' / '本周' / '本月' / '今年' / 'YYYY-MM-DD ~ YYYY-MM-DD'
}

// ─────────────────────────────────────────────
// action 入参
// ─────────────────────────────────────────────
export interface BoardParams {
  scope: DataCenterScope
  timeRange: TimeRangeInput
  /** 是否计算同比/环比（默认 true；明细表/排名榜内部强制 false） */
  withComparison?: boolean
}

/** 品项板块额外的一级/二级筛选 */
export interface ProductBoardParams extends BoardParams {
  productKind?: string // 一级品项（product_categories.product_kind）
  categoryName?: string // 二级品项（product_categories.category_name）
}

// ─────────────────────────────────────────────
// 展示原语
// ─────────────────────────────────────────────
export type MetricUnit = 'amount' | 'count' | 'percent'

/** KPI 卡片单元（带同比/环比）。value=null 或 delta=null → 前端显示 '--' */
export interface KpiCell {
  value: number | null
  mom?: number | null // 环比 delta%（小数，0.12 = +12%）
  yoy?: number | null // 同比 delta%
  unit: MetricUnit
}

/** 按市场/按门店明细表的一行 */
export interface BreakdownRow {
  groupId: string // marketId 或 storeId
  groupName: string // 市场名 / 门店名
  marketName?: string // 按门店分组时带出所属市场
  metrics: Record<string, number | null> // 列名 → 值
  labels?: Record<string, string> // 额外文本维度（如按技师明细的门店/职级），非数值列
}

/** 排名榜一行 */
export interface RankingRow {
  rank: number
  id: string
  name: string
  marketName?: string
  value: number | null
}

/** 各板块返回的公共信封 */
export interface BoardMeta {
  scope: { type: DataCenterScope['type']; id: string | null; name: string }
  timeRange: { start: string; end: string; presetLabel: string }
}

// ─────────────────────────────────────────────
// 4 个板块的 BoardResult（外壳冻结，内部 key 松散）
// ─────────────────────────────────────────────

/** 销售板块 */
export interface SalesBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}

/** 客量板块 */
export interface CustomerBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}

/** 人效板块 */
export interface EfficiencyBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  /** 按技师人效明细（员工粒度，labels 带门店/职级，metrics 为 13 个销/耗/客流指标列） */
  byStaff: BreakdownRow[]
  /** metric → 排名行（门店排名榜，metric: revenue/consume/retainedMember/newMember/projectCount） */
  storeRankings: Record<string, RankingRow[]>
  /** metric → 排名行（员工排名榜，metric: revenue/consume/newMember/projectCount/income） */
  staffRankings: Record<string, RankingRow[]>
}

/** 品项板块 */
export interface ProductBoardResult extends BoardMeta {
  /** 筛选器数据源：一级品项 + 其下二级品项名 */
  filterOptions: Array<{ kind: string; categories: string[] }>
  selected: { productKind: string | null; categoryName: string | null }
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}

// ─────────────────────────────────────────────
// 筛选器数据源（scope 三级级联）
// ─────────────────────────────────────────────
export interface ScopeOptionStore {
  storeId: string
  storeName: string
}
export interface ScopeOptionMarket {
  id: string
  name: string
  stores: ScopeOptionStore[]
}
export interface DataCenterScopeOptions {
  /** 当前账号能选的最高层级：all=可选全部 / market=只能选自己市场起 / store=只能本店 */
  topLevel: 'all' | 'market' | 'store'
  markets: ScopeOptionMarket[]
}
