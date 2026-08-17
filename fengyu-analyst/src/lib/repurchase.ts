import "server-only"

import { sql, type SQL } from "drizzle-orm"
import { db } from "@/db"
import { analystScopeCacheKey, scopeFilterSql, type AnalystScope } from "@/lib/analyst-scope"
import { getMemberThreshold } from "@/lib/member-threshold"
import type { AuthSession } from "@/lib/types"
import { bucketCascadeOptions, type CascadeOption } from "./cascade-tree"
import { AsyncTtlCache } from "@/lib/async-ttl-cache"
import { logAnalystDataLoad } from "@/lib/performance-log"

const REPURCHASE_CACHE_TTL = 10 * 60 * 1000
const ANOMALY_Z_THRESHOLD = 1.5

export interface RepurchaseFilters {
  year?: number
  startDate?: string
  endDate?: string
  productKind?: string
  categoryName?: string
}

export interface RepurchaseKpi {
  entryCount: number
  repurchaseCount: number
  repurchaseRate: number
  prevYearRate: number | null
  delta: number | null
}

export interface RepurchaseSeriesPoint {
  name: string
  repurchaseRate: number
  entryCount: number
  repurchaseCount: number
}

export interface RepurchaseRankingRow extends RepurchaseSeriesPoint {
  productKind?: string
  categoryName?: string
  market?: string
  anomaly?: "high" | "low"
}

export interface RepurchaseCustomerRow {
  customerId: string
  customerName: string
  productKind: string
  categoryName: string
  category: string
  status: "进入" | "复购"
  firstDate: string
  store: string
  market: string
}

export interface RepurchaseFilterOptions {
  years: number[]
  productKinds: string[]
  categoryNames: string[]
  categories: string[]
}

export interface RepurchaseDashboardData {
  threshold: number
  filters: Required<RepurchaseFilters>
  kpi: RepurchaseKpi
  trend: RepurchaseSeriesPoint[]
  categoryComparison: RepurchaseRankingRow[]
  marketComparison: RepurchaseRankingRow[]
  storeRanking: RepurchaseRankingRow[]
  anomaly: {
    meanRate: number
    stdRate: number
    rank: number | null
    total: number
    type: "high" | "low" | null
  } | null
}

interface RepurchaseEntryRow {
  customerId: string
  customerName: string
  productKind: string
  categoryName: string
  category: string
  firstDate: string
  store: string
  market: string
  repurchased: boolean
}

interface RawRepurchaseEntryRow {
  [key: string]: unknown
  customerId: unknown
  customerName: unknown
  productKind: unknown
  categoryName: unknown
  category: unknown
  firstDate: unknown
  store: unknown
  market: unknown
  repurchased: unknown
}

interface RepurchaseCatalogRow {
  year: number
  productKind: string
  categoryName: string
}

const rowCache = new AsyncTtlCache<RepurchaseEntryRow[]>({
  ttlMs: REPURCHASE_CACHE_TTL,
  onLoad: ({ key, durationMs, size }) => logAnalystDataLoad({ metric: "repurchase", query: "entries", scopeKey: key, durationMs, rows: size }),
})
const catalogCache = new AsyncTtlCache<RepurchaseCatalogRow[]>({
  ttlMs: REPURCHASE_CACHE_TTL,
  onLoad: ({ key, durationMs, size }) => logAnalystDataLoad({ metric: "repurchase", query: "catalog", scopeKey: key, durationMs, rows: size }),
})

function cleanText(value: unknown): string {
  return String(value ?? "").trim()
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === 1 || value === "1"
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return cleanText(value).slice(0, 10)
}

