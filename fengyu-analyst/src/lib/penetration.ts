import "server-only"

import { sql, type SQL } from "drizzle-orm"
import { db } from "@/db"
import { isAdminScope } from "@/lib/permissions"
import type { AuthSession } from "@/lib/types"
import {
  safeRate,
  summarizeProductNames,
  type ProductNameObservation,
} from "@/lib/penetration-utils"

const PENETRATION_CACHE_TTL = 10 * 60 * 1000

export interface PenetrationFilters {
  productKind?: string
  categoryName?: string
  seriesName?: string
  skuId?: string
  market?: string
  store?: string
}

export interface PenetrationKpi {
  memberCount: number
  cardHolderCount: number
  penetrationRate: number
  remainingSessions: number
}

export interface PenetrationRankingRow extends PenetrationKpi {
  id: string
  name: string
  productKind?: string
  categoryName?: string
  seriesName?: string
  skuId?: string
  productName?: string
  productNames?: string[]
  market?: string
}

export interface PenetrationProductOption {
  skuId: string
  productName: string
  productNames: string[]
  missingName: boolean
  hasMultipleNames: boolean
}

export interface PenetrationFilterOptions {
  productKinds: string[]
  categoryNames: string[]
  seriesNames: string[]
  products: PenetrationProductOption[]
  markets: string[]
  stores: string[]
}

export interface PenetrationDataQualityIssue {
  skuId: string
  productName: string
  productNames: string[]
  holderCount: number
}

export interface PenetrationDataQuality {
  missingProductNameSkus: PenetrationDataQualityIssue[]
  multiNameSkus: PenetrationDataQualityIssue[]
}

export interface PenetrationCustomerRow {
  customerId: string
  customerCode: string
  customerName: string
  market: string
  store: string
  productKind: string
  categoryName: string
  seriesName: string
  skuId: string
  productName: string
  productNames: string[]
  remainingSessions: number
}

export interface PenetrationDashboardData {
  filters: Required<PenetrationFilters>
  kpi: PenetrationKpi
  productKindComparison: PenetrationRankingRow[]
  categoryComparison: PenetrationRankingRow[]
  seriesComparison: PenetrationRankingRow[]
  productComparison: PenetrationRankingRow[]
  marketComparison: PenetrationRankingRow[]
  storeRanking: PenetrationRankingRow[]
  dataQuality: PenetrationDataQuality
}

interface MemberRow {
  customerId: string
  market: string
  store: string
}

interface HolderRow extends MemberRow {
  customerCode: string
  customerName: string
  productKind: string
  categoryName: string
  seriesName: string
  skuId: string
  productName: string
  currentProductName: string
  observedAt: string
  remainingSessions: number
}

interface RawMemberRow {
  [key: string]: unknown
  customerId: unknown
  market: unknown
  store: unknown
}

interface RawHolderRow extends RawMemberRow {
  customerName: unknown
  customerCode: unknown
  productKind: unknown
  categoryName: unknown
  seriesName: unknown
  skuId: unknown
  productName: unknown
  currentProductName: unknown
  observedAt: unknown
  remainingSessions: unknown
}

const memberCache = new Map<string, { expiresAt: number; rows: MemberRow[] }>()
const holderCache = new Map<string, { expiresAt: number; rows: HolderRow[] }>()

function cleanText(value: unknown): string {
  return String(value ?? "").trim()
}

function normalizeNumber(value: unknown): number {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function normalizeDateTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return cleanText(value)
}

function normalizeFilterText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function normalizeDashboardFilters(filters: PenetrationFilters): Required<PenetrationFilters> {
  return {
    productKind: filters.productKind ?? "",
    categoryName: filters.categoryName ?? "",
    seriesName: filters.seriesName ?? "",
    skuId: filters.skuId ?? "",
    market: filters.market ?? "",
    store: filters.store ?? "",
  }
}

