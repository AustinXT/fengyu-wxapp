/**
 * 数据中心「到店日」事件集：一行 = 一个顾客的一个到店日（顾客, 日期）去重后。
 *
 * 口径（#298，2026-09-23 拍板「按到店天数」；2026-09-25 拍板日期轴 = service_date）：
 *   - 同一顾客同一天开多张服务单 / 做多个项目只算 1 个到店日；
 *     **去重键 = (so.client_user_id, <日期轴列>)**，由本片段的 `SELECT DISTINCT` / `UNION` 保证
 *   - 只计 `status = '已完成'` 且挂了顾客的服务单
 *   - 与 cron `refresh-monthly-activity.ts`（`COUNT(DISTINCT so.service_date)`）同一条轴。
 *     ⚠ **「逐人对上」自 #414 起只对「当月」成立，不再对历史月份成立**：数据中心的客活分子多了
 *     会员守卫 `became_member_at::date <= 区间终点`，而 cron 侧没有（它给当月到店的所有顾客打标，
 *     含非会员）。当月因终点 = 今天、守卫对全部会员恒真，故两侧仍可逐人对上；
 *     选历史月份时数据中心会少掉"入会晚于该月月末"的人。差异原因见 metrics.md「D-visit-rate-denom」。
 *
 * 日期轴是闭集白名单参数：
 *   - `service_date`        客量板客活（#298）：只认已完成服务单的 service_date
 *   - `service_or_payment`  顾客频率表（#370 ☆）：服务日 ∪ 支付日。支付日 = 销售 / 转换 / 充值单已支付的
 *     首次支付、回款、储值卡抵扣的 **paid_at 上海日**（不含退款；寄存单款项不计——2026-08 有 2,210 万，
 *     放进来会凭空多出 862 个到店日）。**不用款项归属日期**：归属日期可以人工改期，
 *     按它判定会打出顾客当天既没服务也没付款的 ✓（2026-08 多 30 个、漏 67 个真实付款日）。
 *     两段都以 `so` 为别名，scope 片段对两段同时生效（作用在各自单据的 `so.store_id` 上）。
 *
 * ⚠️ staffApi `routes/mgmt-traffic.js` 客活两函数是 service_date 轴的同口径独立副本（禁止跨端共享代码），
 * 一致性由 `actions/data-center/__tests__/consistency.customer.test.ts` 守护；service_or_payment 轴的渲染由
 * `lib/data-center/visit-days.test.ts` 锁定。
 *
 * @param scope   作用在单据 `so.store_id` 上的 scope 片段（`scopeFilterSql(session, scope, 'so.store_id')`）；
 *                按顾客归属取数的调用方（频率表：交易跟着顾客走）传 `sql\`TRUE\``，再在外层按顾客过滤
 * @returns       可直接放进 CTE 的 SELECT，列为 `client_user_id` / `visit_date`
 */
import { sql, type SQL } from 'drizzle-orm'
import type { ResolvedRange } from './types'

export type VisitDayAxis = 'service_date' | 'service_or_payment'

/** 闭集白名单：轴 → 是否并入支付日（sql.raw 只接受下面的字面量，轴名本身绝不进 SQL） */
const VISIT_DAY_AXIS_WITH_PAYMENT: Record<VisitDayAxis, boolean> = {
  service_date: false,
  service_or_payment: true,
}

/** 支付日：paid_at 按 Asia/Shanghai 取日界，不依赖会话时区（#291） */
const PAYMENT_VISIT_DAY = sql.raw(`(sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date`)

function withPayment(axis: VisitDayAxis): boolean {
  // Object.hasOwn：挡住 'toString' / '__proto__' 这类原型链键
  if (!Object.hasOwn(VISIT_DAY_AXIS_WITH_PAYMENT, axis)) throw new Error(`visitDaysSql: 未知日期轴 ${String(axis)}`)
  return VISIT_DAY_AXIS_WITH_PAYMENT[axis]
}

/** 支付到店事件的 FROM + WHERE（visitDaysSql 与 visitDayStoresSql 共用，口径只写这一处） */
function paymentVisitSource(scope: SQL, range: ResolvedRange): SQL {
  return sql`
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    WHERE ${scope}
      AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
      AND so.sale_order_type IN ('销售单', '转换单', '充值单')
      AND so.client_user_id IS NOT NULL
      AND ${PAYMENT_VISIT_DAY} BETWEEN ${range.start} AND ${range.end}
  `
}

export function visitDaysSql(opts: { axis: VisitDayAxis; scope: SQL; range: ResolvedRange }): SQL {
  const payment = withPayment(opts.axis)
  const col = sql.raw('so.service_date')
  const serviceDays = sql`
    SELECT DISTINCT so.client_user_id, ${col} AS visit_date
    FROM service_orders so
    WHERE ${opts.scope}
      AND so.status = '已完成'
      AND so.client_user_id IS NOT NULL
      AND ${col} BETWEEN ${opts.range.start} AND ${opts.range.end}
  `
  if (!payment) return serviceDays
  // UNION（非 UNION ALL）去重：同一天既有服务又有付款只算 1 个到店日
  return sql`
    ${serviceDays}
    UNION
    SELECT so.client_user_id, ${PAYMENT_VISIT_DAY} AS visit_date
    ${paymentVisitSource(opts.scope, opts.range)}
  `
}

/**
 * 到店日的发生门店：一行 = (顾客, 到店日, 门店)，与 visitDaysSql 同一组事件，只是多带出单据门店。
 * 仅供悬停提示「发生门店」等展示用；**计数一律用 visitDaysSql**（本片段按门店展开，同一天多店会出多行）。
 *
 * @returns 列为 `client_user_id` / `visit_date` / `store_id`
 */
export function visitDayStoresSql(opts: { axis: VisitDayAxis; scope: SQL; range: ResolvedRange }): SQL {
  const payment = withPayment(opts.axis)
  const serviceStores = sql`
    SELECT so.client_user_id, so.service_date AS visit_date, so.store_id
    FROM service_orders so
    WHERE ${opts.scope}
      AND so.status = '已完成'
      AND so.client_user_id IS NOT NULL
      AND so.service_date BETWEEN ${opts.range.start} AND ${opts.range.end}
  `
  if (!payment) return sql`${serviceStores} GROUP BY 1, 2, 3`
  return sql`
    ${serviceStores}
    UNION
    SELECT so.client_user_id, ${PAYMENT_VISIT_DAY} AS visit_date, so.store_id
    ${paymentVisitSource(opts.scope, opts.range)}
  `
}
