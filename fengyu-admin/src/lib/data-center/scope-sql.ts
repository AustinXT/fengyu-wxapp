
import { sql, type SQL } from 'drizzle-orm'
import { isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope } from './types'


export function scopeFilterSql(
  session: AuthSession,
  scope: DataCenterScope,
  storeCol = 'so.store_id',
): SQL {
  const col = sql.raw(storeCol)
  const parts: SQL[] = []

  
  if (!isAdminScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return sql`FALSE`
    parts.push(sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
  }

  
  if (scope.type === 'store') {
    parts.push(sql`${col} = ${scope.id}`)
  } else if (scope.type === 'market') {
    parts.push(
      sql`${col} IN (SELECT s.store_id FROM stores s JOIN org_nodes o ON s.org_node_id = o.id WHERE o.parent_id = ${scope.id} AND o.type = '门店')`,
    )
  }

  if (parts.length === 0) return sql`TRUE`
  return sql.join(parts, sql` AND `)
}


export function scopeStoreSkeletonSql(session: AuthSession, scope: DataCenterScope): SQL {
  return sql`
    SELECT s.store_id, s.store_name, o_mkt.id AS market_id, o_mkt.name AS market_name
    FROM stores s
    JOIN org_nodes o_store ON s.org_node_id = o_store.id AND o_store.type = '门店'
    JOIN org_nodes o_mkt ON o_store.parent_id = o_mkt.id
    WHERE ${scopeFilterSql(session, scope, 's.store_id')}
  `
}
