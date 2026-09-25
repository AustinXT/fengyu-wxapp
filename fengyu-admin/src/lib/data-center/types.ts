/**
 * 数据中心看板 — 全板块共享类型契约（★契约根，地基冻结后只读）
 *
 * 4 个板块（销售/客量/人效/品项）的 action 入参与返回结构统一在此定义。
 * 板块特有的「指标 key / 列名」一律走 Record<string, ...> 松散键，
 * 板块 agent 可自由增减键而无需回写本文件（保持契约稳定、零文件冲突）。
 *
 * 口径权威：notes/references/metrics.md。
 */
import type { DeltaDisplay } from '@/lib/delta-display'

export type { DeltaDisplay }

// ─────────────────────────────────────────────
// scope（集团/授权汇总/市场/门店）
// ─────────────────────────────────────────────
export type DataCenterScope =
  | { type: 'all' }
  | { type: 'authorized' }
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
  // 环比：上一周期的**日历同期**（不是完整的上一周/上一月）。长度关系与两条日历例外
  // （month clamp / year 跨闰年）见 time-range.ts 头注释与 metrics.md §数据中心板块专属指标
  previous: ResolvedRange | null
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

/**
 * KPI 卡片单元（带同比/环比）。`value=null` → 前端显示 '--'。
 *
 * `mom`/`yoy` 自 #310/#315 起是**判别联合**而非裸数值：决策 1 要把「算不出」的三种成因
 * （负基期已转正 / 负基期未转正 / 零基期）分别展示，裸 `number | null` 表达不了。
 * 构造一律走 `resolveDeltaDisplay`，别手写字面量。
 */
export interface KpiCell {
  value: number | null
  mom?: DeltaDisplay // 环比
  yoy?: DeltaDisplay // 同比
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
  /**
   * `previous`/`lastYear` 自 #310 起随当期一并下发——此前它们从不出仓，
   * 前端**物理上拿不到基期区间**，于是「本月」与「自定义同起止日」给出两个不同的环比值
   * （实测 +30.76% vs +46.39%，差 15.63pp）时，用户得不到任何解释线索。
   *
   * 这是**正确的语义差异**（「本月」比上月同期、「自定义」比紧邻前一等长区间），
   * 不是 bug，但必须让用户能看见分母才说得清。`month` 分支在上月天数不足时还会 clamp
   * （3/31 看本月 → 基期 2/1~2/28，短 3 天），同样只有露出区间才能自行判断。
   *
   * `null` = 该基期不存在（如 `withComparison: false` 的明细表），前端不渲染 hover。
   */
  timeRange: {
    start: string
    end: string
    presetLabel: string
    previous: { start: string; end: string } | null
    lastYear: { start: string; end: string } | null
  }
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
  /** 按技师人效明细（员工粒度，labels 带门店/职级；metrics = 当月业绩 + 销售额按
   *  salesCategoryEnum 4 枚举值拆分 + 实耗合计 + 纳客数/项目数/服务人头/服务人次） */
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
  /**
   * 账号角色范围直接覆盖该市场（总部全开恒 true）；门店级账号补进来的祖先市场为 false（#399）。
   * 只影响「无在营门店的市场」能否作为默认范围 / 计入可切换范围，缺省视为 false。
   */
  granted?: boolean
}
/**
 * 账号权限内、组织节点已停用的门店：不进下拉，仅用于识别 URL 里的停用门店（#293）。
 * 判定与取数 SQL 的启用门店过滤同源（只看 org_nodes.is_active），这样「已停用」必然等于「取不到数」。
 */
export interface ScopeOptionInactiveStore extends ScopeOptionStore {
  /** 所属市场节点；筛选器据此回显市场下拉（市场不在数据源时回显落空，不影响空态） */
  marketId: string | null
}
export interface DataCenterScopeOptions {
  /** 当前账号的最高授权层级：store 也可能由多条门店角色组成多店范围。 */
  topLevel: 'all' | 'market' | 'store'
  markets: ScopeOptionMarket[]
  /**
   * 权限内已停用的门店（#293）。URL 指向其中一家时页面渲染「该门店已停用」空态，
   * 而不是满屏 0（在营门店本期无业绩才显示 0，两者必须可区分）。
   */
  inactiveStores: ScopeOptionInactiveStore[]
}
