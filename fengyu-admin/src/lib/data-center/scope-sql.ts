/**
 * 数据中心 scope 过滤 SQL 片段（Drizzle sql 版，供 db.execute 原生聚合查询拼接）
 *
 * ★★ 最关键陷阱：admin 角色的 session.permissions.scopeStoreIds 是**空数组**，
 *    而通用的 buildScopeWhere/scopeCondition 对空数组返回 FALSE → admin 看不到任何数据。
 *    因此本函数第一步必须 isAdminScope(session) → sql`TRUE` 短路
 *    （对齐 staff buildSaleScope('all') 返回 'TRUE'）。这是 scope-sql.test.ts 必守的第一项。
 *
 * 过滤 = (账号权限范围) AND (UI 选中的 scope)。
 *   - 账号权限：admin 无限制；其他角色用 scopeStoreIds 扁平列表
 *   - UI 选中：market → 子查询展开该市场下门店；store → 直接等值
 * UI 越权（选了权限外的 market/store）由 actions 层 validateScope 提前拦截，SQL 层再兜底。
 *
 * 提成两表（sale_allocations / service_commissions）无 store_id，
 * 调用方须先 JOIN sale_items→sale_orders / service_items→service_orders 拿到 store_id 列再传入。
 */
import { sql, type SQL } from 'drizzle-orm'
import { isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope } from './types'

/**
 * 构造 store_id 维度的 scope 过滤片段。
 * @param storeCol 门店列引用（如 'so.store_id' / 'c.bound_store_id' / 's.store_id'）
 */
export function scopeFilterSql(
  session: AuthSession,
  scope: DataCenterScope,
  storeCol = 'so.store_id',
): SQL {
  const col = sql.raw(storeCol)
  const parts: SQL[] = []

  // 账号权限范围：admin 全开短路，其他角色用扁平 scopeStoreIds
  if (!isAdminScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return sql`FALSE`
    parts.push(sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
  }

  // UI 选中的 scope（进一步收窄）
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

/**
 * 按市场/按门店明细表的「关系骨架 + scope」基底。
 * 返回的片段用于 `FROM (...) base`：列出 scope 内所有门店及其所属市场，
 * 即使该门店当期零业绩也出行（明细表/排名榜 LEFT JOIN 用）。
 *
 * 产出列：store_id, store_name, market_id, market_name
 */
export function scopeStoreSkeletonSql(session: AuthSession, scope: DataCenterScope): SQL {
  return sql`
    SELECT s.store_id, s.store_name, o_mkt.id AS market_id, o_mkt.name AS market_name
    FROM stores s
    JOIN org_nodes o_store ON s.org_node_id = o_store.id AND o_store.type = '门店'
    JOIN org_nodes o_mkt ON o_store.parent_id = o_mkt.id
    WHERE ${scopeFilterSql(session, scope, 's.store_id')}
  `
}
