import "server-only"

import { sql, type SQL } from "drizzle-orm"
import { db } from "@/db"
import { isAdminScope } from "@/lib/permissions"
import type { AuthSession } from "@/lib/types"
import {
  EMPTY_SOURCE,
  NEW_CUSTOMER_SOURCE_LABELS,
  TRANSFER_SOURCE,
  aggregateFunnelBySource,
  aggregateFunnelKpi,
  aggregateFunnelRows,
  filterNewCustomerFunnelListEntries,
  normalizeMonth,
  normalizeMonthRange,
  previousPeriodRange,
  previousYearRange,
  resolveServiceBucket,
  round2,
  type NewCustomerFunnelComparisonRow,
  type NewCustomerFunnelEntry,
  type NewCustomerFunnelFilters,
  type NewCustomerFunnelKpi,
  type NewCustomerFunnelListType,
  type NewCustomerTableMode,
  type NewCustomerUnitLevel,
  type RequiredNewCustomerFunnelFilters,
} from "@/lib/new-customer-funnel-utils"

const NEW_CUSTOMER_CACHE_TTL = 10 * 60 * 1000

export type {
  NewCustomerFunnelComparisonRow,
  NewCustomerFunnelEntry,
  NewCustomerFunnelFilters,
  NewCustomerFunnelKpi,
  NewCustomerFunnelListType,
  NewCustomerTableMode,
  NewCustomerUnitLevel,
  RequiredNewCustomerFunnelFilters,
}

export interface NewCustomerFunnelFilterOptions {
  months: string[]
  sources: string[]
  markets: string[]
  stores: string[]
}

export interface NewCustomerFunnelDashboardData {
  filters: RequiredNewCustomerFunnelFilters
  kpi: NewCustomerFunnelKpi
  prevYearKpi: NewCustomerFunnelKpi
  prevPeriodKpi: NewCustomerFunnelKpi
  sourceBreakdown: NewCustomerFunnelComparisonRow[]
  comparisonRows: NewCustomerFunnelComparisonRow[]
  funnelRows: Array<{ name: string; value: number }>
}

interface RawFunnelEntryRow {
  [key: string]: unknown
  customerId: unknown
  customerCode: unknown
  customerName: unknown
  source: unknown
  month: unknown
  entryDate: unknown
  market: unknown
  store: unknown
  firstServiceDate: unknown
  becameMemberAt: unknown
  firstMembershipAmount: unknown
  annualContributionAmount: unknown
}

const entryCache = new Map<string, { expiresAt: number; rows: NewCustomerFunnelEntry[] }>()

function cleanText(value: unknown): string {
  return String(value ?? "").trim()
}

function normalizeNumber(value: unknown): number {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return cleanText(value).slice(0, 10)
}

function normalizeDateTime(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const text = cleanText(value)
  return text ? text : null
}

function normalizeFilterText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function normalizeUnitLevel(value: string | undefined): NewCustomerUnitLevel {
  return value === "store" ? "store" : "market"
}

function normalizeTableMode(value: string | undefined, startMonth: string, endMonth: string): NewCustomerTableMode {
  if (value === "months" || value === "units") return value
  return startMonth === endMonth ? "units" : "months"
}

export function normalizeNewCustomerFunnelFilters(input: {
  startMonth?: string | string[]
  endMonth?: string | string[]
  unitLevel?: string | string[]
  tableMode?: string | string[]
  source?: string | string[]
  market?: string | string[]
  store?: string | string[]
}): RequiredNewCustomerFunnelFilters {
  const rawStartMonth = Array.isArray(input.startMonth) ? input.startMonth[0] : input.startMonth
  const rawEndMonth = Array.isArray(input.endMonth) ? input.endMonth[0] : input.endMonth
  const { startMonth, endMonth } = normalizeMonthRange(rawStartMonth, rawEndMonth)
  const unitLevel = normalizeUnitLevel(Array.isArray(input.unitLevel) ? input.unitLevel[0] : input.unitLevel)
  const tableMode = normalizeTableMode(Array.isArray(input.tableMode) ? input.tableMode[0] : input.tableMode, startMonth, endMonth)
  const source = normalizeFilterText(Array.isArray(input.source) ? input.source[0] : input.source)
  const market = normalizeFilterText(Array.isArray(input.market) ? input.market[0] : input.market)
  const store = normalizeFilterText(Array.isArray(input.store) ? input.store[0] : input.store)

  return {
    startMonth,
    endMonth,
    unitLevel,
    tableMode,
    source: source ?? "",
    market: market ?? "",
    store: store ?? "",
  }
}

