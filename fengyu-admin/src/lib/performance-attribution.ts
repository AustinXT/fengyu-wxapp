/**
 * 款项业绩归属日期的单一口径（JS 版与 SQL 版并置，禁止任一侧单独漂移）。
 *
 * 口径定义（与 DB 视图 `sale_item_performance_events.performance_date` 同源）：
 * **查询侧一律直读 `sale_order_payments.performance_attribution_date`，没有任何回退分支。**
 *
 * 回退只发生在写入侧，由两个 trigger 保证该列恒有值（迁移 0039 + 0040）：
 * - `initialize_payment_performance_attribution_date()`（BEFORE INSERT/UPDATE on sale_order_payments）
 *   —— 首次支付镜像 `sale_orders.performance_attribution_date`、同次混合支付卡行跟随主流水、
 *   其余 `paid_at` → `created_at` 兜底；
 * - `sync_order_performance_attribution_to_payments()`（AFTER UPDATE on sale_orders）
 *   —— 订单级归属日期被调整时同步首次支付行与同次卡行。
 * 迁移 0040 起该列是 NOT NULL。
 *
 * ⚠ 不要把 `resolvePaymentAttributionDate` 的订单级分支当成"残留回退"删掉 —— 见该函数注释，
 * 它处理的是**根本不存在款项行**的场景，与"有款项行但列为空"是两回事。
 */
import { sql, type SQL } from 'drizzle-orm'
import { saleOrderPayments } from '@db/order'

/**
 * 款项业绩归属日期（JS 版；回款明细导出与营业额分配导出共用，防两处漂移）。
 *
 * 有款项行 → 直读款项级列（trigger 保证恒有值，首次支付那一支即订单级的镜像）。
 *
 * 无款项行 → 用订单级。这**不是**查询侧回退：旧的订单维度营业额分配没有 `sale_payment_id`，
 * 压根没有款项实体可读（`orders.ts` 的 `exportAllocationOrders` 两处调用点），
 * 此时唯一存在的归属事实就在 `sale_orders` 上。
 *
 * 用具名对象而非位置参数：两个参数同为 `string | null`，位置写反时 tsc 一声不吭，
 * 运行期又只在"款项列为空"时才显形 —— 而 0040 之后该列非空，等于永远不显形。
 *
 * ⚠ 调用约定：`payment` 为空 **⟺** 该行根本没有款项实体。
 * 款项粒度的导出（`exportOrderPayments`）恒有款项行，因此它**不调用本函数**、直读列并保留空值
 * —— 那里的空值是数据异常，补订单级兜底会把它伪装成正常。两处 NULL 策略不同是有意的。
 */
export function resolvePaymentAttributionDate({
  payment,
  order,
}: {
  /** 款项级 `sale_order_payments.performance_attribution_date`；无款项行时为 null/undefined */
  payment: string | null | undefined
  /** 订单级 `sale_orders.performance_attribution_date` */
  order: string | null
}): string | null {
  return payment ?? order
}

/**
 * 款项业绩归属日期（SQL 版）。返回 `date` 类型表达式。
 *
 * 收敛后只剩一个列引用，但仍保留函数壳：它是口径锚点（`paymentAttributionRangeConditions`
 * 的上下界各引用一次），且 alias 分支要走 `sql.raw`，内联会让那三行逻辑重复两遍。
 *
 * @param paymentAlias 款项表在当前查询里的别名；EXISTS 子查询按别名引用时必传。
 *   省略则引用 drizzle 的 `sale_order_payments` 表本身。
 *   收敛后本表达式**不再引用 `sale_orders`**，调用点无需事先 JOIN 订单表。
 */
export function paymentAttributionDateSql(paymentAlias?: string): SQL {
  return paymentAlias
    ? sql.raw(`${paymentAlias}.performance_attribution_date`)
    : sql`${saleOrderPayments.performanceAttributionDate}`
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
