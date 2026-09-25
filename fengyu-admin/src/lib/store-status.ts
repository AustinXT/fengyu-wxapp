/**
 * 数据中心「在营门店」口径单源（#401）。
 *
 * 口径 = **只看门店组织节点 `org_nodes.is_active`**，取数 SQL、筛选器下拉、#293 停用空态三处同源：
 *   - 节点停用 → 从统计中隐藏（全部历史区间，因为 `is_active` 没有时间轴）
 *   - `stores.is_closed` / `closed_at` **不**参与统计范围判定：它是营业时间轴，只用于时点在营
 *     （门店数按 `opening_date` / `closed_at` 历史化）。若把 `is_closed` 算进范围，关店会连带抹掉
 *     该店关店前的全部历史业绩。
 *   - 关店（`updateStore` 写 `is_closed`）不联动停用节点；要从统计中隐藏须单独停用节点。
 *
 * 另一个概念「可营业」（能否接单 / 预约 / 绑定 / 作库存位）仍按 `is_closed`
 * 或 `is_active AND NOT is_closed` 判定（client/staff 门店列表、库存位 upsert、提货），不归本文件管。
 *
 * staff 端独立副本：`fengyu-staff/cloudfunctions/staffApi/utils/store-status.js`，
 * 一致性由 `__tests__/routes/cross-end-technician-denominator.test.js`（整段等值）
 * + `cross-end-store-status-snapshot.test.js`（数据中心范围禁 is_closed 闭集）守护。
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * 数据中心统一的经营门店集合：仅组织树中已启用的门店节点。
 *
 * `is_active` 没有历史时间轴，按当前状态作用于所有报表时间范围；开闭店的历史口径由
 * 各指标自身的 opening_date / closed_at 条件继续负责。把它放进公共 scope 过滤器，
 * 可避免销售、客量、人效、品项四个板块只修部分查询而再次漂移。
 */
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

/** 门店是否计入数据中心（下拉可选 / 取数范围）。入参是门店组织节点的 `is_active`。 */
export function isDataCenterActiveStore(store: { isActive: boolean }): boolean {
  return store.isActive
}
