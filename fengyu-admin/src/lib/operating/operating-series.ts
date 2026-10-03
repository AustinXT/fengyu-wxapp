import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'
const excludeDepositRefundSql = (alias: string) =>
  `${alias}.remark IS DISTINCT FROM '${DEPOSIT_REFUND_REMARK}'`
// 日期粒度批量取数；员工、门店各自统计，人数不能按员工结果相加。
export async function series(
  query: any,
  { storeIds, employeeIds, start, end }: any,
) {
  if (start > end) return []
  return query(
    `WITH valid AS (
    SELECT so.service_order_id,so.client_user_id,so.store_id,so.service_date
    FROM service_orders so WHERE so.status='已完成' AND ${excludeDepositRefundSql('so')}
  ), selected AS (
    SELECT v.* FROM valid v WHERE v.service_date BETWEEN $3 AND $4
      AND (v.store_id=ANY($1::text[]) OR EXISTS(SELECT 1 FROM service_items i JOIN service_commissions c ON c.service_item_id=i.service_item_id
        WHERE i.service_order_id=v.service_order_id AND NOT c.is_void AND c.employee_id=ANY($2::text[])))
  ), first_visit AS (
    SELECT v.client_user_id,MIN(v.service_date) AS date FROM valid v
    WHERE v.client_user_id IN (SELECT client_user_id FROM selected) GROUP BY v.client_user_id
  ), participation AS (
    SELECT DISTINCT c.employee_id,i.service_item_id,i.service_order_id,i.session_used
    FROM service_commissions c JOIN service_items i ON i.service_item_id=c.service_item_id
    JOIN selected v ON v.service_order_id=i.service_order_id WHERE NOT c.is_void AND c.employee_id=ANY($2::text[])
  ), events AS (
    SELECT 'store' AS scope,p.store_id AS id,p.performance_date AS date,
      ROUND(SUM(p.performance_amount)*100)::bigint AS sales,0::bigint AS consumption,0::bigint AS visits,0::bigint AS new_customers,0::bigint AS projects
    FROM sale_reportable_payment_events p WHERE p.store_id=ANY($1::text[]) AND p.status='已支付'
      AND p.sale_order_type IN ('销售单','转换单') AND p.performance_date BETWEEN $3 AND $4 GROUP BY p.store_id,p.performance_date
    UNION ALL
    SELECT 'personal',a.employee_id,p.performance_date,
      ROUND(SUM(ROUND(a.allocated_amount::numeric*COALESCE(i.performance_amount::numeric/NULLIF(r.amount::numeric,0),0),2))*100)::bigint,0,0,0,0
    FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id
    JOIN sale_reportable_item_events i ON i.receipt_id=r.id JOIN sale_reportable_payment_events p ON p.sale_payment_id=r.sale_payment_id
    WHERE NOT a.is_void AND a.employee_id=ANY($2::text[]) AND p.status='已支付' AND p.sale_order_type IN ('销售单','转换单')
      AND p.performance_date BETWEEN $3 AND $4 GROUP BY a.employee_id,p.performance_date
    UNION ALL
    SELECT 'store',v.store_id,v.service_date,0,0,COUNT(DISTINCT v.service_order_id),
      COUNT(DISTINCT v.client_user_id) FILTER(WHERE f.date=v.service_date),0
    FROM selected v LEFT JOIN first_visit f ON f.client_user_id=v.client_user_id WHERE v.store_id=ANY($1::text[]) GROUP BY v.store_id,v.service_date
    UNION ALL
    SELECT 'store',v.store_id,v.service_date,0,ROUND(SUM(i.unit_real_price::numeric*i.session_used)*100)::bigint,0,0,SUM(i.session_used)::bigint
    FROM selected v JOIN service_items i ON i.service_order_id=v.service_order_id WHERE v.store_id=ANY($1::text[]) GROUP BY v.store_id,v.service_date
    UNION ALL
    SELECT 'personal',p.employee_id,v.service_date,0,0,COUNT(DISTINCT v.service_order_id),
      COUNT(DISTINCT v.client_user_id) FILTER(WHERE f.date=v.service_date),SUM(p.session_used)::bigint
    FROM participation p JOIN selected v ON v.service_order_id=p.service_order_id LEFT JOIN first_visit f ON f.client_user_id=v.client_user_id GROUP BY p.employee_id,v.service_date
    UNION ALL
    SELECT 'personal',c.employee_id,v.service_date,0,ROUND(SUM(i.unit_real_price::numeric*i.session_used*c.allocation_ratio)*100)::bigint,0,0,0
    FROM service_commissions c JOIN service_items i ON i.service_item_id=c.service_item_id JOIN selected v ON v.service_order_id=i.service_order_id
    WHERE NOT c.is_void AND c.employee_id=ANY($2::text[]) GROUP BY c.employee_id,v.service_date
  ) SELECT scope,id,date,SUM(sales)::bigint AS sales,SUM(consumption)::bigint AS consumption,
      SUM(visits)::bigint AS visits,SUM(new_customers)::bigint AS "newCustomers",SUM(projects)::bigint AS projects
    FROM events GROUP BY scope,id,date ORDER BY scope,id,date`,
    [storeIds, employeeIds, start, end],
  )
}
// 市场新客按顾客再去重，不能相加门店的新客数。
export async function marketNewCustomers(
  query: any,
  storeIds: any,
  start: any,
  end: any,
) {
  return query(
    `WITH first_visit AS (SELECT so.client_user_id,MIN(so.service_date) AS date FROM service_orders so
    WHERE so.status='已完成' AND ${excludeDepositRefundSql('so')} GROUP BY so.client_user_id)
    SELECT so.client_user_id,so.store_id,so.service_date AS date FROM service_orders so JOIN first_visit f ON f.client_user_id=so.client_user_id AND f.date=so.service_date
    WHERE so.status='已完成' AND ${excludeDepositRefundSql('so')} AND so.store_id=ANY($1::text[]) AND so.service_date BETWEEN $2 AND $3
    GROUP BY so.client_user_id,so.store_id,so.service_date`,
    [storeIds, start, end],
  )
}
