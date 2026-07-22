import "server-only"

import { sql, type SQL } from "drizzle-orm"
import { db } from "@/db"
import { getMemberThreshold } from "@/lib/member-threshold"
import { isAdminScope } from "@/lib/permissions"
import type { AuthSession } from "@/lib/types"

const REPURCHASE_CACHE_TTL = 10 * 60 * 1000
const ANOMALY_Z_THRESHOLD = 1.5

export interface RepurchaseFilters {
  year?: number
  productKind?: string
  categoryName?: string
  market?: string
  store?: string
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
  markets: string[]
  stores: string[]
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

const rowCache = new Map<string, { expiresAt: number; rows: RepurchaseEntryRow[] }>()

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

function formatCategory(productKind: string, categoryName: string): string {
  return [productKind, categoryName].filter(Boolean).join(" / ")
}

export function normalizeRepurchaseFilters(input: {
  year?: string | string[] | number
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
  const market = Array.isArray(input.market) ? input.market[0] : input.market
  const store = Array.isArray(input.store) ? input.store[0] : input.store
  const [legacyProductKind, legacyCategoryName] = legacyCategory?.includes(" / ")
    ? legacyCategory.split(" / ", 2)
    : [legacyCategory, undefined]

  return {
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : undefined,
    productKind: normalizeFilterText(productKind) ?? normalizeFilterText(legacyProductKind),
    categoryName: normalizeFilterText(categoryName) ?? normalizeFilterText(legacyCategoryName),
    market: normalizeFilterText(market),
    store: normalizeFilterText(store),
  }
}

function normalizeDashboardFilters(filters: RepurchaseFilters): Required<RepurchaseFilters> {
  return {
    year: filters.year ?? 0,
    productKind: filters.productKind ?? "",
    categoryName: filters.categoryName ?? "",
    market: filters.market ?? "",
    store: filters.store ?? "",
  }
}

function scopeCacheKey(session: AuthSession): string {
  if (isAdminScope(session)) return "admin"
  const ids = [...session.permissions.scopeStoreIds].sort()
  return ids.length > 0 ? ids.join(",") : "__none__"
}

function scopeCondition(session: AuthSession): SQL {
  if (isAdminScope(session)) return sql`TRUE`
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) return sql`FALSE`
  return sql`so.store_id = ANY(${ids}::text[])`
}

function buildBaseConditions(session: AuthSession, filters: RepurchaseFilters): SQL {
  const productKindExpr = sql`pc.product_kind`
  const categoryNameExpr = sql`pc.category_name`
  const marketExpr = sql`COALESCE(NULLIF(so.market_name, ''), market_node.name, '')`
  const storeExpr = sql`COALESCE(NULLIF(so.store_name, ''), s.store_name, so.store_id)`
  const paidAtExpr = sql`COALESCE(so.paid_at, so.sale_order_datetime)`

  const conditions: SQL[] = [
    scopeCondition(session),
    sql`so.sale_order_type IN ('销售单', '转换单')`,
    sql`so.status = '已支付'`,
    sql`so.client_user_id IS NOT NULL`,
    sql`si.item_direction = '购买'`,
    sql`si.sku_id IS NOT NULL`,
    sql`${productKindExpr} IS NOT NULL`,
    sql`${productKindExpr} <> ''`,
    sql`${categoryNameExpr} IS NOT NULL`,
    sql`${categoryNameExpr} <> ''`,
    sql`${paidAtExpr} IS NOT NULL`,
  ]

  if (filters.year) {
    conditions.push(sql`
      EXTRACT(YEAR FROM (${paidAtExpr} AT TIME ZONE 'Asia/Shanghai'))::int = ${filters.year}
    `)
  }
  if (filters.productKind) conditions.push(sql`${productKindExpr} = ${filters.productKind}`)
  if (filters.categoryName) conditions.push(sql`${categoryNameExpr} = ${filters.categoryName}`)
  if (filters.market) conditions.push(sql`${marketExpr} = ${filters.market}`)
  if (filters.store) conditions.push(sql`${storeExpr} = ${filters.store}`)

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
  filters: RepurchaseFilters,
  threshold: number,
): Promise<RepurchaseEntryRow[]> {
  const key = JSON.stringify({
    scope: scopeCacheKey(session),
    filters: normalizeDashboardFilters(filters),
    threshold,
  })
  const cached = rowCache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.rows

  const whereSql = buildBaseConditions(session, filters)
  const productKindExpr = sql`pc.product_kind`
  const categoryNameExpr = sql`pc.category_name`
  const marketExpr = sql`COALESCE(NULLIF(so.market_name, ''), market_node.name, '')`
  const storeExpr = sql`COALESCE(NULLIF(so.store_name, ''), s.store_name, so.store_id)`
  const paidAtExpr = sql`COALESCE(so.paid_at, so.sale_order_datetime)`

  const rows = await db.execute<RawRepurchaseEntryRow>(sql`
    WITH order_item_flows AS (
      SELECT
        so.client_user_id,
        COALESCE(NULLIF(c.customer_id, ''), so.client_user_id) AS customer_code,
        COALESCE(NULLIF(c.name, ''), NULLIF(so.customer_name, ''), so.client_user_id) AS customer_name,
        ${productKindExpr} AS product_kind,
        ${categoryNameExpr} AS category_name,
        so.sale_order_id,
        ${paidAtExpr} AS min_date,
        (${paidAtExpr} AT TIME ZONE 'Asia/Shanghai')::date AS sale_date,
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
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
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
    first_entry AS (
      SELECT
        client_user_id,
        product_kind,
        category_name,
        MIN(sale_date) AS first_date
      FROM qualified_days
      GROUP BY client_user_id, product_kind, category_name
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
      BOOL_OR(q.sale_date <> f.first_date) AS "repurchased"
    FROM qualified_days q
    JOIN first_entry f
      ON f.client_user_id = q.client_user_id
     AND f.product_kind = q.product_kind
     AND f.category_name = q.category_name
    GROUP BY q.client_user_id, q.customer_code, q.product_kind, q.category_name, f.first_date
    ORDER BY f.first_date DESC, q.product_kind, q.category_name
  `)

  const mapped = mapEntryRows(rows)
  rowCache.set(key, { expiresAt: now + REPURCHASE_CACHE_TTL, rows: mapped })
  return mapped
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
  filters: RepurchaseFilters,
): Promise<RepurchaseDashboardData> {
  const threshold = await getMemberThreshold()
  const kpiPrevFilters = filters.year ? { ...filters, year: filters.year - 1 } : null
  const categoryFilters = { ...filters, categoryName: undefined }
  const marketFilters = { ...filters, market: undefined, store: undefined }
  const storeFilters = { ...filters, store: undefined }

  const [entries, prevEntries, categoryEntries, marketEntries, storeEntries] = await Promise.all([
    queryRepurchaseEntries(session, filters, threshold),
    kpiPrevFilters ? queryRepurchaseEntries(session, kpiPrevFilters, threshold) : Promise.resolve(null),
    queryRepurchaseEntries(session, categoryFilters, threshold),
    queryRepurchaseEntries(session, marketFilters, threshold),
    queryRepurchaseEntries(session, storeFilters, threshold),
  ])

  const prevYearRate = prevEntries ? aggregateKpi(prevEntries, null).repurchaseRate : null
  const categoryComparison = markAnomalies(
    aggregateSeries(categoryEntries, (row) => row.category, (row) => ({
      productKind: row.productKind,
      categoryName: row.categoryName,
    })),
  )
  const marketComparison = markAnomalies(aggregateSeries(marketEntries, (row) => row.market))
  const storeRanking = markAnomalies(
    aggregateSeries(storeEntries, (row) => row.store, (row) => ({ market: row.market })),
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

async function queryDistinctStrings(session: AuthSession, expression: SQL, extraCondition?: SQL): Promise<string[]> {
  const whereSql = buildBaseConditions(session, {})
  const rows = await db.execute<{ value: string }>(sql`
    SELECT DISTINCT ${expression} AS value
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    LEFT JOIN stores s ON s.store_id = so.store_id
    LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
    LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
    WHERE ${whereSql}
      ${extraCondition ? sql`AND ${extraCondition}` : sql``}
      AND ${expression} IS NOT NULL
      AND ${expression} <> ''
    ORDER BY value
  `)
  return (rows as unknown as Array<{ value: unknown }>).map((row) => cleanText(row.value)).filter(Boolean)
}

async function queryAvailableYears(session: AuthSession): Promise<number[]> {
  const whereSql = buildBaseConditions(session, {})
  const paidAtExpr = sql`COALESCE(so.paid_at, so.sale_order_datetime)`
  const rows = await db.execute<{ value: number }>(sql`
    SELECT DISTINCT EXTRACT(YEAR FROM (${paidAtExpr} AT TIME ZONE 'Asia/Shanghai'))::int AS value
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    LEFT JOIN stores s ON s.store_id = so.store_id
    LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
    LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
    WHERE ${whereSql}
    ORDER BY value DESC
  `)
  return (rows as unknown as Array<{ value: unknown }>)
    .map((row) => Number(row.value))
    .filter((value) => Number.isInteger(value))
}

export async function getRepurchaseFilterOptions(
  session: AuthSession,
  selectedMarket?: string,
  selectedProductKind?: string,
): Promise<RepurchaseFilterOptions> {
  const productKindExpr = sql`pc.product_kind`
  const categoryNameExpr = sql`pc.category_name`
  const categoryExpr = sql`CONCAT(pc.product_kind, ' / ', pc.category_name)`
  const marketExpr = sql`COALESCE(NULLIF(so.market_name, ''), market_node.name, '')`
  const storeExpr = sql`COALESCE(NULLIF(so.store_name, ''), s.store_name, so.store_id)`

  const [years, productKinds, categoryNames, categories, markets, stores] = await Promise.all([
    queryAvailableYears(session),
    queryDistinctStrings(session, productKindExpr),
    queryDistinctStrings(
      session,
      categoryNameExpr,
      selectedProductKind ? sql`${productKindExpr} = ${selectedProductKind}` : undefined,
    ),
    queryDistinctStrings(session, categoryExpr),
    queryDistinctStrings(session, marketExpr),
    queryDistinctStrings(session, storeExpr, selectedMarket ? sql`${marketExpr} = ${selectedMarket}` : undefined),
  ])

  return { years, productKinds, categoryNames, categories, markets, stores }
}

export async function getRepurchaseKpi(
  session: AuthSession,
  filters: RepurchaseFilters,
): Promise<{ threshold: number; kpi: RepurchaseKpi }> {
  const threshold = await getMemberThreshold()
  const [entries, prevEntries] = await Promise.all([
    queryRepurchaseEntries(session, filters, threshold),
    filters.year ? queryRepurchaseEntries(session, { ...filters, year: filters.year - 1 }, threshold) : Promise.resolve(null),
  ])
  const prevYearRate = prevEntries ? aggregateKpi(prevEntries, null).repurchaseRate : null
  return { threshold, kpi: aggregateKpi(entries, prevYearRate) }
}

export async function getRepurchaseTrend(
  session: AuthSession,
  filters: RepurchaseFilters,
): Promise<RepurchaseSeriesPoint[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, filters, threshold)
  return aggregateTrend(entries)
}

export async function getCategoryComparison(
  session: AuthSession,
  filters: Omit<RepurchaseFilters, "categoryName">,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, { ...filters, categoryName: undefined }, threshold)
  return markAnomalies(
    aggregateSeries(entries, (row) => row.category, (row) => ({
      productKind: row.productKind,
      categoryName: row.categoryName,
    })),
  )
}

export async function getMarketComparison(
  session: AuthSession,
  filters: Pick<RepurchaseFilters, "year" | "productKind" | "categoryName">,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, filters, threshold)
  return markAnomalies(aggregateSeries(entries, (row) => row.market))
}

export async function getStoreRanking(
  session: AuthSession,
  filters: Omit<RepurchaseFilters, "store">,
  limit?: number,
): Promise<RepurchaseRankingRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, { ...filters, store: undefined }, threshold)
  const rows = markAnomalies(aggregateSeries(entries, (row) => row.store, (row) => ({ market: row.market })))
  return limit && limit > 0 ? rows.slice(0, limit) : rows
}

export async function getRepurchaseCustomerList(
  session: AuthSession,
  filters: RepurchaseFilters,
  listType: "all" | "entry_only" | "repurchase" = "all",
  limit = 200,
): Promise<RepurchaseCustomerRow[]> {
  const threshold = await getMemberThreshold()
  const entries = await queryRepurchaseEntries(session, filters, threshold)
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