function rate(repurchaseCount: number, entryCount: number): number {
  return entryCount > 0 ? round4(repurchaseCount / entryCount) : 0
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function normalizeFilterText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function normalizeDateFilter(value: unknown): string | undefined {
  const text = cleanText(Array.isArray(value) ? value[0] : value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? undefined : text
}

function formatCategory(productKind: string, categoryName: string): string {
  return [productKind, categoryName].filter(Boolean).join(" / ")
}

export function normalizeRepurchaseFilters(input: {
  year?: string | string[] | number
  startDate?: string | string[]
  endDate?: string | string[]
  category?: string | string[]
  productKind?: string | string[]
  categoryName?: string | string[]
  market?: string | string[]
  store?: string | string[]
}): RepurchaseFilters {
  const rawYear = Array.isArray(input.year) ? input.year[0] : input.year
  const year = typeof rawYear === "number" ? rawYear : Number(rawYear)
  const legacyCategory = Array.isArray(input.category) ? input.category[0] : input.category
  const productKind = Array.isArray(input.productKind) ? input.productKind[0] : input.productKind
  const categoryName = Array.isArray(input.categoryName) ? input.categoryName[0] : input.categoryName
  const [legacyProductKind, legacyCategoryName] = legacyCategory?.includes(" / ")
    ? legacyCategory.split(" / ", 2)
    : [legacyCategory, undefined]
  let startDate = normalizeDateFilter(input.startDate)
  let endDate = normalizeDateFilter(input.endDate)
  if (startDate && endDate && startDate > endDate) {
    ;[startDate, endDate] = [endDate, startDate]
  }

  return {
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : undefined,
    startDate,
    endDate,
    productKind: normalizeFilterText(productKind) ?? normalizeFilterText(legacyProductKind),
    categoryName: normalizeFilterText(categoryName) ?? normalizeFilterText(legacyCategoryName),
  }
}

function normalizeDashboardFilters(filters: RepurchaseFilters): Required<RepurchaseFilters> {
  return {
    year: filters.year ?? 0,
    startDate: filters.startDate ?? "",
    endDate: filters.endDate ?? "",
    productKind: filters.productKind ?? "",
    categoryName: filters.categoryName ?? "",
  }
}

function resolveFilterDateRange(filters: RepurchaseFilters): { startDate?: string; endDate?: string } {
  if (filters.startDate || filters.endDate) {
    return { startDate: filters.startDate, endDate: filters.endDate }
  }
  if (!filters.year) return {}
  return {
    startDate: `${filters.year}-01-01`,
    endDate: `${filters.year}-12-31`,
  }
}

function shiftDateYear(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number)
  const shiftedYear = year + delta
  const lastDay = new Date(Date.UTC(shiftedYear, month, 0)).getUTCDate()
  return `${shiftedYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
}

function previousYearFilters(filters: RepurchaseFilters): RepurchaseFilters | null {
  if (filters.startDate || filters.endDate) {
    return {
      ...filters,
      year: undefined,
      startDate: filters.startDate ? shiftDateYear(filters.startDate, -1) : undefined,
      endDate: filters.endDate ? shiftDateYear(filters.endDate, -1) : undefined,
    }
  }
  return filters.year ? { ...filters, year: filters.year - 1 } : null
}

function buildBaseConditions(session: AuthSession, scope: AnalystScope, filters: RepurchaseFilters): SQL {
  const productKindExpr = sql`pc.product_kind`
  const categoryNameExpr = sql`pc.category_name`
  const purchaseAtExpr = sql`COALESCE(so.sale_order_datetime, so.paid_at)`

  const conditions: SQL[] = [
    scopeFilterSql(session, scope, "so.store_id"),
    // 寄存单承载 WorkFine 历史持卡品项及历史实收，只参与首次进入基线。
    sql`so.sale_order_type IN ('销售单', '转换单', '寄存单')`,
    sql`so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')`,
    sql`so.client_user_id IS NOT NULL`,
    sql`si.item_direction = '购买'`,
    sql`si.sku_id IS NOT NULL`,
    sql`${productKindExpr} IS NOT NULL`,
    sql`${productKindExpr} <> ''`,
    sql`${categoryNameExpr} IS NOT NULL`,
    sql`${categoryNameExpr} <> ''`,
    sql`${purchaseAtExpr} IS NOT NULL`,
  ]

  if (filters.productKind) conditions.push(sql`${productKindExpr} = ${filters.productKind}`)
  if (filters.categoryName) conditions.push(sql`${categoryNameExpr} = ${filters.categoryName}`)

  return sql.join(conditions, sql` AND `)
}

