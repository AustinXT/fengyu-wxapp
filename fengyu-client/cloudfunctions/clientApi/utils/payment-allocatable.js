/**
 * 回款逐项可分配额捕获（营业额分配基数）—— 顾客端独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：admin src/lib/payment-allocatable.ts /
 * staffApi utils/payment-allocatable.js / payNotify 内联 各保留同语义独立副本，
 * 由 cross-end-allocation-snapshot.test.js 守护字面同义。
 *
 * 在每一笔回款事件落账的同事务内调用：把本次回款金额按规则落到各 sale_item，
 * 写 sale_payment_allocatable_items（按回款逐笔分配的可分配基数），并置该回款主流水行
 * allocation_status='待分配'。非「销售单/转换单」或历史单自动跳过（不参与营业额分配）。
 */

// 营业额口径白名单：仅「销售单」「转换单」产生营业额、参与销售提成分配（与 allocation.js 一致）
const ALLOCATABLE_ORDER_TYPES = ['销售单', '转换单']

/**
 * @param client 事务客户端（pg.transaction 内）
 * @param salePaymentId 本回款事件主流水行 id（现金「首次支付/回款」行；纯储值卡回款取「储值卡抵扣」行）
 * @param saleOrderId   原销售单号
 * @param eventAmount   本次回款总额（现金 + 储值卡抵扣；提成率档位基准）
 * @param directedItems [{saleItemId, amount}] 定向回款逐项金额（现金+储值卡）；null/空 = 非定向按剩余应付比例摊
 * @returns [{saleItemId, amount, salesCategory}]（供线上自动分配使用）
 */
async function capturePaymentAllocatables(client, { salePaymentId, saleOrderId, eventAmount, directedItems }) {
  const evt = Math.round(Number(eventAmount) * 100) / 100
  if (!salePaymentId || !(evt > 0)) return []

  // guard：仅销售单/转换单且非历史单参与营业额分配
  const ordRes = await client.query(
    'SELECT sale_order_type, legacy_source FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId],
  )
  const ord = ordRes.rows[0]
  if (!ord || !ALLOCATABLE_ORDER_TYPES.includes(ord.sale_order_type) || ord.legacy_source === 'workfine') {
    return []
  }

  const itemsRes = await client.query(
    `SELECT sale_item_id, sale_amount::numeric AS sale_amount, sales_category
       FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
    [saleOrderId],
  )
  const items = itemsRes.rows
  if (items.length === 0) return []
  const catMap = new Map(items.map((i) => [i.sale_item_id, i.sales_category]))

  let perItem = []
  if (Array.isArray(directedItems) && directedItems.length > 0) {
    // 定向回款：逐项金额即可分配额
    perItem = directedItems
      .map((d) => ({ saleItemId: String(d.saleItemId), amount: Math.round(Number(d.amount) * 100) / 100 }))
      .filter((d) => catMap.has(d.saleItemId) && d.amount > 0)
  } else {
    // 非定向：按各 item 剩余应付（sale_amount − Σ已记可分配额）比例摊，余数补末项；保证 Σ = evt
    const priorRes = await client.query(
      `SELECT sale_item_id, COALESCE(SUM(amount::numeric), 0) AS allocated
         FROM sale_payment_allocatable_items WHERE sale_order_id = $1 GROUP BY sale_item_id`,
      [saleOrderId],
    )
    const priorMap = new Map(priorRes.rows.map((r) => [r.sale_item_id, Number(r.allocated)]))
    let base = items.map((i) => ({
      saleItemId: i.sale_item_id,
      w: Math.max(0, Math.round((Number(i.sale_amount) - (priorMap.get(i.sale_item_id) || 0)) * 100) / 100),
    }))
    let totalW = base.reduce((s, b) => s + b.w, 0)
    if (totalW <= 0) {
      // 已全摊满兜底：按 sale_amount 摊
      base = items.map((i) => ({ saleItemId: i.sale_item_id, w: Math.max(0, Number(i.sale_amount)) }))
      totalW = base.reduce((s, b) => s + b.w, 0)
    }
    if (totalW <= 0) {
      perItem = [{ saleItemId: items[0].sale_item_id, amount: evt }]
    } else {
      const positive = base.filter((b) => b.w > 0)
      let acc = 0
      perItem = positive
        .map((b, idx) => {
          let amt
          if (idx === positive.length - 1) amt = Math.round((evt - acc) * 100) / 100
          else {
            amt = Math.round((evt * b.w / totalW) * 100) / 100
            acc += amt
          }
          return { saleItemId: b.saleItemId, amount: amt }
        })
        .filter((d) => d.amount > 0)
    }
  }

  const out = []
  for (const d of perItem) {
    const cat = catMap.get(d.saleItemId) || null
    await client.query(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category`,
      [salePaymentId, saleOrderId, d.saleItemId, d.amount.toFixed(2), cat],
    )
    out.push({ saleItemId: d.saleItemId, amount: d.amount, salesCategory: cat })
  }

  // 置回款主流水行为待分配（线上自动分配会在 capture 之后覆盖为已分配）
  await client.query(
    `UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1`,
    [salePaymentId],
  )
  return out
}

/**
 * 汇总刷新订单分配状态：任一回款待分配 → 订单待分配，否则已分配。
 * 维持 dashboard 待分配计数与订单列表展示（按回款逐笔分配的订单级汇总位）。
 */
async function refreshOrderAllocationRollup(client, saleOrderId) {
  await client.query(
    `UPDATE sale_orders
        SET allocation_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM sale_order_payments
                 WHERE sale_order_id = $1 AND allocation_status = '待分配'
              ) THEN '待分配'::allocation_status ELSE '已分配'::allocation_status END,
            updated_at = NOW()
      WHERE sale_order_id = $1`,
    [saleOrderId],
  )
}

module.exports = { capturePaymentAllocatables, refreshOrderAllocationRollup, ALLOCATABLE_ORDER_TYPES }
