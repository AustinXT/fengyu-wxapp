import { sql, type SQL } from 'drizzle-orm'

export { DEFAULT_ASSIGNABLE_SKILLS, SERVICE_ORDER_ASSIGNABLE_SKILLS } from '@/lib/service-staff-skills'

/**
 * 员工「锚定市场」SQL 片段（admin 端单源）。技能白名单在 `@/lib/service-staff-skills`（纯 TS，
 * 客户端组件也要用），此处 re-export 方便服务端一处引入。
 *
 * 锚定市场 = 优先取门店父级市场节点；门店为空（直挂市场/部门节点，如各市场养生部、品项公司）
 * 时沿 org_nodes.parent_id 向上取最近的 type='市场' 节点。
 *
 * ⚠️ 两处**刻意保留**的宽松语义（与既有 3 份分配候选副本一致，勿单边收紧造成漂移）：
 *   1. `COALESCE` 是「门店线优先、否则走个人组织节点线」，不是按 `store_id IS NULL` 二分 ——
 *      `store_id` 非空但该门店未挂组织节点时会回退到个人 org_node 线锚定。
 *      `db/migrations/0009` 的 `inventory_sync_location_from_store` 触发器强制门店必挂节点
 *      且父级为市场，故该回退分支在真实数据上不可达。
 *   2. 部门只支持**一层**：`d.type='部门'` 时只看其直接父级是市场还是门店，
 *      「部门挂部门」的深层嵌套会落到 `ELSE NULL` 被静默排除（生产 org_nodes 无此形态）。
 *
 * ⚠️ 跨端副本（**语义同义**；别名与操作数顺序按各端既有副本保留 —— staff 用 `so`、admin 用 `store_node`，
 * 守护测试 `fengyu-staff/.../__tests__/routes/anchor-market-sql-snapshot.test.js` 归一化后比对）：
 *   - fengyu-admin/src/actions/employees.ts（getAllocationEmployeeCandidates 内联副本）
 *   - fengyu-staff/cloudfunctions/staffApi/utils/employee-assignment.js
 *   - fengyu-staff/cloudfunctions/staffApi/routes/allocation.js
 *   - fengyu-staff/cloudfunctions/staffApi/routes/serviceCommission.js
 */

/** 依赖调用方把 staff_wechat_users 别名为 u；产出 employee_market 为员工锚定市场节点 */
export const EMPLOYEE_ANCHOR_MARKET_JOIN: SQL = sql`
    LEFT JOIN stores s ON s.store_id = u.store_id
    LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
    LEFT JOIN org_nodes d ON d.id = u.org_node_id
    LEFT JOIN org_nodes employee_org_parent ON employee_org_parent.id = d.parent_id
    LEFT JOIN org_nodes employee_market ON employee_market.id = COALESCE(
      store_node.parent_id,
      CASE
        WHEN d.type = '市场' THEN d.id
        WHEN d.type = '门店' THEN d.parent_id
        WHEN d.type = '部门' AND employee_org_parent.type = '市场' THEN employee_org_parent.id
        WHEN d.type = '部门' AND employee_org_parent.type = '门店' THEN employee_org_parent.parent_id
        ELSE NULL
      END
    ) AND employee_market.type = '市场'`

/**
 * 目标门店所属市场 JOIN 片段。
 *
 * ⚠️ 全程 LEFT JOIN（既有分配候选副本用的是 INNER JOIN）：`stores.org_node_id` 在 schema 上可空，
 * 一旦目标门店没挂组织节点，INNER JOIN 会让整条查询返回 0 行 ——
 * 候选列表空事小，**校验侧会把本店员工也判成非法**，该门店服务单直接开不出来。
 * 用 LEFT JOIN 则 target_market.id 为 NULL，出差分支自然不成立，本店分支照常放行（优雅降级）。
 *
 * ⚠️ 第三条刻意保留的宽松语义：target_market **不加** `AND type='市场'` 守卫（employee_market 侧有）。
 * 与既有 3 份分配候选副本保持一致；org_nodes.id 唯一，最坏情况只是外援整体不出现，不会误放行。
 */
export function targetMarketJoin(targetStoreId: string): SQL {
  return sql`
    LEFT JOIN stores target_store ON target_store.store_id = ${targetStoreId}
    LEFT JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
    LEFT JOIN org_nodes target_market ON target_market.id = target_store_node.parent_id`
}

/**
 * 「本店 ∪ 同市场出差支援」WHERE 条件。
 * employee_market.id 为空（组织树上挂不到市场）的员工一律排除，避免 NULL = NULL 误放行。
 */
export function marketSupportCondition(targetStoreId: string): SQL {
  return sql`(u.store_id = ${targetStoreId} OR (u.is_on_business_trip = true
        AND employee_market.id IS NOT NULL AND employee_market.id = target_market.id))`
}