function mapEntryRows(rows: unknown): RepurchaseEntryRow[] {
  return (rows as RawRepurchaseEntryRow[]).map((row) => ({
    customerId: cleanText(row.customerId),
    customerName: cleanText(row.customerName) || cleanText(row.customerId),
    productKind: cleanText(row.productKind),
    categoryName: cleanText(row.categoryName),
    category: cleanText(row.category) || formatCategory(cleanText(row.productKind), cleanText(row.categoryName)),
    firstDate: normalizeDate(row.firstDate),
    store: cleanText(row.store),
    market: cleanText(row.market),
    repurchased: parseBoolean(row.repurchased),
  }))
}

async function queryRepurchaseEntries(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
  threshold: number,
): Promise<RepurchaseEntryRow[]> {
  const key = JSON.stringify({
    scope: analystScopeCacheKey(session, scope),
    filters: normalizeDashboardFilters(filters),
    threshold,
  })
  return rowCache.getOrLoad(key, async () => {
    const whereSql = buildBaseConditions(session, scope, filters)
    const productKindExpr = sql`pc.product_kind`
    const categoryNameExpr = sql`pc.category_name`
    const marketExpr = sql`COALESCE(NULLIF(so.market_name, ''), market_node.name, '')`
    const storeExpr = sql`COALESCE(NULLIF(so.store_name, ''), s.store_name, so.store_id)`
    const purchaseAtExpr = sql`COALESCE(so.sale_order_datetime, so.paid_at)`
    const purchaseDateExpr = sql`(${purchaseAtExpr} AT TIME ZONE 'Asia/Shanghai')::date`
    const range = resolveFilterDateRange(filters)
    const firstEntryConditions: SQL[] = [sql`TRUE`]
    const repurchaseConditions: SQL[] = [sql`r.sale_date > f.first_date`]
    if (range.startDate) {
      firstEntryConditions.push(sql`first_date >= ${range.startDate}::date`)
      repurchaseConditions.push(sql`r.sale_date >= ${range.startDate}::date`)
    }
    if (range.endDate) {
      firstEntryConditions.push(sql`first_date <= ${range.endDate}::date`)
      repurchaseConditions.push(sql`r.sale_date <= ${range.endDate}::date`)
    }
    const firstEntrySql = sql.join(firstEntryConditions, sql` AND `)
    const repurchaseSql = sql.join(repurchaseConditions, sql` AND `)

    const rows = await db.execute<RawRepurchaseEntryRow>(sql`
    WITH order_item_flows AS (
      SELECT
        so.client_user_id,
        COALESCE(NULLIF(c.customer_id, ''), so.client_user_id) AS customer_code,
        COALESCE(NULLIF(c.name, ''), NULLIF(so.customer_name, ''), so.client_user_id) AS customer_name,
        ${productKindExpr} AS product_kind,
        ${categoryNameExpr} AS category_name,
        so.sale_order_id,
        so.sale_order_type,
        ${purchaseAtExpr} AS min_date,
        ${purchaseDateExpr} AS sale_date,
        so.store_id,
        ${storeExpr} AS store,
        ${marketExpr} AS market,
        SUM(si.received::numeric) AS total_amount
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      LEFT JOIN stores s ON s.store_id = so.store_id
      LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
      LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
      LEFT JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${whereSql}
        ${range.endDate ? sql`AND ${purchaseDateExpr} <= ${range.endDate}::date` : sql``}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
      HAVING SUM(si.received::numeric) > 0
    ),
    daily_agg AS (
      SELECT
        client_user_id,
        customer_code,
        product_kind,
        category_name,
        sale_date,
        store_id,
        store,
        market,
        SUM(total_amount) AS day_amount,
        COALESCE(
          SUM(total_amount) FILTER (WHERE sale_order_type IN ('销售单', '转换单')),
          0
        ) AS repurchase_day_amount,
        MIN(min_date) AS min_date,
        (ARRAY_AGG(customer_name ORDER BY min_date))[1] AS customer_name
      FROM order_item_flows
      GROUP BY client_user_id, customer_code, product_kind, category_name, sale_date, store_id, store, market
    ),
    qualified_days AS (
      SELECT *
      FROM daily_agg
      WHERE day_amount >= ${threshold}
    ),
    repurchase_qualified_days AS (
      SELECT *
      FROM daily_agg
      WHERE repurchase_day_amount >= ${threshold}
    ),
    first_entry AS (
      SELECT
        client_user_id,
        product_kind,
        category_name,
        MIN(sale_date) AS first_date
      FROM qualified_days
      GROUP BY client_user_id, product_kind, category_name
    ),
    entry_cohort AS (
      SELECT *
      FROM first_entry
      WHERE ${firstEntrySql}
    ),
    repurchase_flags AS (
      SELECT
        f.client_user_id,
        f.product_kind,
        f.category_name,
        f.first_date,
        COALESCE(BOOL_OR(${repurchaseSql}), FALSE) AS repurchased
      FROM entry_cohort f
      LEFT JOIN repurchase_qualified_days r
        ON r.client_user_id = f.client_user_id
       AND r.product_kind = f.product_kind
       AND r.category_name = f.category_name
      GROUP BY f.client_user_id, f.product_kind, f.category_name, f.first_date
    )
    SELECT
      q.customer_code AS "customerId",
      (ARRAY_AGG(q.customer_name ORDER BY q.sale_date, q.min_date))[1] AS "customerName",
      q.product_kind AS "productKind",
      q.category_name AS "categoryName",
      CONCAT(q.product_kind, ' / ', q.category_name) AS "category",
      f.first_date AS "firstDate",
      (ARRAY_AGG(q.store ORDER BY q.sale_date, q.min_date))[1] AS "store",
      (ARRAY_AGG(q.market ORDER BY q.sale_date, q.min_date))[1] AS "market",
      f.repurchased AS "repurchased"
    FROM qualified_days q
    JOIN repurchase_flags f
      ON f.client_user_id = q.client_user_id
     AND f.product_kind = q.product_kind
     AND f.category_name = q.category_name
    GROUP BY q.client_user_id, q.customer_code, q.product_kind, q.category_name, f.first_date, f.repurchased
    ORDER BY f.first_date DESC, q.product_kind, q.category_name
    `)
    return mapEntryRows(rows)
  })
}

