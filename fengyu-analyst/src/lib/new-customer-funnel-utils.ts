export type NewCustomerUnitLevel = "market" | "store"
export type NewCustomerTableMode = "months" | "units"
export type NewCustomerServiceBucket = "t30" | "t60" | "t90"
export type NewCustomerFunnelListType = "all" | "arrived" | "not_arrived" | "member"

export const TRANSFER_SOURCE = "转让店"
export const EMPTY_SOURCE = "未填写"

export const NEW_CUSTOMER_SOURCE_LABELS = [
  "美团",
  "抖音",
  "小程序",
  "推带新",
  "地推卡",
  "拓客卡",
  "老带新",
  TRANSFER_SOURCE,
  "自进店",
  "内部员工或家属",
  EMPTY_SOURCE,
]

export interface NewCustomerFunnelFilters {
  startMonth?: string
  endMonth?: string
  unitLevel?: NewCustomerUnitLevel
  tableMode?: NewCustomerTableMode
  source?: string
}

export interface RequiredNewCustomerFunnelFilters {
  startMonth: string
  endMonth: string
  unitLevel: NewCustomerUnitLevel
  tableMode: NewCustomerTableMode
  source: string
}

export interface NewCustomerFunnelEntry {
  customerId: string
  customerCode: string
  customerName: string
  source: string
  month: string
  entryDate: string
  market: string
  store: string
  firstServiceDate: string | null
  serviceBucket: NewCustomerServiceBucket | null
  becameMemberAt: string | null
  firstMembershipAmount: number
  annualContributionAmount: number
}

export interface NewCustomerFunnelKpi {
  newCustomerCount: number
  serviceT30Count: number
  serviceT60Count: number
  serviceT90Count: number
  arrivedCount: number
  arrivalRate: number
  memberCustomerCount: number
  memberConversionRate: number
  firstMembershipAmount: number
  firstMembershipAverage: number
  annualContributionAmount: number
  annualContributionAverage: number
}

export interface NewCustomerFunnelComparisonRow extends NewCustomerFunnelKpi {
  id: string
  name: string
  month?: string
  market?: string
  store?: string
  source?: string
}

const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

export function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? round4(numerator / denominator) : 0
}

export function safeAverage(numerator: number, denominator: number): number {
  return denominator > 0 ? round2(numerator / denominator) : 0
}

export function normalizeMonth(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text && MONTH_RE.test(text) ? text : undefined
}

