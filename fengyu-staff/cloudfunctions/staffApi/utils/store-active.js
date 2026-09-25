/**
 * 门店「在营 / 已停用」判定片段（#400，口径对齐 admin #293）。
 *
 * 「在营」只看门店组织节点 org_nodes.is_active，与管理层取数 SQL 的 activeStoreCondition
 * （routes/mgmt-dashboard.js）同一口径：取数会滤掉节点停用门店的全部数据，照常取数只会满屏 0，
 * 与「在营门店本期无业绩」分不开，所以默认范围要跳过停用门店、显式落到停用门店时出「已停用」空态。
 *
 * ⚠️ 不能把 stores.is_closed 算进来：只关店、节点仍在营的门店，取数 SQL 照样返回它的历史数据，
 * 判成停用会用空态藏掉真实数字。
 *
 * 固定别名：门店表 `s`，门店节点 `store_node`。字面量由
 * `__tests__/routes/cross-end-store-active-snapshot.test.js` 钉住，改动须同步 admin 口径。
 */

/** 门店 → 门店组织节点（LEFT JOIN：缺节点的门店仍能查出，按停用处理，与取数 SQL 一致） */
const STORE_NODE_JOIN = "LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id AND store_node.type = '门店'"

/** 门店是否在营（布尔表达式；须配合 STORE_NODE_JOIN 使用） */
const STORE_IS_ACTIVE = 'COALESCE(store_node.is_active, FALSE)'

module.exports = { STORE_NODE_JOIN, STORE_IS_ACTIVE }
