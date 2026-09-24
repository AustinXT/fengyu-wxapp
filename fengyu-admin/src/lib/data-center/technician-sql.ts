import { sql, type SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope } from '@/lib/data-center/types'
import { scopeFilterSql, orgAnchorScopeSql } from '@/lib/data-center/scope-sql'

/**
 * 「产能技师」人池 —— 数据中心**所有人均派生指标的分母单源**（#285）。
 *
 * 口径：`skills && ARRAY['美容师','养生师']` ∩ 区间末在职历史化
 *   （`hired_at <= 区间末` ∩ `(resigned_at IS NULL OR resigned_at > 区间末)`），
 * 对齐 `notes/references/metrics.md` §派生指标的 `employeeCount`。
 *
 * ## 为什么不能只按 `staff_wechat_users.store_id` 过滤
 *
 * 员工组织归属是**双轨**的：`store_id`（门店 FK）+ `org_node_id`（组织节点 FK，
 * 可指向 部门/市场/门店 任一类型）。只认 `store_id` 会整体漏掉直挂市场/部门的人。
 * 2026-09 生产实测：在职产能技师 **164** 人，只按 `store_id` 数到 **150**，
 * 漏掉的 14 人里 12 人直挂各市场「养生部」、1 人直挂「品项公司」市场节点、
 * 1 人直挂门店组织节点但 `store_id` 为空。
 * 他们的产出**落在门店上、计入分子**，人头却不进分母 → 所有人均指标虚高 **+9.33%**。
 * 详见 memory `project-employee-org-direct-attach-market`。
 *
 * ## 归属规则（与 `efficiency.ts` Part D `producer_base` 逐条对齐）
 *
 * 1. `COALESCE(sw.store_id, ds.store_id)` —— 直挂**门店组织节点**的人回收进该门店
 * 2. 回收后仍为 NULL 的（直挂市场/部门）用 `anchor_market_id` 锚到市场，
 *    交给 `orgAnchorScopeSql` 判可见性 —— **单店 scope 下它返回 FALSE**，
 *    即选中单个门店时直挂员工不出现（与员工榜同语义）。
 *    故 `集团技师数 ≠ Σ门店技师数`，这是有意的。
 *
 * ## ⚠️ 这是单源，别在别处再抄一份
 *
 * #285 之前 `efficiency.ts`（人效板）与 `sales.ts`（销售板）各写了一份只按 `store_id`
 * 过滤的查询。只修其中一处会让**同一个数据中心的两个板块技师数差 14 人**
 * （闸门 2 codex round-2 判 P0）。两处必须共用本模块。
 */
/**
 * 人池。缺省 `producer`（产能技师，上面那套口径，所有人均派生分母用它）。
 *
 * `beautician` 只收窄技能条件为「含美容师」（经营数据主表 D 列「美容师人数」，#372）：
 * 在职历史化、双轨归属、scope 可见性与 `producer` 完全相同——只是换一组技能，不是另一套口径。
 * 技能条件写成两个 SQL 字面量而不是绑定数组参数：drizzle 模板里裸数组会被摊开成多个参数
 * （见 memory reference-drizzle-sql-bare-array-splices），且 `producer` 的字面量有一致性守护在盯。
 */
export type TechnicianPool = 'producer' | 'beautician'

function skillFilterSql(pool: TechnicianPool): SQL {
  return pool === 'beautician'
    ? sql`sw.skills && ARRAY['美容师']::text[]`
    : sql`sw.skills && ARRAY['美容师','养生师']::text[]`
}

