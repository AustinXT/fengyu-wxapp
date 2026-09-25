// utils/store-status.js — 数据中心「在营门店」口径单源（staffApi 内部，#401）
//
// 口径 = **只看门店组织节点 org_nodes.is_active**，取数 SQL 与范围下拉（loadAllMarkets）同源：
//   - 节点停用 → 从统计中隐藏（全部历史区间，is_active 没有时间轴）
//   - stores.is_closed / closed_at **不**参与统计范围判定：它是营业时间轴，只用于时点在营
//     （门店数按 opening_date / closed_at 历史化）。算进范围会连带抹掉关店前的全部历史业绩。
//   - 关店不联动停用节点；要从统计中隐藏须单独停用节点。
//
// 「可营业」（能否接单 / 预约 / 作库存位）是另一概念，仍按 is_closed 或 is_active AND NOT is_closed
// 判定（routes/store.js、staff.js、order.js、inventory.js），不归本文件管。
//
// ⚠️ 本项目禁跨端共享目录（用户已 veto cloudfunctions-shared），本文件**仅供 staffApi 内部**复用；
//    admin 独立副本：fengyu-admin/src/lib/store-status.ts。改这里须同步那边，一致性由
//    __tests__/routes/cross-end-technician-denominator.test.js（整段等值）
//    + __tests__/routes/cross-end-store-status-snapshot.test.js（数据中心范围禁 is_closed 闭集）守护。

/** 当前启用的门店组织节点对应的 store_id 集合（按当前状态作用于全部历史区间）。 */
function activeStoreCondition(column) {
  return `${column} IN (
    SELECT active_store.store_id
    FROM stores active_store
    JOIN org_nodes active_node ON active_store.org_node_id = active_node.id
    WHERE active_node.type = '门店'
      AND active_node.is_active = TRUE
  )`
}

module.exports = { activeStoreCondition }
