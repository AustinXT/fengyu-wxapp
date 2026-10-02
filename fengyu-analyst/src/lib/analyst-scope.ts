import { db } from "../db"
import { orgNodes, stores } from "../../../db/schema/org"
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { AuthSession } from "./types"
// 在营口径（#421，跟随数据中心 #401）：只看门店组织节点 is_active，不看门店关店标记
import { activeStoreCondition } from "./store-status"

export type AnalystScope =
  | { type: "all" }
  | { type: "market"; id: string }
  | { type: "store"; id: string }

export interface AnalystScopeStore {
  storeId: string
  storeName: string
}

export interface AnalystScopeMarket {
  id: string
  name: string
  stores: AnalystScopeStore[]
}

export interface AnalystScopeOptions {
  topLevel: "all" | "market" | "store"
  markets: AnalystScopeMarket[]
}

export function hasGlobalAnalystScope(session: AuthSession): boolean {
  return session.roles.some((role) => role.role === "admin" || role.scopeType === "总部")
}

export function getAnalystScopeTopLevel(session: AuthSession): AnalystScopeOptions["topLevel"] {
  if (hasGlobalAnalystScope(session)) return "all"
  if (session.roles.some((role) => role.scopeType === "市场")) return "market"
  return "store"
}

export async function expandVisibleMarketIds(session: AuthSession): Promise<string[] | null> {
  if (hasGlobalAnalystScope(session)) return null

  const marketIds = new Set<string>()
  const storeScopeNodeIds: string[] = []

  for (const role of session.roles) {
    if (role.scopeType === "市场") {
      marketIds.add(role.scopeId)
    } else if (role.scopeType === "门店") {
      storeScopeNodeIds.push(role.scopeId)
    }
  }

  if (storeScopeNodeIds.length > 0) {
    const parentRows = await db
      .select({ parentId: orgNodes.parentId })
      .from(orgNodes)
      .where(and(inArray(orgNodes.id, storeScopeNodeIds), eq(orgNodes.type, "门店")))

    for (const row of parentRows) {
      if (row.parentId) marketIds.add(row.parentId)
    }
  }

  return Array.from(marketIds)
}

export async function getAnalystScopeOptions(session: AuthSession): Promise<AnalystScopeOptions> {
  const topLevel = getAnalystScopeTopLevel(session)
  const visibleMarketIds = await expandVisibleMarketIds(session)
  const seeAll = visibleMarketIds === null

  if (!seeAll && visibleMarketIds.length === 0) {
    return { topLevel, markets: [] }
  }

  const marketRows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(
      and(
        eq(orgNodes.type, "市场"),
        seeAll ? undefined : inArray(orgNodes.id, visibleMarketIds),
      ),
    )
    .orderBy(asc(orgNodes.sortOrder), asc(orgNodes.name))

  const storeNode = alias(orgNodes, "analyst_scope_store_node")
  const storeRows = await db
    .select({
      storeId: stores.storeId,
      storeName: stores.storeName,
      marketId: storeNode.parentId,
    })
    .from(stores)
    .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .where(
      and(
        eq(storeNode.type, "门店"),
        eq(storeNode.isActive, true),
        seeAll
          ? undefined
          : session.permissions.scopeStoreIds.length > 0
            ? inArray(stores.storeId, session.permissions.scopeStoreIds)
            : eq(stores.storeId, "__none__"),
      ),
    )
    .orderBy(asc(stores.storeName))

  const markets = marketRows.map((market) => ({
    id: market.id,
    name: market.name,
    stores: storeRows
      .filter((store) => store.marketId === market.id)
      .map((store) => ({ storeId: store.storeId, storeName: store.storeName })),
  }))

  return {
    topLevel,
    // 门店级账号的市场只是其门店的父节点：门店全部停用后该市场没有可看的数据，不再列出，
    // 否则默认范围会落到零数据的市场，而不是「暂无可查看的数据范围」（#421）
    markets: topLevel === "store" ? markets.filter((market) => market.stores.length > 0) : markets,
  }
}

export function parseAnalystScope(raw: { scope?: string | null; scopeId?: string | null }): AnalystScope {
  if (raw.scope === "market" && raw.scopeId) return { type: "market", id: raw.scopeId }
  if (raw.scope === "store" && raw.scopeId) return { type: "store", id: raw.scopeId }
  return { type: "all" }
}

export async function resolveAnalystScopeFromParams(
  raw: {
    scope?: string | null
    scopeId?: string | null
    market?: string | null
    store?: string | null
  },
): Promise<AnalystScope> {
  if (raw.scope || raw.scopeId) return parseAnalystScope(raw)

  const legacyStoreName = raw.store?.trim()
  if (legacyStoreName) {
    const [row] = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .where(eq(stores.storeName, legacyStoreName))
      .limit(1)
    if (row?.storeId) return { type: "store", id: row.storeId }
  }

  const legacyMarketName = raw.market?.trim()
  if (legacyMarketName) {
    const [row] = await db
      .select({ id: orgNodes.id })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, "市场"), eq(orgNodes.name, legacyMarketName)))
      .limit(1)
    if (row?.id) return { type: "market", id: row.id }
  }

  return { type: "all" }
}

