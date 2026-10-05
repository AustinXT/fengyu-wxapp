function retainedRefundFeeSql(orderExpression, itemExpression = null, includeDeduction = false, excludePaymentExpression = null) {
  for (const expr of [orderExpression, itemExpression, excludePaymentExpression].filter(Boolean)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(expr)) throw new Error('INVALID_PARAMS: 非法退款余额引用')
  }
  const modern = `COALESCE((SELECT SUM(GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'handlingFee'), 0))
    ${includeDeduction ? "+ GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'overdraftDeduction'), 0))" : ''})
    FROM sale_order_payments rfp CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(rfp.note) -> 'items') = 'array'
      THEN public.try_jsonb(rfp.note) -> 'items' ELSE '[]'::jsonb END) rfi
    WHERE rfp.sale_order_id = ${orderExpression} AND rfp.status = '已支付' AND rfp.change_type = '退款'
      AND public.try_numeric(public.try_jsonb(rfp.note) ->> 'refundAccountingVersion') = 2
      ${excludePaymentExpression ? `AND rfp.id <> ${excludePaymentExpression}` : ''}
      ${itemExpression ? `AND rfi ->> 'refSaleItemId' = ${itemExpression}` : ''}), 0)`
  // 旧审批按毛额冲销商品receipt，权益侧已扣手续费；订单消费口径仍须扣其明确的顶层手续费。
  if (itemExpression) return modern
  return `(${modern} + COALESCE((SELECT SUM(GREATEST(0, COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'handlingFee'), 0))
    ${includeDeduction ? "+ GREATEST(0, COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'overdraftDeduction'), 0))" : ''})
    FROM sale_order_payments rfp
    WHERE rfp.sale_order_id = ${orderExpression} AND rfp.status = '已支付' AND rfp.change_type = '退款'
      AND COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'refundAccountingVersion'), 0) <> 2
      ${excludePaymentExpression ? `AND rfp.id <> ${excludePaymentExpression}` : ''}), 0))`
}

module.exports = { retainedRefundFeeSql }
