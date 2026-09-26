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
 *     market → 子查询展开该市场下门店；store → 直接等值；stores → 所选子集 IN（#376）
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
// 在营口径单源（#401）：只看门店组织节点 is_active，不看门店关店标记
import { activeStoreCondition } from '@/lib/store-status'

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
  } else if (scope.type === 'stores') {
    // 多店（#376）：所选子集；越权 id 已被 validateScope 拒掉，上面的权限 IN 再兜底
    parts.push(sql`${col} IN (${sql.join(scope.ids.map((i) => sql`${i}`), sql`, `)})`)
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
 *   - UI 选了市场     → 锚定市场等于该市场才出现；该市场若只是门店级账号的**祖先市场**（未直接授权），
 *                       另须「锚定市场下有本账号可见的在营门店」——与 authorized 同一条可见性（#399），
 *                       即选祖先市场看到的直挂员工 ⊆ 汇总范围看到的，不会更多
 *   - all / authorized → 超管或持总部范围全可见（#334，与 staff `all` 恒真一致）；
 *                        其他角色按「锚定市场下是否有本账号可见的在营门店」判定
 *   - 多店（#376）     → 锚定市场下至少有一家**所选**在营门店（非超管再与授权门店取交集）才出现
 * 品项公司是总部直属市场节点、其下无门店：超管/总部账号在汇总范围可见，直接授权到品项公司的账号以市场范围可见（#399）；
 * 市场级 / 门店级账号的汇总范围看不到它（锚定市场下没有可见的在营门店）。
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
  // 市场视角：锚定市场须等于所选市场。直接授权的市场（或超管）到此为止；只是门店级账号祖先市场的，
  // 另叠「锚定市场下有本账号可见的在营门店」——与 authorized 同一条可见性，选市场不会比汇总多看到人（#399）。
  // 注意：店长所属市场下有他的在营门店时，该市场的直挂员工（养生部等）本就在 authorized 里可见，这是既有设计；
  // 这里防的是「所属市场下已没有他可见的在营门店」（唯一门店停用）时仍按市场看到整个市场的直挂员工。
  if (scope.type === 'market') {
    if (isGrantedMarketScope(session, scope.id)) return sql`${col} = ${scope.id}`
    return sql`${col} = ${scope.id} AND ${visibleActiveAnchorSql(session, col)}`
  }

  // 多店（#376）：锚定市场下至少有一家所选的在营门店才出现——authorized 的同一条可见性按所选子集收窄。
  // 注意与单店（上面恒 FALSE）的跳变：选 1 家不见直挂员工、选同市场 2 家则可见；所选里部分停用、只剩 1 家在营时
  // 仍按多店判定（可见）。这是拍板规则「锚定市场下有所选门店」的直接推论，见 metrics.md #376 变更记录。
  if (scope.type === 'stores') {
    const ids = isAdminScope(session)
      ? scope.ids
      : scope.ids.filter((id) => session.permissions.scopeStoreIds.includes(id))
    return activeAnchorAmongSql(ids, col)
  }

  // all / authorized：超管或持总部范围 → 全开（#334）；其他角色按锚定市场下的可见门店判定。
  // 判定与 getScopeTopLevel / validateScope（context.ts）逐字相同、与 staff `all` 恒真对齐：总部账号本就看全集团，
  // 锚定市场下有没有在营门店与它无关（品项公司即此例）。session 已被 withPermission 收窄到授予本动作的角色
  // （缺角色元数据的旧快照不收窄——那时 validateScope / scopeFilterSql 同样按总部放行，口径一致）。
  if (isAdminScope(session) || session.roles.some((r) => r.scopeType === '总部')) return sql`TRUE`
  return visibleActiveAnchorSql(session, col)
}

/**
 * 市场是否直接授权给本账号（超管恒真）：角色范围展开后的组织节点含该市场。
 * 与数据中心范围下拉的 `granted`（lib/permissions expandMarketVisibility）同源——门店级账号补进来的
 * 祖先市场不在 scopeOrgNodeIds 里。旧会话缺 scopeOrgNodeIds 时按未授权处理（保守，走可见门店判定）。
 */
function isGrantedMarketScope(session: AuthSession, marketId: string): boolean {
  return isAdminScope(session) || (session.permissions.scopeOrgNodeIds ?? []).includes(marketId)
}

/**
 * 锚定市场下存在本账号可见的**在营**门店（市场 / 门店级账号的 all / authorized 与祖先市场共用）。
 * 无授权门店时恒 FALSE。
 */
function visibleActiveAnchorSql(session: AuthSession, col: SQL): SQL {
  return activeAnchorAmongSql(session.permissions.scopeStoreIds, col)
}

/** 锚定市场下存在 `ids` 中的**在营**门店；空集恒 FALSE。 */
function activeAnchorAmongSql(ids: readonly string[], col: SQL): SQL {
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

/**
 * 范围内是否有在营门店（#423）。与 `scopeStoreSkeletonSql` 同一骨架，人效板直接用骨架行数判定，二者必须一致。
 *
 * 无门店范围（总部选品项公司市场、只授权品项公司的 hr 账号）下，人均类 KPI 的分子走门店口径恒为 0，
 * 分母却经 `orgAnchorScopeSql` 收进直挂技师 → `0 / N` 显示 0.00，与员工榜的员工分配额对不上。
 * 口径拍板（#423 方案 A）：这种范围下人均显示「--」并加说明，不改分子口径。
 * 只要范围内还有门店，人均照常计算。
 *
 * 产出列：has_store（boolean）
 */
export function scopeHasStoreSql(session: AuthSession, scope: DataCenterScope): SQL {
  return sql`SELECT EXISTS (${scopeStoreSkeletonSql(session, scope)}) AS has_store`
}
