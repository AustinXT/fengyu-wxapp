import { sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/**
 * 组织节点自身及全部后代的 SQL 子查询。path 既去重也阻断异常循环数据。
 *
 * PostgreSQL 允许把 WITH RECURSIVE 放在 IN 子查询内，调用侧仍保持参数化，不需要拼接节点 ID。
 */
export function descendantOrgNodeIdsSubquery(rootNodeId: string): SQL {
  return sql`(
    WITH RECURSIVE descendants(id, path) AS (
      SELECT ${rootNodeId}::text, ARRAY[${rootNodeId}::text]
      UNION ALL
      SELECT child.id, descendants.path || child.id
      FROM org_nodes child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT id FROM descendants
  )`
}

/** 返回某组织节点子树内所有关联门店的子查询。 */
export function orgNodeStoreIdsSubquery(rootNodeId: string): SQL {
  return sql`(
    SELECT s.store_id
    FROM stores s
    WHERE s.org_node_id IN ${descendantOrgNodeIdsSubquery(rootNodeId)}
  )`
}

/** 任意组织节点列是否落在指定组织节点子树内。 */
export function orgNodeInScopeCondition(
  orgNodeIdColumn: PgColumn,
  rootNodeId: string,
): SQL {
  return sql`${orgNodeIdColumn} IN ${descendantOrgNodeIdsSubquery(rootNodeId)}`
}

/** 任意门店列是否落在指定组织节点子树内。 */
export function storeInOrgNodeCondition(
  storeIdColumn: PgColumn,
  rootNodeId: string,
): SQL {
  return sql`${storeIdColumn} IN ${orgNodeStoreIdsSubquery(rootNodeId)}`
}

/**
 * 兼容现有“市场筛选”调用名。市场是组织节点，语义现已统一为市场自身及全部下属节点。
 */
export function marketStoreIdsSubquery(marketId: string): SQL {
  return orgNodeStoreIdsSubquery(marketId)
}

export function storeInMarketCondition(
  storeIdColumn: PgColumn,
  marketId: string,
): SQL {
  return storeInOrgNodeCondition(storeIdColumn, marketId)
}