export function technicianCteSql(
  session: AuthSession,
  scope: DataCenterScope,
  endDate: string,
  pool: TechnicianPool = 'producer',
): SQL {
  return sql`
      technician_base AS (
        SELECT sw.employee_id,
               COALESCE(sw.store_id, ds.store_id) AS store_id,
               CASE WHEN o.type = '市场' THEN o.id
                    WHEN op.type = '市场' THEN op.id
                    ELSE NULL END AS anchor_market_id,
               CASE WHEN o.type = '市场' THEN o.name
                    WHEN op.type = '市场' THEN op.name END AS anchor_market_name
        FROM staff_wechat_users sw
        LEFT JOIN org_nodes o ON o.id = sw.org_node_id
        LEFT JOIN org_nodes op ON op.id = o.parent_id
        LEFT JOIN stores ds ON ds.org_node_id = sw.org_node_id
        WHERE ${skillFilterSql(pool)}
          AND sw.hired_at IS NOT NULL
          AND sw.hired_at::date <= ${endDate}
          AND (sw.resigned_at IS NULL OR sw.resigned_at::date > ${endDate})
      ),
      technician_scoped AS (
        SELECT tb.employee_id, tb.store_id, tb.anchor_market_id, tb.anchor_market_name
        FROM technician_base tb
        WHERE (tb.store_id IS NOT NULL AND ${scopeFilterSql(session, scope, 'tb.store_id')})
           OR (tb.store_id IS NULL AND ${orgAnchorScopeSql(session, scope, 'tb.anchor_market_id')})
      )
    `
}

/** 产能技师总数（人均派生分母） */
export function technicianCountSql(
  session: AuthSession,
  scope: DataCenterScope,
  endDate: string,
): SQL {
  return sql`
      WITH ${technicianCteSql(session, scope, endDate)}
      SELECT COUNT(*)::int AS v FROM technician_scoped
    `
}

/** 产能技师数 by store（**仅**有门店归属的那部分）；`pool='beautician'` 时为美容师人数 */
export function technicianByStoreSql(
  session: AuthSession,
  scope: DataCenterScope,
  endDate: string,
  pool: TechnicianPool = 'producer',
): SQL {
  return sql`
      WITH ${technicianCteSql(session, scope, endDate, pool)}
      SELECT store_id, COUNT(*)::int AS v
      FROM technician_scoped
      WHERE store_id IS NOT NULL
      GROUP BY store_id
    `
}

/**
 * 产能技师数 by market（**仅**直挂市场/部门、无门店归属的那部分）。
 *
 * 必须单独出一份：byMarket 装配是逐门店累加的，`store_id IS NULL` 的人没有任何门店可挂，
 * 只按 store 汇总会把他们又丢一次（这正是 #285 分母缺口的成因）。
 * `market_name` 一并带出，因为「品项公司」这类市场底下一个门店都没有，
 * 不会出现在门店骨架里，拿不到名字。
 *
 * ⚠️ **已知且有意的口径缺口**：本查询要求 `anchor_market_id IS NOT NULL`，而
 * `technician_scoped` 的无门店分支走 `orgAnchorScopeSql` —— 后者在「admin + scope=all」时
 * 直接返回 `TRUE`，**不要求锚得到市场**。于是「既无门店、又锚不到市场」的产能技师会进
 * 总数却进不了任何 market 行 → `技师总数 ≥ Σ byMarket 技师数`。
 *
 * 不收紧 `technician_scoped` 是有意的：那会把一名真实的产能技师从集团口径里整个抹掉，
 * 比「集团 ≥ 各市场之和」更糟；也会与 `producer_employees` 的人池定义分叉。
 * 2026-09-23 生产实测该类人数为 **0**（13 名无门店技师全部锚得到市场），当前两数恒等。
 */
export function technicianDirectByMarketSql(
  session: AuthSession,
  scope: DataCenterScope,
  endDate: string,
): SQL {
  return sql`
      WITH ${technicianCteSql(session, scope, endDate)}
      SELECT anchor_market_id AS market_id,
             MAX(anchor_market_name) AS market_name,
             COUNT(*)::int AS v
      FROM technician_scoped
      WHERE store_id IS NULL AND anchor_market_id IS NOT NULL
      GROUP BY anchor_market_id
    `
}
