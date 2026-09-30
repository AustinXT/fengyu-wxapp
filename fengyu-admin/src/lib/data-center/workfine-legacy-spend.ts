/**
 * WorkFine 历史单（`sale_orders.legacy_source = 'workfine'`）的订单级实收片段（#289，Drizzle sql 版）。
 *
 * 为什么要单独一条分支：WorkFine 单在款项流水（`sale_order_payments` / 业绩事件视图 spe）里**一行都没有**，
 * 只读 spe 的指标跨 2026-07-03 割点时会漏掉这部分消费（见 memory `project-data-timeline-cutoff-20260703`）。
 * 口径照搬 staff 顾客详情页「年度消费 · legacy 分支」（notes/references/metrics.md §staff 顾客档案消费指标）：
 *   金额 = 有明细取明细 `SUM(si.received)`，否则取订单 `o.received`
 *   过滤 = 状态 已支付 / 部分支付 / 已完成 ∩ 销售单 / 转换单 ∩ legacy_source='workfine' ∩ 归属日期落区间且 ≤ 2026-07-03
 *
 * 订单别名固定为 `o`（`sale_orders o`）；scope 与人群条件由调用方另加（本 KPI scope 挂在 `c.bound_store_id` 上）。
 *
 * ⚠️ 四份副本（项目禁止跨端共享代码，靠 consistency.customer.test.ts 整段等值守护）：
 *   1. staff `routes/mgmt-customer.js` 详情页 `legacy_year_stats`
 *   2. staff `routes/customer.js` 详情页 `legacy_year_stats`
 *   3. 本文件（admin 客量板新客客单价：KPI `queryNewMemberLegacySpend` + 明细 `newmem_legacy_spend` 共用）
 *   4. staff `routes/mgmt-traffic.js` `queryNewMemberLegacySpend`
 * 金额表达式四份同源；本文件与 mgmt-traffic 的新客客单价分支另加 #471 日期割点，顾客详情年度消费不受影响。
 */
import { sql, type SQL } from 'drizzle-orm'
import type { ResolvedRange } from './types'

/** WorkFine 历史单订单级实收合计（聚合表达式，调用方自带 `AS 列名`） */
export function workfineLegacyReceivedSumSql(): SQL {
  return sql`
    COALESCE(SUM(
      CASE
        WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
        THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
        ELSE o.received::numeric
      END
    ), 0)`
}

/** 新客客单价的 WorkFine 历史单过滤；只接入 2026-07-03 及以前的旧源 */
export function workfineLegacyOrderSql(range: ResolvedRange): SQL {
  return sql`
      o.status IN ('已支付', '部分支付', '已完成')
      AND o.sale_order_type IN ('销售单', '转换单')
      AND o.legacy_source = 'workfine'
      AND o.performance_attribution_date BETWEEN ${range.start} AND ${range.end}
      AND o.performance_attribution_date <= DATE '2026-07-03'
  `
}
