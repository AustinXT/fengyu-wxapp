/**
 * 款项业绩归属日期的单一口径（JS 版与 SQL 版并置，禁止任一侧单独漂移）。
 *
 * 口径定义（与 DB 视图 `sale_item_performance_events.performance_date` 同源）：
 * - `首次支付` → 跟随订单级 `sale_orders.performance_attribution_date`；
 * - 其余款项 → `sale_order_payments.performance_attribution_date`，缺失时按 `paid_at`
 *   折算上海自然日（迁移 0038 的 trigger 会在入账时写入，历史行靠 COALESCE 兜底）。
 *
 * 迁移 0039 起，`sale_order_payments.performance_attribution_date` 由 trigger 保证恒有值
 * （首次支付镜像订单级，未入账按 created_at 占位）。这里仍保留 CASE/COALESCE 而不是直接读列，
 * 理由有二：
 * 1. 代码部署与 migration apply 是两步，回款筛选必须在迁移落地前就语义正确；
 * 2. 首次支付那一支恒以**订单级**为准，即使镜像列因故漂移，读出来的仍是权威值。
 * 迁移落地后两者恒等，任何一侧改动都必须让两者继续恒等。
 *
 * prod 实测（2026-09-11，迁移 0039 之前）：首次支付行的款项级列 100% 为 NULL，
 * 未入账（已作废 / 待审批）行 `paid_at` 与款项级列同为 NULL。
 */
import { sql, type SQL } from 'drizzle-orm'
import { saleOrderPayments, saleOrders } from '@db/order'
import { fmtDate } from '@/lib/datetime'

/**
 * 款项业绩归属日期（JS 版；回款明细导出与营业额分配导出共用，防两处漂移）。
 *
 * changeType 为空（旧的订单维度分配没有 sale_payment_id）时同样回退订单级。
 */
export function resolvePaymentAttributionDate(
  changeType: string | null | undefined,
  orderAttributionDate: string | null,
  paymentAttributionDate: string | null | undefined,
  paidAt: Date | null | undefined,
): string | null {
  if (!changeType || changeType === '首次支付') return orderAttributionDate
  return paymentAttributionDate ?? (paidAt ? fmtDate(paidAt) : null)
}

/**
 * 款项业绩归属日期（SQL 版）。返回 `date` 类型表达式，无归属事实时为 NULL。
 *
 * @param paymentAlias 款项表在当前查询里的别名；EXISTS 子查询按别名引用时必传。
 *   省略则引用 drizzle 的 `sale_order_payments` 表本身。
 *   **订单级那一支恒引用外层 `sale_orders`**，因此调用点必须已 JOIN（或外层已有）sale_orders。
 */
export function paymentAttributionDateSql(paymentAlias?: string): SQL {
  const changeType = paymentAlias
    ? sql.raw(`${paymentAlias}.change_type`)
    : sql`${saleOrderPayments.changeType}`
  const attributionDate = paymentAlias
    ? sql.raw(`${paymentAlias}.performance_attribution_date`)
    : sql`${saleOrderPayments.performanceAttributionDate}`
  const paidAt = paymentAlias
    ? sql.raw(`${paymentAlias}.paid_at`)
    : sql`${saleOrderPayments.paidAt}`
  return sql`CASE
    WHEN ${changeType} = '首次支付' THEN ${saleOrders.performanceAttributionDate}
    ELSE COALESCE(${attributionDate}, (${paidAt} AT TIME ZONE 'Asia/Shanghai')::date)
  END`
}

/**
 * 款项归属日期区间条件。
 *
 * 归属日期是 `date` 而非 `timestamptz`，所以这里用**闭区间**直接比较，
 * 不走 `beijingBoundaryTs` / `beijingNextDayBoundaryTs` 那套半开区间——
 * 混用会让结束日整天被漏掉（date <= 次日零点 的语义并不等价）。
 */
export function paymentAttributionRangeConditions(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  paymentAlias?: string,
): (SQL | undefined)[] {
  return [
    dateFrom ? sql`${paymentAttributionDateSql(paymentAlias)} >= ${dateFrom}::date` : undefined,
    dateTo ? sql`${paymentAttributionDateSql(paymentAlias)} <= ${dateTo}::date` : undefined,
  ]
}
