/**
 * 数据中心明细表与导出列的唯一配置来源。
 *
 * 本文件不依赖 Server Action 或 Node API，页面和异步导出 worker 都可以安全引用。
 */
import type { DataCenterExportView } from '@/lib/export-job-types'
import { SALES_CATEGORIES, SALES_CATEGORY_COLUMN_KEYS } from '@/lib/sales-categories'
import type { MetricUnit } from './types'

export interface DataCenterMetricColumn {
  key: string
  label: string
  unit: MetricUnit
}

export interface DataCenterBreakdownTextColumn {
  key: string
  label: string
  source: 'marketName' | 'labels'
}

export interface DataCenterBreakdownConfig {
  kind: 'breakdown'
  groupLabel: string
  textColumns: readonly DataCenterBreakdownTextColumn[]
  metricColumns: readonly DataCenterMetricColumn[]
}

export interface DataCenterRankingConfig {
  kind: 'ranking'
  metrics: readonly DataCenterMetricColumn[]
}

export type DataCenterViewConfig = DataCenterBreakdownConfig | DataCenterRankingConfig

const marketTextColumns = [] as const satisfies readonly DataCenterBreakdownTextColumn[]

const storeTextColumns = [
  { key: 'marketName', label: '所属市场', source: 'marketName' },
] as const satisfies readonly DataCenterBreakdownTextColumn[]

const staffTextColumns = [
  { key: 'store', label: '门店', source: 'labels' },
  { key: 'position', label: '职级', source: 'labels' },
] as const satisfies readonly DataCenterBreakdownTextColumn[]

/**
 * 「按技师人效」的 sales_category 四分类销售额列，由单源生成 —— 枚举加值时
 * `SALES_CATEGORY_COLUMN_KEYS` 会先在 tsc 报缺键，不会静默少一列。
 *
 * ⚠️ 本组列口径是 `spia.allocated_amount`（营业额份额），取数见
 *    `actions/data-center/efficiency.ts` 的 `revenue_by_emp_cat` CTE；
 *    与 staff 绩效页同名 4 格的 `commission_amount`（提成）差一个费率量级，勿对齐。
 */
const salesCategoryMetricColumns: readonly DataCenterMetricColumn[] = SALES_CATEGORIES.map(
  (label) => ({ key: SALES_CATEGORY_COLUMN_KEYS[label], label, unit: 'amount' }),
)

const customerRegistrationMetricColumns = [
  { key: 'registered', label: '会员注册', unit: 'count' },
  { key: 'retained', label: '保有会员', unit: 'count' },
  { key: 'visitOnce', label: '回店1次', unit: 'count' },
  { key: 'visitOnceRate', label: '1次达成率', unit: 'percent' },
  { key: 'visitTwice', label: '回店2次', unit: 'count' },
  { key: 'visitTwiceRate', label: '2次达成率', unit: 'percent' },
  { key: 'dormant', label: '沉睡', unit: 'count' },
  { key: 'reactivatedDormant', label: '激活沉睡', unit: 'count' },
  { key: 'frozen', label: '冰冻', unit: 'count' },
  { key: 'reactivatedFrozen', label: '激活冰冻', unit: 'count' },
  { key: 'deep', label: '休眠', unit: 'count' },
  { key: 'reactivatedDeep', label: '激活休眠', unit: 'count' },
] as const satisfies readonly DataCenterMetricColumn[]

const customerOperationMetricColumns = [
  { key: 'bucketD', label: '<1990', unit: 'count' },
  { key: 'bucketC', label: '≥1990', unit: 'count' },
  { key: 'bucketB', label: '≥1万', unit: 'count' },
  { key: 'bucketA', label: '≥3万', unit: 'count' },
  { key: 'bucketV', label: '≥6万', unit: 'count' },
  { key: 'bucketVIC', label: '≥10万', unit: 'count' },
  { key: 'operatedTotal', label: '被经营总数', unit: 'count' },
  { key: 'newMembers', label: '会员新增', unit: 'count' },
  { key: 'trafficCustomers', label: '流量客', unit: 'count' },
  { key: 'convRate', label: '成交率', unit: 'percent' },
  { key: 'memberAvgTicket', label: '会员客单', unit: 'amount' },
  { key: 'newCustomerAvgTicket', label: '新客客单', unit: 'amount' },
  { key: 'trafficVisits', label: '流量人次', unit: 'count' },
  { key: 'memberVisits', label: '会员人次', unit: 'count' },
  { key: 'projectCount', label: '项目数', unit: 'count' },
  { key: 'consumePerVisit', label: '单次客耗', unit: 'amount' },
] as const satisfies readonly DataCenterMetricColumn[]