export function normalizePenetrationFilters(input: {
  productKind?: string | string[]
  categoryName?: string | string[]
  seriesName?: string | string[]
  skuId?: string | string[]
  market?: string | string[]
  store?: string | string[]
}): PenetrationFilters {
  const productKind = Array.isArray(input.productKind) ? input.productKind[0] : input.productKind
  const categoryName = Array.isArray(input.categoryName) ? input.categoryName[0] : input.categoryName
  const seriesName = Array.isArray(input.seriesName) ? input.seriesName[0] : input.seriesName
  const skuId = Array.isArray(input.skuId) ? input.skuId[0] : input.skuId
  const market = Array.isArray(input.market) ? input.market[0] : input.market
  const store = Array.isArray(input.store) ? input.store[0] : input.store

  return {
    productKind: normalizeFilterText(productKind),
    categoryName: normalizeFilterText(categoryName),
    seriesName: normalizeFilterText(seriesName),
    skuId: normalizeFilterText(skuId),
    market: normalizeFilterText(market),
    store: normalizeFilterText(store),
  }
}

function scopeCacheKey(session: AuthSession): string {
  if (isAdminScope(session)) return "admin"
  const ids = [...session.permissions.scopeStoreIds].sort()
  return ids.length > 0 ? ids.join(",") : "__none__"
}

function boundStoreScopeCondition(session: AuthSession): SQL {
  if (isAdminScope(session)) return sql`TRUE`
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) return sql`FALSE`
  return sql`c.bound_store_id = ANY(${ids}::text[])`
}

function memberConditions(session: AuthSession, filters: Pick<PenetrationFilters, "market" | "store">): SQL {
  const marketExpr = sql`COALESCE(NULLIF(market_node.name, ''), '未归属市场')`
  const storeExpr = sql`COALESCE(NULLIF(s.store_name, ''), c.bound_store_id, '未绑定门店')`
  const conditions: SQL[] = [
    boundStoreScopeCondition(session),
    sql`c.became_member_at IS NOT NULL`,
  ]

  if (filters.market) conditions.push(sql`${marketExpr} = ${filters.market}`)
  if (filters.store) conditions.push(sql`${storeExpr} = ${filters.store}`)

  return sql.join(conditions, sql` AND `)
}

function productConditions(filters: PenetrationFilters): SQL {
  const productKindExpr = sql`COALESCE(NULLIF(pc.product_kind, ''), '未设置一级品项')`
  const categoryExpr = sql`COALESCE(NULLIF(pc.category_name, ''), '未设置二级品项')`
  const seriesExpr = sql`COALESCE(NULLIF(psl.name, ''), '未设置系列')`
  const conditions: SQL[] = [sql`TRUE`]

  if (filters.productKind) conditions.push(sql`${productKindExpr} = ${filters.productKind}`)
  if (filters.categoryName) conditions.push(sql`${categoryExpr} = ${filters.categoryName}`)
  if (filters.seriesName) conditions.push(sql`${seriesExpr} = ${filters.seriesName}`)
  if (filters.skuId) conditions.push(sql`si.sku_id = ${filters.skuId}`)

  return sql.join(conditions, sql` AND `)
}

function cacheKey(session: AuthSession, filters: PenetrationFilters): string {
  return JSON.stringify({
    scope: scopeCacheKey(session),
    filters: normalizeDashboardFilters(filters),
  })
}

function mapMemberRows(rows: unknown): MemberRow[] {
  return (rows as RawMemberRow[]).map((row) => ({
    customerId: cleanText(row.customerId),
    market: cleanText(row.market),
    store: cleanText(row.store),
  }))
}

function mapHolderRows(rows: unknown): HolderRow[] {
  return (rows as RawHolderRow[]).map((row) => ({
    customerId: cleanText(row.customerId),
    customerCode: cleanText(row.customerCode) || cleanText(row.customerId),
    customerName: cleanText(row.customerName) || cleanText(row.customerId),
    market: cleanText(row.market),
    store: cleanText(row.store),
    productKind: cleanText(row.productKind),
    categoryName: cleanText(row.categoryName),
    seriesName: cleanText(row.seriesName),
    skuId: cleanText(row.skuId),
    productName: cleanText(row.productName),
    currentProductName: cleanText(row.currentProductName),
    observedAt: normalizeDateTime(row.observedAt),
    remainingSessions: normalizeNumber(row.remainingSessions),
  }))
}

async function queryMemberRows(
  session: AuthSession,
  filters: Pick<PenetrationFilters, "market" | "store">,
): Promise<MemberRow[]> {
  const key = cacheKey(session, { market: filters.market, store: filters.store })
  const now = Date.now()
  const cached = memberCache.get(key)
  if (cached && cached.expiresAt > now) return cached.rows

  const whereSql = memberConditions(session, filters)
  const rows = await db.execute<RawMemberRow>(sql`
    SELECT
      c.user_id AS "customerId",
      COALESCE(NULLIF(market_node.name, ''), '未归属市场') AS "market",
      COALESCE(NULLIF(s.store_name, ''), c.bound_store_id, '未绑定门店') AS "store"
    FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id
    LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
    LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
    WHERE ${whereSql}
  `)

  const mapped = mapMemberRows(rows)
  memberCache.set(key, { expiresAt: now + PENETRATION_CACHE_TTL, rows: mapped })
  return mapped
}