function scopeCacheKey(session: AuthSession): string {
  if (isAdminScope(session)) return "admin"
  const ids = [...session.permissions.scopeStoreIds].sort()
  return ids.length > 0 ? ids.join(",") : "__none__"
}

function storeScopeCondition(session: AuthSession, storeExpr: SQL): SQL {
  if (isAdminScope(session)) return sql`TRUE`
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) return sql`FALSE`
  return sql`${storeExpr} = ANY(${ids}::text[])`
}

function mapEntryRows(rows: unknown): NewCustomerFunnelEntry[] {
  return (rows as RawFunnelEntryRow[]).map((row) => {
    const entryDate = normalizeDate(row.entryDate)
    const firstServiceDate = row.firstServiceDate ? normalizeDate(row.firstServiceDate) : null
    return {
      customerId: cleanText(row.customerId),
      customerCode: cleanText(row.customerCode) || cleanText(row.customerId),
      customerName: cleanText(row.customerName) || cleanText(row.customerCode) || cleanText(row.customerId),
      source: cleanText(row.source) || EMPTY_SOURCE,
      month: cleanText(row.month),
      entryDate,
      market: cleanText(row.market) || "未归属市场",
      store: cleanText(row.store) || "未绑定门店",
      firstServiceDate,
      serviceBucket: resolveServiceBucket(entryDate, firstServiceDate),
      becameMemberAt: normalizeDateTime(row.becameMemberAt),
      firstMembershipAmount: round2(normalizeNumber(row.firstMembershipAmount)),
      annualContributionAmount: round2(normalizeNumber(row.annualContributionAmount)),
    }
  })
}