function aggregateKpi(rows: RepurchaseEntryRow[], prevYearRate: number | null): RepurchaseKpi {
  const entryCount = rows.length
  const repurchaseCount = rows.filter((row) => row.repurchased).length
  const repurchaseRate = rate(repurchaseCount, entryCount)
  return {
    entryCount,
    repurchaseCount,
    repurchaseRate,
    prevYearRate,
    delta: prevYearRate === null ? null : round4(repurchaseRate - prevYearRate),
  }
}

function aggregateSeries(
  rows: RepurchaseEntryRow[],
  getKey: (row: RepurchaseEntryRow) => string,
  extra?: (row: RepurchaseEntryRow) => Partial<RepurchaseRankingRow>,
): RepurchaseRankingRow[] {
  const map = new Map<string, RepurchaseRankingRow>()
  for (const row of rows) {
    const key = getKey(row)
    if (!key) continue
    const current =
      map.get(key) ??
      ({
        name: key,
        entryCount: 0,
        repurchaseCount: 0,
        repurchaseRate: 0,
        ...extra?.(row),
      } satisfies RepurchaseRankingRow)
    current.entryCount += 1
    if (row.repurchased) current.repurchaseCount += 1
    current.repurchaseRate = rate(current.repurchaseCount, current.entryCount)
    map.set(key, current)
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.repurchaseRate !== a.repurchaseRate) return b.repurchaseRate - a.repurchaseRate
    return b.entryCount - a.entryCount
  })
}