async function queryHolderRows(session: AuthSession, filters: PenetrationFilters): Promise<HolderRow[]> {
  const key = cacheKey(session, filters)
  const now = Date.now()
  const cached = holderCache.get(key)
  if (cached && cached.expiresAt > now) return cached.rows

  const memberWhereSql = memberConditions(session, filters)
  const productWhereSql = productConditions(filters)
  const rows = await db.execute<RawHolderRow>(sql`
    SELECT
      c.user_id AS "customerId",
      COALESCE(NULLIF(c.customer_id, ''), c.user_id) AS "customerCode",
      COALESCE(NULLIF(c.name, ''), NULLIF(so.customer_name, ''), c.user_id) AS "customerName",
      COALESCE(NULLIF(market_node.name, ''), '未归属市场') AS "market",
      COALESCE(NULLIF(s.store_name, ''), c.bound_store_id, '未绑定门店') AS "store",
      COALESCE(NULLIF(pc.product_kind, ''), '未设置一级品项') AS "productKind",
      COALESCE(NULLIF(pc.category_name, ''), '未设置二级品项') AS "categoryName",
      COALESCE(NULLIF(psl.name, ''), '未设置系列') AS "seriesName",
      si.sku_id AS "skuId",
      COALESCE(si.product_name, '') AS "productName",
      COALESCE(NULLIF(sk.spec_name, ''), '') AS "currentProductName",
      COALESCE(so.paid_at, so.sale_order_datetime, so.created_at) AS "observedAt",
      si.remaining_sessions AS "remainingSessions"
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN client_wechat_users c ON c.user_id = so.client_user_id
    LEFT JOIN product_skus sk ON sk.sku_id = si.sku_id
    LEFT JOIN product_categories pc ON pc.category_id = sk.category_id
    LEFT JOIN project_series_lookup psl ON psl.id = sk.project_series_id
    LEFT JOIN stores s ON s.store_id = c.bound_store_id
    LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
    LEFT JOIN org_nodes market_node ON market_node.id = store_node.parent_id
    WHERE ${memberWhereSql}
      AND ${productWhereSql}
      AND so.status = '已支付'
      AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
      AND si.item_direction IN ('购买', '转入')
      AND si.product_type = '疗程卡'
      AND si.sku_id IS NOT NULL
      AND si.sku_id <> ''
      AND si.remaining_sessions > 0
  `)

  const mapped = mapHolderRows(rows)
  holderCache.set(key, { expiresAt: now + PENETRATION_CACHE_TTL, rows: mapped })
  return mapped
}

function distinctCount(values: Iterable<string>): number {
  return new Set(Array.from(values).filter(Boolean)).size
}

function countMembersBy(rows: MemberRow[], getKey: (row: MemberRow) => string): Map<string, number> {
  const map = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = getKey(row)
    if (!key) continue
    const current = map.get(key) ?? new Set<string>()
    current.add(row.customerId)
    map.set(key, current)
  }
  return new Map(Array.from(map.entries()).map(([key, ids]) => [key, ids.size]))
}

function aggregateKpi(rows: HolderRow[], memberCount: number): PenetrationKpi {
  const cardHolderCount = distinctCount(rows.map((row) => row.customerId))
  const remainingSessions = rows.reduce((sum, row) => sum + row.remainingSessions, 0)
  return {
    memberCount,
    cardHolderCount,
    penetrationRate: safeRate(cardHolderCount, memberCount),
    remainingSessions,
  }
}