async function queryFunnelEntries(session: AuthSession): Promise<NewCustomerFunnelEntry[]> {
  const key = scopeCacheKey(session)
  const cached = entryCache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.rows

  const firstOrderScope = storeScopeCondition(session, sql`so.store_id`)
  const transferScope = storeScopeCondition(session, sql`c.bound_store_id`)
  const serviceScope = storeScopeCondition(session, sql`svc.store_id`)
  const memberAmountScope = storeScopeCondition(session, sql`mo.store_id`)
  const annualAmountScope = storeScopeCondition(session, sql`yo.store_id`)

  const rows = await db.execute<RawFunnelEntryRow>(sql`
    WITH first_orders AS (
      SELECT DISTINCT ON (so.client_user_id)
        so.client_user_id,
        COALESCE(so.paid_at, so.sale_order_datetime, so.created_at) AS order_at,
        (COALESCE(so.paid_at, so.sale_order_datetime, so.created_at) AT TIME ZONE 'Asia/Shanghai')::date AS order_date,
        so.store_id,
        COALESCE(NULLIF(so.store_name, ''), s.store_name, so.store_id, '未绑定门店') AS store,
        COALESCE(NULLIF(so.market_name, ''), market_node.name, '未归属市场') AS market
      FROM sale_orders so
      LEFT JOIN stores s ON s.store_id = so.store_id
      LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
      LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
      WHERE ${firstOrderScope}
        AND so.status = '已支付'
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.client_user_id IS NOT NULL
        AND COALESCE(so.paid_at, so.sale_order_datetime, so.created_at) IS NOT NULL
      ORDER BY so.client_user_id, order_at ASC, so.created_at ASC, so.sale_order_id ASC
    ),
    entries AS (
      SELECT
        c.user_id AS customer_id,
        COALESCE(NULLIF(c.customer_id, ''), c.user_id) AS customer_code,
        COALESCE(NULLIF(c.name, ''), c.user_id) AS customer_name,
        COALESCE(c.customer_source::text, ${EMPTY_SOURCE}) AS source,
        CASE WHEN c.customer_source::text = ${TRANSFER_SOURCE} THEN c.created_at ELSE fo.order_at END AS entry_at,
        (CASE WHEN c.customer_source::text = ${TRANSFER_SOURCE} THEN c.created_at ELSE fo.order_at END AT TIME ZONE 'Asia/Shanghai')::date AS entry_date,
        TO_CHAR((CASE WHEN c.customer_source::text = ${TRANSFER_SOURCE} THEN c.created_at ELSE fo.order_at END AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM') AS month,
        CASE
          WHEN c.customer_source::text = ${TRANSFER_SOURCE}
            THEN COALESCE(NULLIF(bound_market.name, ''), '未归属市场')
          ELSE fo.market
        END AS market,
        CASE
          WHEN c.customer_source::text = ${TRANSFER_SOURCE}
            THEN COALESCE(NULLIF(bound_store.store_name, ''), c.bound_store_id, '未绑定门店')
          ELSE fo.store
        END AS store,
        CASE WHEN c.customer_source::text = ${TRANSFER_SOURCE} THEN c.bound_store_id ELSE fo.store_id END AS store_id,
        c.became_member_at
      FROM client_wechat_users c
      LEFT JOIN first_orders fo ON fo.client_user_id = c.user_id
      LEFT JOIN stores bound_store ON bound_store.store_id = c.bound_store_id
      LEFT JOIN org_nodes bound_store_node ON bound_store_node.id = bound_store.org_node_id
      LEFT JOIN org_nodes bound_market ON bound_market.id = bound_store_node.parent_id
      WHERE (
        (c.customer_source::text = ${TRANSFER_SOURCE} AND ${transferScope})
        OR (c.customer_source::text IS DISTINCT FROM ${TRANSFER_SOURCE} AND fo.client_user_id IS NOT NULL)
      )
        AND (CASE WHEN c.customer_source::text = ${TRANSFER_SOURCE} THEN c.created_at ELSE fo.order_at END) IS NOT NULL
    ),
    first_services AS (
      SELECT
        e.customer_id,
        MIN(svc.service_date)::date AS first_service_date
      FROM entries e
      JOIN service_orders svc ON svc.client_user_id = e.customer_id
      WHERE ${serviceScope}
        AND svc.status = '已完成'
        AND svc.service_date >= e.entry_date
        AND svc.service_date <= e.entry_date + INTERVAL '90 days'
      GROUP BY e.customer_id
    ),
    first_member_amounts AS (
      SELECT
        e.customer_id,
        SUM(GREATEST(mo.received::numeric - mo.refunded_amount::numeric, 0)) AS first_membership_amount
      FROM entries e
      JOIN sale_orders mo ON mo.client_user_id = e.customer_id
      WHERE ${memberAmountScope}
        AND e.became_member_at IS NOT NULL
        AND mo.status = '已支付'
        AND mo.sale_order_type IN ('销售单', '转换单')
        AND COALESCE(mo.paid_at, mo.sale_order_datetime, mo.created_at) <= e.became_member_at
      GROUP BY e.customer_id
    ),
    annual_amounts AS (
      SELECT
        e.customer_id,
        SUM(GREATEST(yo.received::numeric - yo.refunded_amount::numeric, 0)) AS annual_contribution_amount
      FROM entries e
      JOIN sale_orders yo ON yo.client_user_id = e.customer_id
      WHERE ${annualAmountScope}
        AND e.became_member_at IS NOT NULL
        AND yo.status = '已支付'
        AND yo.sale_order_type IN ('销售单', '转换单')
        AND (COALESCE(yo.paid_at, yo.sale_order_datetime, yo.created_at) AT TIME ZONE 'Asia/Shanghai')::date >= date_trunc('year', e.entry_date::timestamp)::date
        AND (COALESCE(yo.paid_at, yo.sale_order_datetime, yo.created_at) AT TIME ZONE 'Asia/Shanghai')::date < (date_trunc('year', e.entry_date::timestamp)::date + INTERVAL '1 year')
      GROUP BY e.customer_id
    )
    SELECT
      e.customer_id AS "customerId",
      e.customer_code AS "customerCode",
      e.customer_name AS "customerName",
      e.source AS "source",
      e.month AS "month",
      e.entry_date AS "entryDate",
      e.market AS "market",
      e.store AS "store",
      fs.first_service_date AS "firstServiceDate",
      e.became_member_at AS "becameMemberAt",
      COALESCE(fma.first_membership_amount, 0) AS "firstMembershipAmount",
      COALESCE(aa.annual_contribution_amount, 0) AS "annualContributionAmount"
    FROM entries e
    LEFT JOIN first_services fs ON fs.customer_id = e.customer_id
    LEFT JOIN first_member_amounts fma ON fma.customer_id = e.customer_id
    LEFT JOIN annual_amounts aa ON aa.customer_id = e.customer_id
    ORDER BY e.entry_date DESC, e.customer_id
  `)

  const mapped = mapEntryRows(rows)
  entryCache.set(key, { expiresAt: now + NEW_CUSTOMER_CACHE_TTL, rows: mapped })
  return mapped
}