function aggregateTrend(rows: RepurchaseEntryRow[]): RepurchaseSeriesPoint[] {
  const map = new Map<string, RepurchaseSeriesPoint>()
  for (const row of rows) {
    const month = row.firstDate.slice(0, 7)
    if (!month) continue
    const current =
      map.get(month) ??
      ({
        name: month,
        entryCount: 0,
        repurchaseCount: 0,
        repurchaseRate: 0,
      } satisfies RepurchaseSeriesPoint)
    current.entryCount += 1
    if (row.repurchased) current.repurchaseCount += 1
    current.repurchaseRate = rate(current.repurchaseCount, current.entryCount)
    map.set(month, current)
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function markAnomalies(rows: RepurchaseRankingRow[]): RepurchaseRankingRow[] {
  const values = rows.map((row) => row.repurchaseRate)
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
  const std = sampleStd(values)
  if (std <= 0) return rows
  return rows.map((row) => {
    const z = (row.repurchaseRate - mean) / std
    if (z > ANOMALY_Z_THRESHOLD) return { ...row, anomaly: "high" }
    if (z < -ANOMALY_Z_THRESHOLD) return { ...row, anomaly: "low" }
    return row
  })
}

function buildCategoryAnomaly(
  selectedCategory: string | undefined,
  categoryComparison: RepurchaseRankingRow[],
): RepurchaseDashboardData["anomaly"] {
  if (!selectedCategory || categoryComparison.length < 2) return null
  const values = categoryComparison.map((row) => row.repurchaseRate)
  const meanRate = round4(values.reduce((sum, value) => sum + value, 0) / values.length)
  const stdRate = round4(sampleStd(values))
  const index = categoryComparison.findIndex((row) => row.name === selectedCategory)
  if (index < 0) return null
  const row = categoryComparison[index]
  let type: "high" | "low" | null = null
  if (stdRate > 0) {
    const z = (row.repurchaseRate - meanRate) / stdRate
    if (z > ANOMALY_Z_THRESHOLD) type = "high"
    if (z < -ANOMALY_Z_THRESHOLD) type = "low"
  }
  return {
    meanRate,
    stdRate,
    rank: index + 1,
    total: categoryComparison.length,
    type,
  }
}

export async function getRepurchaseDashboard(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
): Promise<RepurchaseDashboardData> {
  const threshold = await getMemberThreshold()
  const kpiPrevFilters = previousYearFilters(filters)
  const categoryFilters = { ...filters, categoryName: undefined }

  const [entries, prevEntries, categoryEntries] = await Promise.all([
    queryRepurchaseEntries(session, scope, filters, threshold),
    kpiPrevFilters ? queryRepurchaseEntries(session, scope, kpiPrevFilters, threshold) : Promise.resolve(null),
    queryRepurchaseEntries(session, scope, categoryFilters, threshold),
  ])

  const prevYearRate = prevEntries ? aggregateKpi(prevEntries, null).repurchaseRate : null
  const categoryComparison = markAnomalies(
    aggregateSeries(categoryEntries, (row) => row.category, (row) => ({
      productKind: row.productKind,
      categoryName: row.categoryName,
    })),
  )
  const marketComparison = markAnomalies(aggregateSeries(entries, (row) => row.market))
  const storeRanking = markAnomalies(
    aggregateSeries(entries, (row) => row.store, (row) => ({ market: row.market })),
  )
  const selectedCategory =
    filters.productKind && filters.categoryName
      ? formatCategory(filters.productKind, filters.categoryName)
      : undefined

  return {
    threshold,
    filters: normalizeDashboardFilters(filters),
    kpi: aggregateKpi(entries, prevYearRate),
    trend: aggregateTrend(entries),
    categoryComparison,
    marketComparison,
    storeRanking,
    anomaly: buildCategoryAnomaly(selectedCategory, categoryComparison),
  }
}

async function queryRepurchaseCatalog(session: AuthSession, scope: AnalystScope): Promise<RepurchaseCatalogRow[]> {
  const key = analystScopeCacheKey(session, scope)
  return catalogCache.getOrLoad(key, async () => {
    const whereSql = buildBaseConditions(session, scope, {})
    const purchaseAtExpr = sql`COALESCE(so.sale_order_datetime, so.paid_at)`
    const rows = await db.execute<{ year: unknown; productKind: unknown; categoryName: unknown }>(sql`
      SELECT DISTINCT
        EXTRACT(YEAR FROM (${purchaseAtExpr} AT TIME ZONE 'Asia/Shanghai'))::int AS "year",
        pc.product_kind AS "productKind",
        pc.category_name AS "categoryName"
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      LEFT JOIN stores s ON s.store_id = so.store_id
      LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
      LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
      WHERE ${whereSql}
      ORDER BY "year" DESC, "productKind", "categoryName"
    `)
    return (rows as unknown as Array<{ year: unknown; productKind: unknown; categoryName: unknown }>)
      .map((row) => ({ year: Number(row.year), productKind: cleanText(row.productKind), categoryName: cleanText(row.categoryName) }))
      .filter((row) => Number.isInteger(row.year) && row.productKind && row.categoryName)
  })
}

export async function getRepurchaseFilterOptions(
  session: AuthSession,
  scope: AnalystScope,
  selectedProductKind?: string,
): Promise<RepurchaseFilterOptions> {
  const rows = await queryRepurchaseCatalog(session, scope)
  const years = Array.from(new Set(rows.map((row) => row.year))).sort((a, b) => b - a)
  const productKinds = Array.from(new Set(rows.map((row) => row.productKind))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  const categoryNames = Array.from(new Set(rows.filter((row) => !selectedProductKind || row.productKind === selectedProductKind).map((row) => row.categoryName))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  const categories = Array.from(new Set(rows.map((row) => formatCategory(row.productKind, row.categoryName)))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))

  return { years, productKinds, categoryNames, categories }
}

/**
 * 复购率看板的 Cascader 全量选项树：一级品项→二级品项、市场→门店。
 * 与 getRepurchaseFilterOptions 的字段表达式完全一致，确保级联面板选项与原下拉同口径。
 */
export async function getRepurchaseCascadeTree(
  session: AuthSession,
  scope: AnalystScope,
): Promise<{ productKindTree: CascadeOption[] }> {
  const rows = await queryRepurchaseCatalog(session, scope)
  const productPairs = rows.map((row) => ({ parent: row.productKind, child: row.categoryName }))
  return {
    productKindTree: bucketCascadeOptions(productPairs),
  }
}

export async function getRepurchaseKpi(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
): Promise<{ threshold: number; kpi: RepurchaseKpi }> {
  const threshold = await getMemberThreshold()
  const prevFilters = previousYearFilters(filters)
  const [entries, prevEntries] = await Promise.all([
    queryRepurchaseEntries(session, scope, filters, threshold),
    prevFilters ? queryRepurchaseEntries(session, scope, prevFilters, threshold) : Promise.resolve(null),
  ])
  const prevYearRate = prevEntries ? aggregateKpi(prevEntries, null).repurchaseRate : null
  return { threshold, kpi: aggregateKpi(entries, prevYearRate) }
}

export async function getRepurchaseTrend(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
): Promise<RepurchaseSeriesPoint[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, scope, filters, threshold)
  return aggregateTrend(entries)
}

export async function getCategoryComparison(
  session: AuthSession,
  scope: AnalystScope,
  filters: Omit<RepurchaseFilters, "categoryName">,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, scope, { ...filters, categoryName: undefined }, threshold)
  return markAnomalies(
    aggregateSeries(entries, (row) => row.category, (row) => ({
      productKind: row.productKind,
      categoryName: row.categoryName,
    })),
  )
}

export async function getMarketComparison(
  session: AuthSession,
  scope: AnalystScope,
  filters: Pick<RepurchaseFilters, "year" | "startDate" | "endDate" | "productKind" | "categoryName">,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, scope, filters, threshold)
  return markAnomalies(aggregateSeries(entries, (row) => row.market))
}

export async function getStoreRanking(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
  limit?: number,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, scope, filters, threshold)
  const rows = markAnomalies(aggregateSeries(entries, (row) => row.store, (row) => ({ market: row.market })))
  return limit && limit > 0 ? rows.slice(0, limit) : rows
}

export async function getRepurchaseCustomerList(
  session: AuthSession,
  scope: AnalystScope,
  filters: RepurchaseFilters,
  listType: "all" | "entry_only" | "repurchase" = "all",
  limit = 200,
): Promise<RepurchaseCustomerRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, scope, filters, threshold)
  return entries
    .filter((row) => {
      if (listType === "entry_only") return !row.repurchased
      if (listType === "repurchase") return row.repurchased
      return true
    })
    .slice(0, Math.max(1, Math.min(limit, 1000)))
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName,
      productKind: row.productKind,
      categoryName: row.categoryName,
      category: row.category,
      status: row.repurchased ? "复购" : "进入",
      firstDate: row.firstDate,
      store: row.store,
      market: row.market,
    }))
}