function aggregateRows(
  rows: HolderRow[],
  getKey: (row: HolderRow) => string,
  memberCountForKey: (key: string) => number,
  extra?: (row: HolderRow) => Partial<PenetrationRankingRow>,
): PenetrationRankingRow[] {
  const map = new Map<
    string,
    {
      cardHolderIds: Set<string>
      remainingSessions: number
      base: Partial<PenetrationRankingRow>
    }
  >()

  for (const row of rows) {
    const key = getKey(row)
    if (!key) continue
    const current = map.get(key) ?? {
      cardHolderIds: new Set<string>(),
      remainingSessions: 0,
      base: extra?.(row) ?? {},
    }
    current.cardHolderIds.add(row.customerId)
    current.remainingSessions += row.remainingSessions
    map.set(key, current)
  }

  return Array.from(map.entries())
    .map(([key, value]) => {
      const memberCount = memberCountForKey(key)
      const cardHolderCount = value.cardHolderIds.size
      return {
        id: key,
        name: key,
        memberCount,
        cardHolderCount,
        penetrationRate: safeRate(cardHolderCount, memberCount),
        remainingSessions: value.remainingSessions,
        ...value.base,
      } satisfies PenetrationRankingRow
    })
    .sort((a, b) => {
      if (b.penetrationRate !== a.penetrationRate) return b.penetrationRate - a.penetrationRate
      if (b.cardHolderCount !== a.cardHolderCount) return b.cardHolderCount - a.cardHolderCount
      return a.name.localeCompare(b.name, "zh-Hans-CN")
    })
}

function productNameSummary(rows: HolderRow[]) {
  const observations = rows.map((row) => ({
    productName: row.productName,
    currentProductName: row.currentProductName,
    observedAt: row.observedAt,
  }))
  return summarizeProductNames(observations)
}

function aggregateProducts(rows: HolderRow[], memberCount: number): PenetrationRankingRow[] {
  const rowsBySku = new Map<string, HolderRow[]>()
  for (const row of rows) {
    const current = rowsBySku.get(row.skuId) ?? []
    current.push(row)
    rowsBySku.set(row.skuId, current)
  }

  return Array.from(rowsBySku.entries())
    .map(([skuId, skuRows]) => {
      const first = skuRows[0]
      const summary = productNameSummary(skuRows)
      const kpi = aggregateKpi(skuRows, memberCount)
      return {
        id: skuId,
        name: summary.productName,
        ...kpi,
        productKind: first.productKind,
        categoryName: first.categoryName,
        seriesName: first.seriesName,
        skuId,
        productName: summary.productName,
        productNames: summary.productNames,
      } satisfies PenetrationRankingRow
    })
    .sort((a, b) => {
      if (b.penetrationRate !== a.penetrationRate) return b.penetrationRate - a.penetrationRate
      if (b.cardHolderCount !== a.cardHolderCount) return b.cardHolderCount - a.cardHolderCount
      return a.name.localeCompare(b.name, "zh-Hans-CN")
    })
}

function buildProductOptions(rows: HolderRow[]): PenetrationProductOption[] {
  return aggregateProducts(rows, Math.max(distinctCount(rows.map((row) => row.customerId)), 1))
    .map((row) => {
      const summary = summarizeProductNames(
        rows
          .filter((item) => item.skuId === row.skuId)
          .map((item) => ({
            productName: item.productName,
            currentProductName: item.currentProductName,
            observedAt: item.observedAt,
          })),
      )
      return {
        skuId: row.skuId ?? "",
        productName: summary.productName,
        productNames: summary.productNames,
        missingName: summary.missingName,
        hasMultipleNames: summary.hasMultipleNames,
      }
    })
    .filter((row) => row.skuId)
}

function buildDataQuality(rows: HolderRow[]): PenetrationDataQuality {
  const rowsBySku = new Map<string, HolderRow[]>()
  for (const row of rows) {
    const current = rowsBySku.get(row.skuId) ?? []
    current.push(row)
    rowsBySku.set(row.skuId, current)
  }

  const missingProductNameSkus: PenetrationDataQualityIssue[] = []
  const multiNameSkus: PenetrationDataQualityIssue[] = []

  for (const [skuId, skuRows] of rowsBySku) {
    const summary = productNameSummary(skuRows)
    const issue = {
      skuId,
      productName: summary.productName,
      productNames: summary.productNames,
      holderCount: distinctCount(skuRows.map((row) => row.customerId)),
    }
    if (summary.missingName) missingProductNameSkus.push(issue)
    if (summary.hasMultipleNames) multiNameSkus.push(issue)
  }

  const sortIssues = (issues: PenetrationDataQualityIssue[]) =>
    issues.sort((a, b) => {
      if (b.holderCount !== a.holderCount) return b.holderCount - a.holderCount
      return a.skuId.localeCompare(b.skuId)
    })

  return {
    missingProductNameSkus: sortIssues(missingProductNameSkus),
    multiNameSkus: sortIssues(multiNameSkus),
  }
}