function filterEntries(
  entries: NewCustomerFunnelEntry[],
  filters: RequiredNewCustomerFunnelFilters,
): NewCustomerFunnelEntry[] {
  return entries.filter((entry) => {
    if (entry.month < filters.startMonth || entry.month > filters.endMonth) return false
    if (filters.source && entry.source !== filters.source) return false
    if (filters.market && entry.market !== filters.market) return false
    if (filters.store && entry.store !== filters.store) return false
    return true
  })
}

function withMonthRange(
  filters: RequiredNewCustomerFunnelFilters,
  range: { startMonth: string; endMonth: string },
): RequiredNewCustomerFunnelFilters {
  return { ...filters, startMonth: range.startMonth, endMonth: range.endMonth }
}

function sortComparisonRows(rows: NewCustomerFunnelComparisonRow[], tableMode: NewCustomerTableMode): NewCustomerFunnelComparisonRow[] {
  if (tableMode === "months") return rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows.sort((a, b) => {
    if (b.newCustomerCount !== a.newCustomerCount) return b.newCustomerCount - a.newCustomerCount
    if (b.arrivalRate !== a.arrivalRate) return b.arrivalRate - a.arrivalRate
    return a.name.localeCompare(b.name, "zh-Hans-CN")
  })
}

function buildComparisonRows(
  entries: NewCustomerFunnelEntry[],
  filters: RequiredNewCustomerFunnelFilters,
): NewCustomerFunnelComparisonRow[] {
  if (filters.tableMode === "months") {
    return sortComparisonRows(
      aggregateFunnelRows(entries, (entry) => entry.month, (entry) => ({ month: entry.month })),
      filters.tableMode,
    )
  }

  if (filters.unitLevel === "store") {
    return sortComparisonRows(
      aggregateFunnelRows(entries, (entry) => entry.store, (entry) => ({ store: entry.store, market: entry.market })),
      filters.tableMode,
    )
  }

  return sortComparisonRows(
    aggregateFunnelRows(entries, (entry) => entry.market, (entry) => ({ market: entry.market })),
    filters.tableMode,
  )
}

