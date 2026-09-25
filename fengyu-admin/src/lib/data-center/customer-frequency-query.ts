/**
 * 顾客频率表（#370）的取数 SQL：一条语句、一个快照，返回「范围内每位绑店顾客 × 当月每个有事件的日子」。
 *
 * 行模型、指标卡、搜索、排序、分页都在 `customer-frequency.ts` 里从这一份结果派生，
 * 所以「三档之和 = 有到店顾客」「到店总人次 = 各行之和」「消费合计 = 各行之和」只依赖一处算法。
 *
 * 口径（☆ 为默认，交付前待甲方确认；登记于 notes/references/metrics.md「顾客频率表」）：
 *   - 行：范围内**全部**绑店顾客（按当前 bound_store_id，含本月 0 次到店）☆
 *   - 到店日：visitDaysSql 的 `service_or_payment` 轴（服务日 ∪ paid_at 支付日，同一天只算 1 次）☆
 *   - 当日消费：款项 spe.amount 按**款项归属日期**，与销售板「总业绩」同一组过滤（含充值单、不含储值卡抵扣、
 *     退款按净额可为负、剔除寄存单与 WorkFine 历史单）☆
 *   - 当日消耗：实耗 SUM(unit_real_price × session_used)，与销售板「总实耗」同源，剔除寄存单退款专用单
 *   - 交易跟着顾客走：顾客在别的门店（含已停用门店）的到店、消费、消耗都算进来，所以事件侧不加门店 scope
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { AuthSession } from '@/lib/types'
import { excludeDepositRefundSql } from './consume-filter'
import { scopeFilterSql } from './scope-sql'
import type { DataCenterScope, ResolvedRange } from './types'
import { visitDayStoresSql, visitDaysSql } from './visit-days'

/** SQL 结果的一行：顾客字段 + 一个日子的事实（没有任何事件的顾客只有一行，day 为 null） */
export interface CustomerFrequencySourceRow {
  clientUserId: string
  customerName: string | null
  phone: string | null
  memberLevel: string | null
  customerType: string | null
  storeName: string | null
  /** YYYY-MM-DD；null = 该顾客本月没有任何事件 */
  day: string | null
  visited: boolean
  /** 当日款项净额（元，numeric 原样字符串）；null = 当日没有款项 */
  amount: string | null
  /** 当日实耗（元）；null = 当日没有计入消耗的服务 */
  consume: string | null
  items: string[]
  stores: string[]
}

type RawRow = Record<string, unknown>

function text(value: unknown): string | null {
  return value == null ? null : String(value)
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

export async function loadCustomerFrequencySource(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<CustomerFrequencySourceRow[]> {
  // 事件侧不按门店收窄（交易跟着顾客走），只按顾客归属过滤；过滤放进到店片段内部，单店视图不必先算全国当月到店日
  const inCust = sql`so.client_user_id IN (SELECT user_id FROM cust)`
  const rows = (await db.execute(sql`
    WITH cust AS (
      SELECT c.user_id, c.name, c.phone,
             c.member_level::text AS member_level, c.customer_type::text AS customer_type,
             bs.store_name AS bound_store_name
      FROM client_wechat_users c
      LEFT JOIN stores bs ON bs.store_id = c.bound_store_id
      WHERE ${scopeFilterSql(session, scope, 'c.bound_store_id')}
    ),
    visit_days AS (${visitDaysSql({ axis: 'service_or_payment', scope: inCust, range })}),
    visit_store_events AS (${visitDayStoresSql({ axis: 'service_or_payment', scope: inCust, range })}),
    amount_days AS (
      SELECT so.client_user_id, spe.performance_date AS day,
             SUM(spe.amount::numeric) AS amount,
             array_agg(DISTINCT st.store_name) AS stores
      FROM sale_order_performance_events spe
      JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
      LEFT JOIN stores st ON st.store_id = spe.store_id
      WHERE spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        AND so.client_user_id IN (SELECT user_id FROM cust)
      GROUP BY so.client_user_id, spe.performance_date
    ),
    service_days AS (
      SELECT so.client_user_id, so.service_date AS day,
             SUM(sit.unit_real_price::numeric * sit.session_used)
               FILTER (WHERE ${excludeDepositRefundSql('so')}) AS consume,
             array_agg(DISTINCT si.product_name) AS items
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${range.start} AND ${range.end}
        AND so.client_user_id IN (SELECT user_id FROM cust)
      GROUP BY so.client_user_id, so.service_date
    ),
    visit_stores AS (
      SELECT ve.client_user_id, ve.visit_date AS day, array_agg(DISTINCT st.store_name) AS stores
      FROM visit_store_events ve
      LEFT JOIN stores st ON st.store_id = ve.store_id
      GROUP BY ve.client_user_id, ve.visit_date
    ),
    day_keys AS (
      SELECT client_user_id, visit_date AS day FROM visit_days
      UNION SELECT client_user_id, day FROM amount_days
      UNION SELECT client_user_id, day FROM service_days
    )
    SELECT c.user_id, c.name, c.phone, c.member_level, c.customer_type, c.bound_store_name,
           to_char(k.day, 'YYYY-MM-DD') AS day,
           (vd.client_user_id IS NOT NULL) AS visited,
           ad.amount::text AS amount,
           sd.consume::text AS consume,
           sd.items,
           vs.stores AS visit_stores,
           ad.stores AS amount_stores
    FROM cust c
    LEFT JOIN day_keys k ON k.client_user_id = c.user_id
    LEFT JOIN visit_days vd ON vd.client_user_id = k.client_user_id AND vd.visit_date = k.day
    LEFT JOIN amount_days ad ON ad.client_user_id = k.client_user_id AND ad.day = k.day
    LEFT JOIN service_days sd ON sd.client_user_id = k.client_user_id AND sd.day = k.day
    LEFT JOIN visit_stores vs ON vs.client_user_id = k.client_user_id AND vs.day = k.day
    ORDER BY c.user_id, k.day
  `)) as unknown as RawRow[]

  return rows.map((row) => ({
    clientUserId: String(row.user_id),
    customerName: text(row.name),
    phone: text(row.phone),
    memberLevel: text(row.member_level),
    customerType: text(row.customer_type),
    storeName: text(row.bound_store_name),
    day: text(row.day),
    visited: row.visited === true,
    amount: text(row.amount),
    consume: text(row.consume),
    items: textArray(row.items),
    stores: Array.from(new Set([...textArray(row.visit_stores), ...textArray(row.amount_stores)])),
  }))
}