function productCategoryName(row: HolderRow): string {
  return `${row.productKind} / ${row.categoryName}`
}

function productSeriesName(row: HolderRow): string {
  return `${row.productKind} / ${row.categoryName} / ${row.seriesName}`
}

export async function getPenetrationDashboard(
  session: AuthSession,
  filters: PenetrationFilters,
): Promise<PenetrationDashboardData> {
  const orgFilters = { market: filters.market, store: filters.store }
  const categoryFilters = { ...filters, categoryName: undefined, seriesName: undefined, skuId: undefined }
  const seriesFilters = { ...filters, seriesName: undefined, skuId: undefined }
  const productFilters = { ...filters, skuId: undefined }
  const marketFilters = { ...filters, market: undefined, store: undefined }
  const storeFilters = { ...filters, store: undefined }

  const [
    members,
    marketMembers,
    storeMembers,
    rows,
    productKindRows,
    categoryRows,
    seriesRows,
    productRows,
    marketRows,
    storeRows,
  ] = await Promise.all([
    queryMemberRows(session, orgFilters),
    queryMemberRows(session, {}),
    queryMemberRows(session, { market: filters.market }),
    queryHolderRows(session, filters),
    queryHolderRows(session, { ...filters, productKind: undefined, categoryName: undefined, seriesName: undefined, skuId: undefined }),
    queryHolderRows(session, categoryFilters),
    queryHolderRows(session, seriesFilters),
    queryHolderRows(session, productFilters),
    queryHolderRows(session, marketFilters),
    queryHolderRows(session, storeFilters),
  ])

  const memberCount = distinctCount(members.map((row) => row.customerId))
  const marketMemberCount = countMembersBy(marketMembers, (row) => row.market)
  const storeMemberCount = countMembersBy(storeMembers, (row) => row.store)

  return {
    filters: normalizeDashboardFilters(filters),
    kpi: aggregateKpi(rows, memberCount),
    productKindComparison: aggregateRows(
      productKindRows,
      (row) => row.productKind,
      () => memberCount,
      (row) => ({ productKind: row.productKind }),
    ),
    categoryComparison: aggregateRows(
      categoryRows,
      productCategoryName,
      () => memberCount,
      (row) => ({ productKind: row.productKind, categoryName: row.categoryName }),
    ),
    seriesComparison: aggregateRows(
      seriesRows,
      productSeriesName,
      () => memberCount,
      (row) => ({ productKind: row.productKind, categoryName: row.categoryName, seriesName: row.seriesName }),
    ),
    productComparison: aggregateProducts(productRows, memberCount),
    marketComparison: aggregateRows(
      marketRows,
      (row) => row.market,
      (market) => marketMemberCount.get(market) ?? 0,
      (row) => ({ market: row.market }),
    ),
    storeRanking: aggregateRows(
      storeRows,
      (row) => row.store,
      (store) => storeMemberCount.get(store) ?? 0,
      (row) => ({ market: row.market }),
    ),
    dataQuality: buildDataQuality(productRows),
  }
}

