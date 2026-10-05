export function retainedRefundFeeSql(orderExpression: string, itemExpression: string | null = null, includeDeduction = false) {
  for (const expr of [orderExpression, itemExpression].filter((value): value is string => value !== null)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(expr)) throw new Error('INVALID_PARAMS: 非法退款余额引用')
  }
  return `COALESCE((SELECT SUM(GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'handlingFee'), 0))
    ${includeDeduction ? "+ GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'overdraftDeduction'), 0))" : ''})
    FROM sale_order_payments rfp CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(rfp.note) -> 'items') = 'array'
      THEN public.try_jsonb(rfp.note) -> 'items' ELSE '[]'::jsonb END) rfi
    WHERE rfp.sale_order_id = ${orderExpression} AND rfp.status = '已支付' AND rfp.change_type = '退款'
      AND public.try_numeric(public.try_jsonb(rfp.note) ->> 'refundAccountingVersion') = 2
      ${itemExpression ? `AND rfi ->> 'refSaleItemId' = ${itemExpression}` : ''}), 0)`
}
