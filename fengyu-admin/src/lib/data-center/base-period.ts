/** 页面徽章、起点提示和导出说明共用基期叫法（#296）。 */
export const MOM_BASE_PERIOD_LABEL = '环比基期'
export const YOY_BASE_PERIOD_LABEL = '同比基期'

export function basePeriodLabel(label: string): string {
  return label === '同比' ? YOY_BASE_PERIOD_LABEL : MOM_BASE_PERIOD_LABEL
}

/**
 * 基期区间 → hover 文案，如「环比基期：2026-08-01 ~ 2026-08-22（22 天）」。
 *
 * ⚠️ 天数算不出时只报区间、不报天数，不把「（NaN 天）」摆给用户。根因（`?start=0001-01-01` 这类
 * 手改 URL 让 `addDays` 产出 `"0-12-31"`）已由 #308 在 URL 层与服务端两道校验挡住
 * （`@/lib/calendar-date` 把年份卡在 1900–2100）；这里保留作兜底。
 */
export function basePeriodTitle(label: string, range: { start: string; end: string } | null): string | undefined {
  if (!range) return undefined
  // 含首尾两端，所以 +1；start/end 应是 'YYYY-MM-DD' 纯日期串，用 UTC 解析避免本地时区偏移。
  const span = Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)
  const days = Math.round(span / 86400000) + 1
  if (!Number.isFinite(days) || days <= 0) return `${basePeriodLabel(label)}：${range.start} ~ ${range.end}`
  return `${basePeriodLabel(label)}：${range.start} ~ ${range.end}（${days} 天）`
}