export async function getPenetrationFilterOptions(
  session: AuthSession,
  selectedMarket?: string,
  selectedProductKind?: string,
  selectedCategoryName?: string,
  selectedSeriesName?: string,
): Promise<PenetrationFilterOptions> {
  const [members, scopedMembers, productKindRows, categoryRows, seriesRows, productRows] = await Promise.all([
    queryMemberRows(session, {}),
    queryMemberRows(session, { market: selectedMarket }),
    queryHolderRows(session, { market: selectedMarket }),
    queryHolderRows(session, { market: selectedMarket, productKind: selectedProductKind }),
    queryHolderRows(session, { market: selectedMarket, productKind: selectedProductKind, categoryName: selectedCategoryName }),
    queryHolderRows(session, {
      market: selectedMarket,
      productKind: selectedProductKind,
      categoryName: selectedCategoryName,
      seriesName: selectedSeriesName,
    }),
  ])

  return {
    productKinds: Array.from(new Set(productKindRows.map((row) => row.productKind))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    categoryNames: Array.from(new Set(categoryRows.map((row) => row.categoryName))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    seriesNames: Array.from(new Set(seriesRows.map((row) => row.seriesName))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    products: buildProductOptions(productRows),
    markets: Array.from(new Set(members.map((row) => row.market))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    stores: Array.from(new Set(scopedMembers.map((row) => row.store))).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
  }
}

export async function getPenetrationKpi(
  session: AuthSession,
  filters: PenetrationFilters,
): Promise<PenetrationKpi> {
  const [members, rows] = await Promise.all([
    queryMemberRows(session, { market: filters.market, store: filters.store }),
    queryHolderRows(session, filters),
  ])
  return aggregateKpi(rows, distinctCount(members.map((row) => row.customerId)))
}

export async function getPenetrationProductComparison(
  session: AuthSession,
  filters: Omit<PenetrationFilters, "skuId">,
): Promise<PenetrationRankingRow[]> {
  const [members, rows] = await Promise.all([
    queryMemberRows(session, { market: filters.market, store: filters.store }),
    queryHolderRows(session, { ...filters, skuId: undefined }),
  ])
  return aggregateProducts(rows, distinctCount(members.map((row) => row.customerId)))
}

export async function getPenetrationCategoryComparison(
  session: AuthSession,
  filters: Omit<PenetrationFilters, "categoryName" | "seriesName" | "skuId">,
): Promise<PenetrationRankingRow[]> {
  const [members, rows] = await Promise.all([
    queryMemberRows(session, { market: filters.market, store: filters.store }),
    queryHolderRows(session, { ...filters, categoryName: undefined, seriesName: undefined, skuId: undefined }),
  ])
  const memberCount = distinctCount(members.map((row) => row.customerId))
  return aggregateRows(rows, productCategoryName, () => memberCount, (row) => ({
    productKind: row.productKind,
    categoryName: row.categoryName,
  }))
}

export async function getPenetrationMarketComparison(
  session: AuthSession,
  filters: Pick<PenetrationFilters, "productKind" | "categoryName" | "seriesName" | "skuId">,
): Promise<PenetrationRankingRow[]> {
  const [members, rows] = await Promise.all([
    queryMemberRows(session, {}),
    queryHolderRows(session, filters),
  ])
  const counts = countMembersBy(members, (row) => row.market)
  return aggregateRows(rows, (row) => row.market, (market) => counts.get(market) ?? 0, (row) => ({
    market: row.market,
  }))
}

export async function getPenetrationStoreRanking(
  session: AuthSession,
  filters: Omit<PenetrationFilters, "store">,
  limit?: number,
): Promise<PenetrationRankingRow[]> {
  const [members, rows] = await Promise.all([
    queryMemberRows(session, { market: filters.market }),
    queryHolderRows(session, { ...filters, store: undefined }),
  ])
  const counts = countMembersBy(members, (row) => row.store)
  const ranking = aggregateRows(rows, (row) => row.store, (store) => counts.get(store) ?? 0, (row) => ({
    market: row.market,
  }))
  return limit && limit > 0 ? ranking.slice(0, limit) : ranking
}

export async function getPenetrationCustomerList(
  session: AuthSession,
  filters: PenetrationFilters,
  limit = 1000,
): Promise<PenetrationCustomerRow[]> {
  const rows = await queryHolderRows(session, filters)
  const map = new Map<
    string,
    {
      rows: HolderRow[]
      remainingSessions: number
    }
  >()

  for (const row of rows) {
    const key = `${row.customerId}::${row.skuId}`
    const current = map.get(key) ?? { rows: [], remainingSessions: 0 }
    current.rows.push(row)
    current.remainingSessions += row.remainingSessions
    map.set(key, current)
  }

  return Array.from(map.values())
    .slice(0, Math.max(1, Math.min(limit, 5000)))
    .map((group) => {
      const first = group.rows[0]
      const summary = productNameSummary(group.rows)
      return {
        customerId: first.customerId,
        customerCode: first.customerCode,
        customerName: first.customerName,
        market: first.market,
        store: first.store,
        productKind: first.productKind,
        categoryName: first.categoryName,
        seriesName: first.seriesName,
        skuId: first.skuId,
        productName: summary.productName,
        productNames: summary.productNames,
        remainingSessions: group.remainingSessions,
      }
    })
    .sort((a, b) => {
      if (b.remainingSessions !== a.remainingSessions) return b.remainingSessions - a.remainingSessions
      return a.customerName.localeCompare(b.customerName, "zh-Hans-CN")
    })
}