function buildFunnelRows(kpi: NewCustomerFunnelKpi): Array<{ name: string; value: number }> {
  return [
    { name: "新客总人数", value: kpi.newCustomerCount },
    { name: "合计到店人数", value: kpi.arrivedCount },
    { name: "会员客户数", value: kpi.memberCustomerCount },
  ]
}

export async function getNewCustomerFunnelDashboard(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
): Promise<NewCustomerFunnelDashboardData> {
  const filters = normalizeNewCustomerFunnelFilters(input)
  const allEntries = await queryFunnelEntries(session)
  const entries = filterEntries(allEntries, filters)
  const prevYearEntries = filterEntries(allEntries, withMonthRange(filters, previousYearRange(filters)))
  const prevPeriodEntries = filterEntries(allEntries, withMonthRange(filters, previousPeriodRange(filters)))
  const kpi = aggregateFunnelKpi(entries)

  return {
    filters,
    kpi,
    prevYearKpi: aggregateFunnelKpi(prevYearEntries),
    prevPeriodKpi: aggregateFunnelKpi(prevPeriodEntries),
    sourceBreakdown: aggregateFunnelBySource(entries),
    comparisonRows: buildComparisonRows(entries, filters),
    funnelRows: buildFunnelRows(kpi),
  }
}

export async function getNewCustomerFunnelKpi(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
): Promise<{ filters: RequiredNewCustomerFunnelFilters; kpi: NewCustomerFunnelKpi }> {
  const filters = normalizeNewCustomerFunnelFilters(input)
  const entries = filterEntries(await queryFunnelEntries(session), filters)
  return { filters, kpi: aggregateFunnelKpi(entries) }
}

export async function getNewCustomerFunnelTrend(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
): Promise<NewCustomerFunnelComparisonRow[]> {
  const filters = normalizeNewCustomerFunnelFilters({ ...input, tableMode: "months" })
  const entries = filterEntries(await queryFunnelEntries(session), filters)
  return buildComparisonRows(entries, filters)
}

export async function getNewCustomerFunnelUnitComparison(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
): Promise<NewCustomerFunnelComparisonRow[]> {
  const filters = normalizeNewCustomerFunnelFilters({ ...input, tableMode: "units" })
  const entries = filterEntries(await queryFunnelEntries(session), filters)
  return buildComparisonRows(entries, filters)
}

export async function getNewCustomerFunnelSourceBreakdown(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
): Promise<NewCustomerFunnelComparisonRow[]> {
  const filters = normalizeNewCustomerFunnelFilters(input)
  const entries = filterEntries(await queryFunnelEntries(session), filters)
  return aggregateFunnelBySource(entries)
}

export async function getNewCustomerFunnelCustomerList(
  session: AuthSession,
  input: NewCustomerFunnelFilters,
  limit = 200,
  listType: NewCustomerFunnelListType = "all",
): Promise<NewCustomerFunnelEntry[]> {
  const filters = normalizeNewCustomerFunnelFilters(input)
  const entries = filterEntries(await queryFunnelEntries(session), filters)
  return filterNewCustomerFunnelListEntries(entries, listType).slice(0, Math.max(1, Math.min(limit, 1000)))
}

export async function getNewCustomerFunnelFilterOptions(
  session: AuthSession,
  selectedMarket?: string,
): Promise<NewCustomerFunnelFilterOptions> {
  const entries = await queryFunnelEntries(session)
  const months = Array.from(new Set(entries.map((entry) => normalizeMonth(entry.month)).filter((month): month is string => Boolean(month))))
    .sort()
    .reverse()
  const observedSources = Array.from(new Set(entries.map((entry) => entry.source))).filter(Boolean)
  const sources = Array.from(new Set([...NEW_CUSTOMER_SOURCE_LABELS, ...observedSources]))
  const markets = Array.from(new Set(entries.map((entry) => entry.market))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  const stores = Array.from(new Set(entries.filter((entry) => !selectedMarket || entry.market === selectedMarket).map((entry) => entry.store)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))

  return { months, sources, markets, stores }
}
