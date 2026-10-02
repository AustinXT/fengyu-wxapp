// 只查询本人实际参与的业务；所有快照由服务端生成。
async function candidates(query, employeeId, date) {
  const services = await query(
    `SELECT so.service_order_id AS "businessId", 'service' AS "businessType",
      so.status, COALESCE(c.name,'顾客') AS customer,
      jsonb_agg(jsonb_build_object('name',si.product_name,'sourceOrderId',si.sale_order_id,'sessions',i.session_used) ORDER BY i.service_item_id) AS items
    FROM service_orders so JOIN service_items i ON i.service_order_id=so.service_order_id
    JOIN sale_items si ON si.sale_item_id=i.sale_item_id LEFT JOIN client_wechat_users c ON c.user_id=so.client_user_id
    WHERE i.employee_id=$1 AND so.service_date=$2 AND so.status IN ('服务中','待客户确认','已完成')
    GROUP BY so.service_order_id,c.name ORDER BY so.service_order_id`,
    [employeeId, date],
  );
  const linked = [
    ...new Set(services.flatMap((s) => s.items.map((i) => i.sourceOrderId))),
  ];
  const sales = await query(
    `SELECT so.sale_order_id AS "businessId", 'sale' AS "businessType",
      so.status, COALESCE(so.customer_name,c.name,'顾客') AS customer,
      jsonb_agg(DISTINCT jsonb_build_object('name',si.product_name)) AS items
    FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id
    JOIN sale_order_payments p ON p.id=r.sale_payment_id JOIN sale_orders so ON so.sale_order_id=r.sale_order_id
    JOIN sale_items si ON si.sale_item_id=r.sale_item_id LEFT JOIN client_wechat_users c ON c.user_id=so.client_user_id
    WHERE a.employee_id=$1 AND NOT a.is_void AND a.allocated_amount>0 AND r.amount>0
      AND p.status='已支付' AND p.change_type IN ('首次支付','回款') AND p.performance_attribution_date=$2
      AND so.status IN ('已支付','已完成','部分支付') AND NOT (so.sale_order_id=ANY($3::text[]))
    GROUP BY so.sale_order_id,c.name ORDER BY so.sale_order_id`,
    [employeeId, date, linked],
  );
  return [...services, ...sales].map((b) => ({
    ...b,
    title: b.customer + " · " + b.items.map((i) => i.name || "项目").join("、"),
  }));
}
module.exports = { candidates };