const productMetricColumns = [
  { key: 'cardHolders', label: '持卡人数', unit: 'count' },
  { key: 'cardHolderRate', label: '持卡占比', unit: 'percent' },
  { key: 'trialCount', label: '体验人数', unit: 'count' },
  { key: 'newCount', label: '新增人数', unit: 'count' },
  { key: 'newRevenue', label: '新增业绩', unit: 'amount' },
  { key: 'newAvgTicket', label: '新增客单价', unit: 'amount' },
  { key: 'repurchaseCount', label: '复购人数', unit: 'count' },
  { key: 'repurchaseRevenue', label: '复购业绩', unit: 'amount' },
  { key: 'repurchaseRate', label: '复购率', unit: 'percent' },
] as const satisfies readonly DataCenterMetricColumn[]

export const DATA_CENTER_VIEW_CONFIG = {
  'sales-market': {
    kind: 'breakdown',
    groupLabel: '市场',
    textColumns: marketTextColumns,
    metricColumns: [
      { key: 'storeCount', label: '门店数', unit: 'count' },
      { key: 'technicianCount', label: '技师人数', unit: 'count' },
      { key: 'storeRevenue', label: '总业绩', unit: 'amount' },
      { key: 'shengmeiRevenue', label: '生美业绩', unit: 'amount' },
      { key: 'revenuePerStore', label: '业绩店均', unit: 'amount' },
      { key: 'shengmeiRevenuePerStore', label: '生美店均', unit: 'amount' },
      { key: 'newCustomerRevenue', label: '新增客业绩', unit: 'amount' },
      { key: 'trafficCustomerRevenue', label: '流量客业绩', unit: 'amount' },
      { key: 'storeConsume', label: '总实耗', unit: 'amount' },
      { key: 'shengmeiConsume', label: '生美实耗', unit: 'amount' },
      { key: 'consumePerStore', label: '实耗店均', unit: 'amount' },
      { key: 'shengmeiConsumePerStore', label: '生美实耗店均', unit: 'amount' },
    ],
  },
  'sales-store': {
    kind: 'breakdown',
    groupLabel: '门店',
    textColumns: storeTextColumns,
    metricColumns: [
      { key: 'technicianCount', label: '技师人数', unit: 'count' },
      { key: 'storeRevenue', label: '总业绩', unit: 'amount' },
      { key: 'shengmeiRevenue', label: '生美业绩', unit: 'amount' },
      { key: 'newCustomerRevenue', label: '新增客业绩', unit: 'amount' },
      { key: 'trafficCustomerRevenue', label: '流量客业绩', unit: 'amount' },
      { key: 'storeConsume', label: '总实耗', unit: 'amount' },
      { key: 'shengmeiConsume', label: '生美实耗', unit: 'amount' },
    ],
  },
  'customer-market-reg': {
    kind: 'breakdown',
    groupLabel: '市场',
    textColumns: marketTextColumns,
    metricColumns: customerRegistrationMetricColumns,
  },
  'customer-market-ops': {
    kind: 'breakdown',
    groupLabel: '市场',
    textColumns: marketTextColumns,
    metricColumns: customerOperationMetricColumns,
  },
  'customer-store-reg': {
    kind: 'breakdown',
    groupLabel: '门店',
    textColumns: storeTextColumns,
    metricColumns: customerRegistrationMetricColumns,
  },
  'customer-store-ops': {
    kind: 'breakdown',
    groupLabel: '门店',
    textColumns: storeTextColumns,
    metricColumns: customerOperationMetricColumns,
  },
  'product-market': {
    kind: 'breakdown',
    groupLabel: '市场',
    textColumns: marketTextColumns,
    metricColumns: productMetricColumns,
  },
  'product-store': {
    kind: 'breakdown',
    groupLabel: '门店',
    textColumns: storeTextColumns,
    metricColumns: productMetricColumns,
  },
  'efficiency-market': {
    kind: 'breakdown',
    groupLabel: '市场',
    textColumns: marketTextColumns,
    metricColumns: [
      { key: 'managerCount', label: '店长人数', unit: 'count' },
      { key: 'managerAvgIncome', label: '店长人均收入', unit: 'amount' },
      { key: 'technicianCount', label: '技师人数', unit: 'count' },
      { key: 'techAvgRevenue', label: '技师人均业绩', unit: 'amount' },
      { key: 'techAvgConsume', label: '技师人均实耗', unit: 'amount' },
      { key: 'techAvgShengmeiConsume', label: '技师人均生美实耗', unit: 'amount' },
      { key: 'techAvgIncome', label: '技师人均收入', unit: 'amount' },
      { key: 'techAvgMembers', label: '技师人均会员量', unit: 'count' },
      { key: 'techAvgProjects', label: '技师人均项目数', unit: 'count' },
    ],
  },
  'efficiency-staff': {
    kind: 'breakdown',
    groupLabel: '姓名',
    textColumns: staffTextColumns,
    metricColumns: [
      { key: 'revenue', label: '当月业绩', unit: 'amount' },
      ...salesCategoryMetricColumns,
      { key: 'consumeTotal', label: '实耗合计', unit: 'amount' },
      { key: 'newMember', label: '纳客数', unit: 'count' },
      { key: 'projectCount', label: '项目数', unit: 'count' },
      { key: 'serviceHeadcount', label: '服务人头', unit: 'count' },
      { key: 'serviceVisits', label: '服务人次', unit: 'count' },
    ],
  },
  'efficiency-store-ranking': {
    kind: 'ranking',
    metrics: [
      { key: 'revenue', label: '业绩', unit: 'amount' },
      { key: 'consume', label: '实耗', unit: 'amount' },
      { key: 'retainedMember', label: '保有会员', unit: 'count' },
      { key: 'newMember', label: '新会员', unit: 'count' },
      { key: 'projectCount', label: '项目数', unit: 'count' },
    ],
  },
  'efficiency-staff-ranking': {
    kind: 'ranking',
    metrics: [
      { key: 'revenue', label: '业绩', unit: 'amount' },
      { key: 'consume', label: '实耗', unit: 'amount' },
      { key: 'newMember', label: '新会员', unit: 'count' },
      { key: 'projectCount', label: '项目数', unit: 'count' },
      { key: 'income', label: '收入', unit: 'amount' },
    ],
  },
} as const satisfies Record<DataCenterExportView, DataCenterViewConfig>

export type DataCenterBreakdownView = {
  [View in DataCenterExportView]: (typeof DATA_CENTER_VIEW_CONFIG)[View]['kind'] extends 'breakdown'
    ? View
    : never
}[DataCenterExportView]

export type DataCenterRankingView = {
  [View in DataCenterExportView]: (typeof DATA_CENTER_VIEW_CONFIG)[View]['kind'] extends 'ranking'
    ? View
    : never
}[DataCenterExportView]

export function getDataCenterBreakdownConfig(view: DataCenterExportView): DataCenterBreakdownConfig {
  const config = DATA_CENTER_VIEW_CONFIG[view]
  if (config.kind !== 'breakdown') {
    throw new Error(`INVALID_PARAMS: ${view} 不是明细导出视图`)
  }
  return config
}

export function getDataCenterRankingConfig(view: DataCenterExportView): DataCenterRankingConfig {
  const config = DATA_CENTER_VIEW_CONFIG[view]
  if (config.kind !== 'ranking') {
    throw new Error(`INVALID_PARAMS: ${view} 不是排名导出视图`)
  }
  return config
}
