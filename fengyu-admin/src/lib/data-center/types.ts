




export type DataCenterScope =
  | { type: 'all' }
  | { type: 'market'; id: string }
  | { type: 'store'; id: string }




export type TimeRangePreset = 'today' | 'week' | 'month' | 'year' | 'custom'

export type TimeRangeInput =
  | { preset: 'today' | 'week' | 'month' | 'year' }
  | { preset: 'custom'; start: string; end: string } 


export interface ResolvedRange {
  start: string
  end: string
}


export interface ResolvedTimeRange {
  current: ResolvedRange
  previous: ResolvedRange | null 
  lastYear: ResolvedRange | null 
  presetLabel: string 
}




export interface BoardParams {
  scope: DataCenterScope
  timeRange: TimeRangeInput
  
  withComparison?: boolean
}


export interface ProductBoardParams extends BoardParams {
  productKind?: string 
  categoryName?: string 
}




export type MetricUnit = 'amount' | 'count' | 'percent'


export interface KpiCell {
  value: number | null
  mom?: number | null 
  yoy?: number | null 
  unit: MetricUnit
}


export interface BreakdownRow {
  groupId: string 
  groupName: string 
  marketName?: string 
  metrics: Record<string, number | null> 
  labels?: Record<string, string> 
}


export interface RankingRow {
  rank: number
  id: string
  name: string
  marketName?: string
  value: number | null
}


export interface BoardMeta {
  scope: { type: DataCenterScope['type']; id: string | null; name: string }
  timeRange: { start: string; end: string; presetLabel: string }
}






export interface SalesBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}


export interface CustomerBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}


export interface EfficiencyBoardResult extends BoardMeta {
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  
  byStaff: BreakdownRow[]
  
  storeRankings: Record<string, RankingRow[]>
  
  staffRankings: Record<string, RankingRow[]>
}


export interface ProductBoardResult extends BoardMeta {
  
  filterOptions: Array<{ kind: string; categories: string[] }>
  selected: { productKind: string | null; categoryName: string | null }
  kpis: Record<string, KpiCell>
  byMarket: BreakdownRow[]
  byStore: BreakdownRow[]
}




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
  
  topLevel: 'all' | 'market' | 'store'
  markets: ScopeOptionMarket[]
}
