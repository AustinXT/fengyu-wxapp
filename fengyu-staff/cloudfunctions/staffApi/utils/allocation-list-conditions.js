// 员工端营业额分配两侧列表与工作台角标共用的无搜索、无日期筛选口径。
// 别名约定：销售回款 p / 订单 o，服务单 so；$1 为当前工作门店。
const SALE_PAYMENT_CONDITIONS = [
  'o.store_id = $1',
  'p.allocation_status IS NOT NULL',
  "o.sale_order_type IN ('销售单', '转换单')",
  "o.legacy_source IS DISTINCT FROM 'workfine'",
  `(
    p.allocation_status <> '待分配'
    OR EXISTS (
      SELECT 1
        FROM sale_payment_item_receipts spir
       WHERE spir.sale_payment_id = p.id
         AND spir.amount::numeric <> 0
         AND NOT EXISTS (
           SELECT 1
             FROM sale_payment_item_allocations spia
            WHERE spia.sale_payment_item_receipt_id = spir.id
              AND spia.is_void = false
         )
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM sale_payment_item_receipts spir WHERE spir.sale_payment_id = p.id
      )
      AND GREATEST(COALESCE(o.received::numeric, 0) - COALESCE(o.refunded_amount::numeric, 0), 0) > 0
    )
  )`,
]

const SERVICE_ORDER_CONDITIONS = [
  'so.store_id = $1',
  "so.status = '已完成'",
]

function serviceCommissionStatusCondition(paramIndex) {
  return `COALESCE(so.commission_status::text, '待分配') = $${paramIndex}`
}

module.exports = {
  SALE_PAYMENT_CONDITIONS,
  SERVICE_ORDER_CONDITIONS,
  serviceCommissionStatusCondition,
}
