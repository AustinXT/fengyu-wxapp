/**
 * 数据中心「到店日」事件集：一行 = 一个顾客的一个到店日（顾客, 日期）去重后。
 *
 * 口径（#298，2026-09-23 拍板「按到店天数」；2026-09-25 拍板日期轴 = service_date）：
 *   - 同一顾客同一天开多张服务单 / 做多个项目只算 1 个到店日；
 *     **去重键 = (so.client_user_id, <日期轴列>)**，由本片段的 `SELECT DISTINCT` 保证
 *   - 只计 `status = '已完成'` 且挂了顾客的服务单
 *   - 与 cron `refresh-monthly-activity.ts`（`COUNT(DISTINCT so.service_date)`）同一条轴，
 *     故顾客列表「月度客活」筛选与数据中心「一次/二次人数」同一时点可逐人对上
 *
 * 日期轴做成白名单参数，目前只有 service_date 一种取值。
 * ⚠️ #370 顾客频率表的「服务日 ∪ 支付日(paid_at)」并集轴**不能**只加一项白名单：它要 UNION
 * 款项表、排除寄存单款项、scope 改走 bound_store_id —— 届时须把本函数改成「按轴构造整段事件 SQL」，
 * 并同步 consistency.customer.test.ts 的渲染快照。输出列契约（client_user_id / visit_date，
 * 每个 (顾客, 日期) 一行）保持不变，调用方的按天计数不用动。
 *
 * ⚠️ staffApi `routes/mgmt-traffic.js` 客活两函数是同口径独立副本（禁止跨端共享代码），
 * 一致性由 `actions/data-center/__tests__/consistency.customer.test.ts` 守护。
 *
 * @param scope   作用在 `so.store_id` 上的 scope 片段（`scopeFilterSql(session, scope, 'so.store_id')`）
 * @returns       可直接放进 CTE 的 SELECT，列为 `client_user_id` / `visit_date`
 */
import { sql, type SQL } from 'drizzle-orm'
import type { ResolvedRange } from './types'

export type VisitDayAxis = 'service_date'

/** 闭集白名单：轴 → service_orders 上的日期列（sql.raw 只接受这里的字面量） */
const VISIT_DAY_AXIS_COLUMN: Record<VisitDayAxis, string> = {
  service_date: 'so.service_date',
}

export function visitDaysSql(opts: { axis: VisitDayAxis; scope: SQL; range: ResolvedRange }): SQL {
  // Object.hasOwn：挡住 'toString' / '__proto__' 这类原型链键（sql.raw 只能吃闭集字面量）
  const column = Object.hasOwn(VISIT_DAY_AXIS_COLUMN, opts.axis) ? VISIT_DAY_AXIS_COLUMN[opts.axis] : undefined
  if (!column) throw new Error(`visitDaysSql: 未知日期轴 ${String(opts.axis)}`)
  const col = sql.raw(column)
  return sql`
    SELECT DISTINCT so.client_user_id, ${col} AS visit_date
    FROM service_orders so
    WHERE ${opts.scope}
      AND so.status = '已完成'
      AND so.client_user_id IS NOT NULL
      AND ${col} BETWEEN ${opts.range.start} AND ${opts.range.end}
  `
}