export function getDefaultAnalystScope(options: AnalystScopeOptions): AnalystScope | null {
  if (options.topLevel === "all") return { type: "all" }

  const firstMarket = options.markets[0]
  if (!firstMarket) return null

  if (options.topLevel === "store") {
    const firstStore = firstMarket.stores[0]
    if (firstStore) return { type: "store", id: firstStore.storeId }
  }

  return { type: "market", id: firstMarket.id }
}

export function getEffectiveAnalystScope(
  scope: AnalystScope,
  options: AnalystScopeOptions,
): AnalystScope | null {
  if (scope.type === "all" && options.topLevel !== "all") return getDefaultAnalystScope(options)
  return scope
}

export function analystScopeSearchParams(scope: AnalystScope): Record<string, string> {
  if (scope.type === "all") return { scope: "all", scopeId: "" }
  return { scope: scope.type, scopeId: scope.id }
}

export function analystScopeCacheKey(session: AuthSession, scope: AnalystScope): string {
  const accountScope = hasGlobalAnalystScope(session)
    ? "global"
    : [...session.permissions.scopeStoreIds].sort().join(",") || "__none__"
  const selectedScope = scope.type === "all" ? "all" : `${scope.type}:${scope.id}`
  return `${accountScope}|${selectedScope}`
}

export function getAnalystScopeLabel(scope: AnalystScope, options: AnalystScopeOptions): string {
  if (scope.type === "all") return "全部"
  if (scope.type === "market") {
    return options.markets.find((market) => market.id === scope.id)?.name ?? "未知市场"
  }
  for (const market of options.markets) {
    const store = market.stores.find((item) => item.storeId === scope.id)
    if (store) return store.storeName
  }
  return "未知门店"
}

/**
 * 验证 scope 权限（基于已查询的 options，避免重复查询）
 */
export function validateAnalystScopeWithOptions(
  session: AuthSession,
  scope: AnalystScope,
  options: AnalystScopeOptions,
): void {
  if (hasGlobalAnalystScope(session)) return

  if (scope.type === "all") {
    throw new Error("PERMISSION_DENIED: 无权查看全部数据")
  }

  if (scope.type === "market") {
    if (options.markets.some((market) => market.id === scope.id)) return
    throw new Error("PERMISSION_DENIED: 越权访问其他市场数据")
  }

  if (scope.type === "store") {
    for (const market of options.markets) {
      if (market.stores.some((store) => store.storeId === scope.id)) return
    }
    throw new Error("PERMISSION_DENIED: 越权访问其他门店数据")
  }
}

const VALID_COLUMN_NAME = /^[a-zA-Z_][a-zA-Z0-9_.]*$/

/**
 * 统计口径的门店过滤：在营门店（#421，跟随数据中心 #401）AND 账号权限 AND 所选范围。
 * 所有「计入哪些数据」的条件都走它；只有「首次」基线（新客首单 / 复购首次进入）走 `scopeRangeSql`。
 */
export function scopeFilterSql(
  session: AuthSession,
  scope: AnalystScope,
  storeCol = "so.store_id",
): SQL {
  const range = scopeRangeParts(session, scope, storeCol)
  if (!range) return sql`FALSE`
  // 统计始终排除当前已停用的门店；直接构造停用门店 URL 也只能得到零数据。
  return sql.join([activeStoreCondition(range.col), ...range.parts], sql` AND `)
}

/**
 * 只含账号权限 + 所选范围、**不含在营过滤**的门店条件，仅供「首次」基线使用（#421 拍板：首单判定用全历史）。
 *
 * 停用门店的历史单仍参与判定「是不是第一次」，否则在停用门店买过的老顾客换到在营门店后会被误判成新客 /
 * 首次进入；调用方必须在归属门店上另叠 `activeStoreCondition`，停用门店的顾客才不会出现在结果里。
 */
export function scopeRangeSql(
  session: AuthSession,
  scope: AnalystScope,
  storeCol = "so.store_id",
): SQL {
  const range = scopeRangeParts(session, scope, storeCol)
  if (!range) return sql`FALSE`
  return range.parts.length > 0 ? sql.join(range.parts, sql` AND `) : sql`TRUE`
}

/** 账号权限 + 所选范围的条件片段；账号无任何可见门店时返回 null（调用方输出 FALSE） */
function scopeRangeParts(
  session: AuthSession,
  scope: AnalystScope,
  storeCol: string,
): { col: SQL; parts: SQL[] } | null {
  if (!VALID_COLUMN_NAME.test(storeCol)) {
    throw new Error(`INVALID_PARAMS: invalid storeCol parameter: ${storeCol}`)
  }
  const col = sql.raw(storeCol)
  const parts: SQL[] = []

  if (!hasGlobalAnalystScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return null
    parts.push(sql`${col} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
  }

  if (scope.type === "store") {
    parts.push(sql`${col} = ${scope.id}`)
  } else if (scope.type === "market") {
    parts.push(sql`${col} IN (
      SELECT s.store_id
      FROM stores s
      JOIN org_nodes o ON o.id = s.org_node_id
      WHERE o.type = '门店'
        AND o.parent_id = ${scope.id}
    )`)
  }

  return { col, parts }
}
