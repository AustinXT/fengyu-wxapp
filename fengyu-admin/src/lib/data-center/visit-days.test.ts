import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { visitDayStoresSql, visitDaysSql } from './visit-days'

/**
 * visitDaysSql 的 `service_or_payment` 轴（#370 顾客频率表）按 Drizzle 实际渲染出的 SQL 整段比对。
 * service_date 轴（#298）的渲染快照在 actions/data-center/__tests__/consistency.customer.test.ts。
 */

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
const render = (fragment: ReturnType<typeof visitDaysSql>) => new PgDialect().sqlToQuery(fragment)
const RANGE = { start: '2026-08-01', end: '2026-08-31' }

const SERVICE_PART =
  "SELECT DISTINCT so.client_user_id, so.service_date AS visit_date FROM service_orders so " +
  "WHERE TRUE AND so.status = '已完成' AND so.client_user_id IS NOT NULL AND so.service_date BETWEEN $1 AND $2"
const PAYMENT_SOURCE =
  'FROM sale_order_payments sop JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id ' +
  "WHERE TRUE AND sop.status = '已支付' AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣') " +
  "AND so.sale_order_type IN ('销售单', '转换单', '充值单') AND so.client_user_id IS NOT NULL " +
  "AND (sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $3 AND $4"

describe('visitDaysSql · service_or_payment 轴（服务日 ∪ 支付日）', () => {
  it('UNION 去重 (顾客, 日期)；支付日按 paid_at 上海日界；不含退款与寄存单；不用款项归属日期', () => {
    const q = render(visitDaysSql({ axis: 'service_or_payment', scope: sql`TRUE`, range: RANGE }))
    expect(normalize(q.sql)).toBe(
      `${SERVICE_PART} UNION SELECT so.client_user_id, (sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS visit_date ${PAYMENT_SOURCE}`,
    )
    expect(normalize(q.sql)).not.toMatch(/UNION ALL|performance|'退款'|'寄存单'/)
    expect(q.params).toEqual(['2026-08-01', '2026-08-31', '2026-08-01', '2026-08-31'])
  })

  it('scope 片段同时作用于服务、款项两段（两段单据都以 so 为别名）', () => {
    const q = render(visitDaysSql({ axis: 'service_or_payment', scope: sql`so.store_id = ${'S1'}`, range: RANGE }))
    expect(normalize(q.sql).match(/WHERE so\.store_id = \$\d+/g)).toHaveLength(2)
  })

  it('service_date 轴不并入支付日（#298 客活口径不受本轴影响）', () => {
    const q = render(visitDaysSql({ axis: 'service_date', scope: sql`TRUE`, range: RANGE }))
    expect(normalize(q.sql)).toBe(SERVICE_PART)
  })

  it('发生门店片段与计数片段同一组事件（支付段共用同一个 FROM + WHERE）', () => {
    const q = render(visitDayStoresSql({ axis: 'service_or_payment', scope: sql`TRUE`, range: RANGE }))
    expect(normalize(q.sql)).toBe(
      'SELECT so.client_user_id, so.service_date AS visit_date, so.store_id FROM service_orders so ' +
        "WHERE TRUE AND so.status = '已完成' AND so.client_user_id IS NOT NULL AND so.service_date BETWEEN $1 AND $2 " +
        `UNION SELECT so.client_user_id, (sop.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS visit_date, so.store_id ${PAYMENT_SOURCE}`,
    )
  })

  it('两个片段都拒绝白名单外的轴', () => {
    for (const axis of ['performance_date', 'toString', '__proto__']) {
      expect(() => visitDaysSql({ axis: axis as never, scope: sql`TRUE`, range: RANGE })).toThrow(/未知日期轴/)
      expect(() => visitDayStoresSql({ axis: axis as never, scope: sql`TRUE`, range: RANGE })).toThrow(/未知日期轴/)
    }
  })
})
