import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { clientWechatUsers } from '@db/user'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'

/** 顾客在开单时可购买组合套餐的市场范围。 */
export type CustomerBundleMarketScope =
  | { type: 'globalOnly' }
  | { type: 'allConfigured' }
  | { type: 'market'; marketId: string; marketName: string }

const GLOBAL_ONLY_SCOPE: CustomerBundleMarketScope = { type: 'globalOnly' }

/**
 * 按顾客实时绑定门店解析套餐市场范围。
 *
 * 临时跨店顾客不受单一市场限制，但仍不应看到空白 market_scope 的套餐。
 * 未绑定门店、无效门店或找不到顾客时，保守地只允许全市场套餐。
 */
export async function resolveCustomerBundleMarketScope(
  clientUserId: string | null | undefined,
): Promise<CustomerBundleMarketScope> {
  if (!clientUserId) return GLOBAL_ONLY_SCOPE

  // Drizzle 0.45 的 alias 类型推导与 leftJoin 不兼容，沿用项目内既有 cast 写法。
  const storeNode = alias(orgNodes, 'bundle_scope_store_node') as unknown as typeof orgNodes
  const marketNode = alias(orgNodes, 'bundle_scope_market_node') as unknown as typeof orgNodes
  const [row] = await db
    .select({
      isCrossStoreTemp: clientWechatUsers.isCrossStoreTemp,
      marketId: marketNode.id,
      marketName: marketNode.name,
    })
    .from(clientWechatUsers)
    .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(
      marketNode,
      and(eq(storeNode.parentId, marketNode.id), eq(marketNode.type, '市场'))!,
    )
    .where(eq(clientWechatUsers.userId, clientUserId))
    .limit(1)

  if (row?.isCrossStoreTemp) return { type: 'allConfigured' }
  if (!row?.marketId || !row.marketName) return GLOBAL_ONLY_SCOPE

  return {
    type: 'market',
    marketId: row.marketId,
    marketName: row.marketName,
  }
}

function normalizedScopeValues(marketScopeColumn: PgColumn): SQL {
  return sql`string_to_array(regexp_replace(${marketScopeColumn}, '[[:space:]]+', '', 'g'), ',')`
}

/**
 * products.market_scope 的统一可见性条件：
 * - NULL：全市场可见；
 * - 空字符串/纯空白：任何市场不可见；
 * - 逗号分隔市场 org_nodes.id，兼容历史市场名，比较时忽略空白。
 */
export function bundleMarketScopeCondition(
  marketScopeColumn: PgColumn,
  scope: CustomerBundleMarketScope,
): SQL {
  const globalCondition = isNull(marketScopeColumn)
  const scopeValues = normalizedScopeValues(marketScopeColumn)
  const nonBlankScope = sql`NULLIF(regexp_replace(${marketScopeColumn}, '[[:space:]]+', '', 'g'), '') IS NOT NULL`

  if (scope.type === 'globalOnly') return globalCondition
  if (scope.type === 'allConfigured') return or(globalCondition, nonBlankScope)!

  const normalizedMarketName = scope.marketName.replace(/\s+/g, '')
  return or(
    globalCondition,
    sql`${nonBlankScope} AND (
      ${scope.marketId} = ANY(${scopeValues})
      OR ${normalizedMarketName} = ANY(${scopeValues})
    )`,
  )!
}
