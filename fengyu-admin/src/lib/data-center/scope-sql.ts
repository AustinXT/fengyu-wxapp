/**
 * 数据中心 scope 过滤 SQL 片段（Drizzle sql 版，供 db.execute 原生聚合查询拼接）
 *
 * ★★ 最关键陷阱：admin 角色的 session.permissions.scopeStoreIds 是**空数组**，
 *    而通用的 buildScopeWhere/scopeCondition 对空数组返回 FALSE → admin 看不到任何数据。
 *    因此 admin 不得把空 scopeStoreIds 误判为无权限；仍需保留下面统一的启用门店过滤。
 *
 * 过滤 = (账号权限范围) AND (UI 选中的 scope)。
 *   - 账号权限：admin 无限制；其他角色用 scopeStoreIds 扁平列表
 *   - UI 选中：authorized → 不再收窄（使用上述账号权限并集）；
 *     market → 子查询展开该市场下门店；store → 直接等值
 * UI 越权（选了权限外的 market/store）由 actions 层 validateScope 提前拦截，SQL 层再兜底。
 *
 * 提成两表（sale_payment_item_allocations / service_commissions）无 store_id，
 * 调用方须先 JOIN sale_items→sale_orders / service_items→service_orders 拿到 store_id 列再传入。
 */
import { sql, type SQL } from 'drizzle-orm'
import { isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope } from './types'
import { orgNodeStoreIdsSubquery } from '@/lib/market-store-sql'

/**
 * 数据中心统一的经营门店集合：仅组织树中已启用的门店节点。
 *
 * `is_active` 没有历史时间轴，按当前状态作用于所有报表时间范围；开闭店的历史口径由
 * 各指标自身的 opening_date / closed_at 条件继续负责。把它放进公共 scope 过滤器，
 * 可避免销售、客量、人效、品项四个板块只修部分查询而再次漂移。
 */
function activeStoreCondition(storeCol: SQL): SQL {
  return sql`
    ${storeCol} IN (
      SELECT active_store.store_id
      FROM stores active_store
      JOIN org_nodes active_node ON active_store.org_node_id = active_node.id
      WHERE active_node.type = '门店'
        AND active_node.is_active = TRUE
    )
  `
}

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
  // 经营统计始终排除当前已停用的门店；即使直接构造停用门店 URL 也只能得到零数据。
  const parts: SQL[] = [activeStoreCondition(col)]

  // 账号权限范围：admin 全开短路，其他角色用扁平 scopeStoreIds
  if (!isAdminScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return sql`FALSE`
    parts.push(sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
  }

  // UI 选中的 scope（进一步收窄）；all / authorized 均不追加条件。
  if (scope.type === 'store') {
    parts.push(sql`${col} = ${scope.id}`)
  } else if (scope.type === 'market') {
    parts.push(
      sql`${col} IN ${orgNodeStoreIdsSubquery(scope.id)}`,
    )
  }

  return sql.join(parts, sql` AND `)
}

/**
 * 无门店员工（直挂组织节点）的可见性片段，与 `scopeFilterSql` 配对用于产能员工池。
 *
 * 背景：品项公司的品项老师、各市场养生部/推广部的员工 `staff_wechat_users.store_id` 为空
 * （直挂市场/部门节点），按 store_id 过滤会被整体挡在员工榜外。2026-09-03 实耗归属改按
 * 服务提成分配后他们能拿到分配额，必须能进榜（见 metrics.md §员工排行榜归属）。
 *
 * 可见性锚 = 员工直挂节点所属市场（`producer_base.anchor_market_id`，调用方负责产出该列）：
 *   - UI 选了具体门店 → 无门店员工不属于任何单店，一律不出现
 *   - UI 选了市场     → 锚定市场等于该市场才出现
 *   - all / authorized → admin 全可见；其他角色按「锚定市场下是否有本账号可见门店」判定
 * 品项公司是总部直属市场节点、其下无门店，因此只有 admin/总部能看到；
 * 养生部锚到南昌凤御，该市场范围的账号可见。
 *
 * @param anchorCol 锚定市场列引用（默认 `pb.anchor_market_id`）
 */
export function orgAnchorScopeSql(
  session: AuthSession,
  scope: DataCenterScope,
  anchorCol = 'pb.anchor_market_id',
): SQL {
  const col = sql.raw(anchorCol)

  // 单店视角：无门店员工不归属任何门店，直接排除
  if (scope.type === 'store') return sql`FALSE`
  // 市场视角：锚定市场须等于所选市场
  if (scope.type === 'market') return sql`${col} = ${scope.id}`

  // all / authorized：admin 全开；其他角色按锚定市场下的可见门店判定
  if (isAdminScope(session)) return sql`TRUE`
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) return sql`FALSE`
  return sql`EXISTS (
    SELECT 1
    FROM stores vs
    JOIN org_nodes vn ON vs.org_node_id = vn.id
    WHERE vn.type = '门店'
      AND vn.is_active = TRUE
      AND vn.parent_id = ${col}
      AND vs.store_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  )`
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
