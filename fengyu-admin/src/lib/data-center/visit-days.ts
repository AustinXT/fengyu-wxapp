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
 * 日期轴做成白名单参数：#370 顾客频率表将来要接「服务日 ∪ 支付日」等别的轴，
 * 加轴 = 往 VISIT_DAY_AXIS_COLUMN 加一项（及对应 FROM 形态），调用方不用改去重逻辑。
 * 目前只有 service_date 一种取值。
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
  const column = VISIT_DAY_AXIS_COLUMN[opts.axis]
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