export function currentShanghaiMonth(): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === "year")?.value ?? String(new Date().getFullYear())
  const month = parts.find((part) => part.type === "month")?.value ?? String(new Date().getMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

export function monthIndex(month: string): number {
  const [year, monthOfYear] = month.split("-").map(Number)
  return year * 12 + monthOfYear - 1
}

export function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}-${String(month).padStart(2, "0")}`
}

export function shiftMonth(month: string, offset: number): string {
  return monthFromIndex(monthIndex(month) + offset)
}

export function normalizeMonthRange(startMonth: string | undefined, endMonth: string | undefined): {
  startMonth: string
  endMonth: string
} {
  const fallbackEnd = currentShanghaiMonth()
  const end = normalizeMonth(endMonth) ?? fallbackEnd
  const start = normalizeMonth(startMonth) ?? `${end.slice(0, 4)}-01`
  if (monthIndex(start) > monthIndex(end)) return { startMonth: end, endMonth: start }
  return { startMonth: start, endMonth: end }
}

export function previousYearRange(filters: RequiredNewCustomerFunnelFilters): {
  startMonth: string
  endMonth: string
} {
  return {
    startMonth: shiftMonth(filters.startMonth, -12),
    endMonth: shiftMonth(filters.endMonth, -12),
  }
}

export function previousPeriodRange(filters: RequiredNewCustomerFunnelFilters): {
  startMonth: string
  endMonth: string
} {
  const start = monthIndex(filters.startMonth)
  const end = monthIndex(filters.endMonth)
  const length = Math.max(1, end - start + 1)
  const previousEnd = start - 1
  return {
    startMonth: monthFromIndex(previousEnd - length + 1),
    endMonth: monthFromIndex(previousEnd),
  }
}

function parseDateOnly(value: string): number {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (
    Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) ||
    month < 1 || month > 12 ||
    day < 1 || day > 31
  ) {
    return NaN
  }
  return Date.UTC(year, month - 1, day)
}

export function resolveServiceBucket(
  entryDate: string,
  serviceDate: string | null,
): NewCustomerServiceBucket | null {
  if (!serviceDate) return null
  const days = Math.round((parseDateOnly(serviceDate) - parseDateOnly(entryDate)) / MS_PER_DAY)
  if (Number.isNaN(days) || days < 0 || days > 90) return null
  if (days <= 30) return "t30"
  if (days <= 60) return "t60"
  return "t90"
}

export function aggregateFunnelKpi(entries: NewCustomerFunnelEntry[]): NewCustomerFunnelKpi {
  const newCustomerCount = entries.length
  const serviceT30Count = entries.filter((row) => row.serviceBucket === "t30").length
  const serviceT60Count = entries.filter((row) => row.serviceBucket === "t60").length
  const serviceT90Count = entries.filter((row) => row.serviceBucket === "t90").length
  const arrivedCount = serviceT30Count + serviceT60Count + serviceT90Count
  const memberRows = entries.filter((row) => row.serviceBucket && row.becameMemberAt)
  const memberCustomerCount = memberRows.length
  const firstMembershipAmount = round2(memberRows.reduce((sum, row) => sum + row.firstMembershipAmount, 0))
  const annualContributionAmount = round2(memberRows.reduce((sum, row) => sum + row.annualContributionAmount, 0))

  return {
    newCustomerCount,
    serviceT30Count,
    serviceT60Count,
    serviceT90Count,
    arrivedCount,
    arrivalRate: safeRate(arrivedCount, newCustomerCount),
    memberCustomerCount,
    memberConversionRate: safeRate(memberCustomerCount, arrivedCount),
    firstMembershipAmount,
    firstMembershipAverage: safeAverage(firstMembershipAmount, memberCustomerCount),
    annualContributionAmount,
    annualContributionAverage: safeAverage(annualContributionAmount, memberCustomerCount),
  }
}

export function filterNewCustomerFunnelListEntries(
  entries: NewCustomerFunnelEntry[],
  listType: NewCustomerFunnelListType,
): NewCustomerFunnelEntry[] {
  if (listType === "arrived") return entries.filter((row) => Boolean(row.serviceBucket))
  if (listType === "not_arrived") return entries.filter((row) => !row.serviceBucket)
  if (listType === "member") return entries.filter((row) => Boolean(row.serviceBucket && row.becameMemberAt))
  return entries
}

export function aggregateFunnelRows(
  entries: NewCustomerFunnelEntry[],
  getKey: (entry: NewCustomerFunnelEntry) => string,
  extra?: (entry: NewCustomerFunnelEntry) => Partial<NewCustomerFunnelComparisonRow>,
): NewCustomerFunnelComparisonRow[] {
  const groups = new Map<string, NewCustomerFunnelEntry[]>()
  for (const entry of entries) {
    const key = getKey(entry)
    if (!key) continue
    const rows = groups.get(key) ?? []
    rows.push(entry)
    groups.set(key, rows)
  }

  return Array.from(groups.entries()).map(([key, rows]) => {
    const first = rows[0]
    return {
      id: key,
      name: key,
      ...aggregateFunnelKpi(rows),
      ...extra?.(first),
    }
  })
}

export function aggregateFunnelBySource(entries: NewCustomerFunnelEntry[]): NewCustomerFunnelComparisonRow[] {
  const rows = aggregateFunnelRows(entries, (entry) => entry.source, (entry) => ({ source: entry.source }))
  const map = new Map(rows.map((row) => [row.name, row]))
  return NEW_CUSTOMER_SOURCE_LABELS.map(
    (source) =>
      map.get(source) ?? {
        id: source,
        name: source,
        source,
        ...aggregateFunnelKpi([]),
      },
  )
}
