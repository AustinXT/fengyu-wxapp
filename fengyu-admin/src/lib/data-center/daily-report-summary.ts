export const DAILY_REPORT_METRICS = [
  { key: 'sales', label: '业绩', unit: 'amount' },
  { key: 'consumption', label: '消耗', unit: 'amount' },
  { key: 'visits', label: '客量', unit: 'count' },
  { key: 'newCustomers', label: '新客', unit: 'count' },
  { key: 'projects', label: '项目数', unit: 'count' },
] as const

export type DailyReportMetricKey = (typeof DAILY_REPORT_METRICS)[number]['key']
export type DailyReportMetricValues = Partial<Record<DailyReportMetricKey, number>>

export interface DailyReportMetricSnapshot {
  date: string
  day: DailyReportMetricValues | null
  week: DailyReportMetricValues | null
  month: DailyReportMetricValues | null
  periodName: string | null
  weekName: string | null
  savedAt: string | null
}

export interface DailyReportSummaryEntry {
  businessType: 'sale' | 'service'
  businessId: string
  snapshot: Record<string, unknown>
  feedback: string
  followUp: string
}

export interface DailyReportSummaryRow {
  id: string
  reportDate: string
  employeeId: string
  employeeName: string
  positionName: string
  storeId: string
  storeName: string
  marketId: string | null
  marketName: string | null
  submittedAt: string | null
  action: string
  growth: string
  plan: string
  mentorEmployeeId: string | null
  peerEmployeeId: string | null
  metrics: DailyReportMetricSnapshot | null
  entries: DailyReportSummaryEntry[]
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function metricValues(value: unknown): DailyReportMetricValues | null {
  const source = record(value)
  if (!source) return null
  const result: DailyReportMetricValues = {}
  for (const { key } of DAILY_REPORT_METRICS) {
    const raw = source[key]
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(parsed)) result[key] = parsed
  }
  return Object.keys(result).length > 0 ? result : null
}

/** Only expose the employee-level snapshot. Store and market aggregates in the JSON are deliberately omitted. */
export function employeeMetricSnapshot(value: unknown): DailyReportMetricSnapshot | null {
  const source = record(value)
  if (!source) return null
  const scopes = record(source.scopes)
  const personal = record(scopes?.personal)
  const legacyPersonal = source.scope === 'personal' ? source : null
  const selected = personal ?? legacyPersonal
  if (!selected) return null
  const actuals = record(selected.actuals)
  return {
    date: text(source.date) ?? '',
    day: metricValues(selected.day ?? actuals?.day),
    week: metricValues(selected.week ?? actuals?.week),
    month: metricValues(selected.month ?? actuals?.month),
    periodName: text(record(source.period)?.name),
    weekName: text(record(source.week)?.name),
    savedAt: text(source.savedAt),
  }
}

function safeSpreadsheetText(value: unknown): string {
  if (value == null) return ''
  const output = String(value)
  return /^[\s\u0000-\u001f]*[=+@-]/.test(output) ? `'${output}` : output
}

function snapshotText(entry: DailyReportSummaryEntry, key: string): string {
  return safeSpreadsheetText(entry.snapshot[key])
}

function metricValue(values: DailyReportMetricValues | null | undefined, key: DailyReportMetricKey): number | string {
  const value = values?.[key]
  if (value == null) return ''
  return key === 'sales' || key === 'consumption' ? value / 100 : value
}

/** Export rows are pure so spreadsheet shape and formula-injection protection can be tested without a browser. */
export function dailyReportSummaryExportRows(reports: readonly DailyReportSummaryRow[]) {
  const overview = reports.map((report) => ({
    日期: report.reportDate,
    区域: safeSpreadsheetText(report.marketName),
    门店: safeSpreadsheetText(report.storeName),
    员工: safeSpreadsheetText(report.employeeName),
    岗位: safeSpreadsheetText(report.positionName),
    提交时间: report.submittedAt ?? '',
    指导员: safeSpreadsheetText(report.mentorEmployeeId),
    同事: safeSpreadsheetText(report.peerEmployeeId),
    当日业绩: metricValue(report.metrics?.day, 'sales'),
    当日消耗: metricValue(report.metrics?.day, 'consumption'),
    当日客量: metricValue(report.metrics?.day, 'visits'),
    当日新客: metricValue(report.metrics?.day, 'newCustomers'),
    当日项目数: metricValue(report.metrics?.day, 'projects'),
    今日行动: safeSpreadsheetText(report.action),
    今日成长: safeSpreadsheetText(report.growth),
    明日计划: safeSpreadsheetText(report.plan),
  }))
  const business = reports.flatMap((report) => report.entries.map((entry) => ({
    日期: report.reportDate,
    区域: safeSpreadsheetText(report.marketName),
    门店: safeSpreadsheetText(report.storeName),
    员工: safeSpreadsheetText(report.employeeName),
    业务类型: entry.businessType === 'service' ? '服务' : '销售',
    业务日期: snapshotText(entry, 'businessDate'),
    顾客及业务: snapshotText(entry, 'title'),
    业务编号: safeSpreadsheetText(entry.businessId),
    反馈: safeSpreadsheetText(entry.feedback),
    后续跟进: safeSpreadsheetText(entry.followUp),
  })))
  return { overview, business }
}
