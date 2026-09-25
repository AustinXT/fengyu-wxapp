/**
 * 经营分析「在营门店」口径（#421，跟随数据中心 #401）。
 *
 * 口径 = **只看门店组织节点 `org_nodes.is_active`**，范围下拉与取数 SQL 同源：
 *   - 节点停用 → 从下拉与全部指标中隐藏（全部历史区间，`is_active` 没有时间轴）
 *   - 门店的关店标记不参与：它是营业时间轴，算进范围会抹掉关店前的全部历史业绩
 *     （本目录源码连注释都不出现该字段名，staff `cross-end-store-status-snapshot.test.js` 按原文扫描闭集）
 *   - 门店为空 / 悬空的行（如未绑定门店的会员）同样不计入，与 admin 数据中心一致
 *
 * analyst 是独立部署的站点，本文件是 admin `fengyu-admin/src/lib/store-status.ts` 的**独立副本**
 * （根 CLAUDE.md：禁止跨端共享代码目录；staff 另有 `utils/store-status.js`，共三份）。一致性由
 * `src/lib/__tests__/store-status-cross-end.test.ts`（不进 CI，#382）与 staff
 * `__tests__/routes/cross-end-store-active-snapshot.test.js` / `cross-end-store-status-snapshot.test.js`
 * （staffApi 全量在 CI 跑）的字面量整段等值 + 闭集守护。
 */
import { sql, type SQL } from "drizzle-orm"

/** 经营分析统一的在营门店集合：仅组织树中已启用的门店节点。 */
export function activeStoreCondition(storeCol: SQL): SQL {
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
