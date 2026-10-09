// #548 内部已付本金来源；每端独立副本，禁止由客户端提交。
function cents(value) {
  const n = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('CONFLICT: 转换来源金额无效')
  return n
}
function snapshot(sources) {
  return { version: 1, valueCents: sources.reduce((sum, s) => sum + s.valueCents, 0), sources }
}
function parseSnapshot(value) {
  if (value == null) return null
  const v = typeof value === 'string' ? JSON.parse(value) : value
  if (v.version !== 1 || !Number.isSafeInteger(v.valueCents) || v.valueCents < 0 || !Array.isArray(v.sources)
      || v.sources.some(s => typeof s.sourceOrderId !== 'string' || !s.sourceOrderId || !Number.isSafeInteger(s.valueCents) || s.valueCents < 0
        || (s.pointOrderId != null && typeof s.pointOrderId !== 'string'))
      || v.sources.reduce((sum, s) => sum + s.valueCents, 0) !== v.valueCents
      || (v.lastCashPaymentId != null && (!Number.isSafeInteger(v.lastCashPaymentId) || v.lastCashPaymentId < 0))) {
    throw new Error('CONFLICT: 转换来源快照损坏，请核查来源')
  }
  return v
}
function sourceKey(s) { return JSON.stringify([s.sourceOrderId, s.sourceItemId || null, s.pointOrderId || null]) }
function mergeSources(sources) {
  const map = new Map()
  for (const s of sources) {
    const key = sourceKey(s), prior = map.get(key)
    map.set(key, { ...s, valueCents: (prior?.valueCents || 0) + s.valueCents })
  }
  return [...map.values()].filter(s => s.valueCents > 0).sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)))
}
// 整数分按累计比例分配，不逐笔 floor，不丢尾差。
function takeSources(sources, amount) {
  const total = sources.reduce((sum, s) => sum + s.valueCents, 0)
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > total) throw new Error('CONFLICT: 转换已付来源不足，请核查来源')
  let running = 0
  return sources.map(s => {
    const before = running; running += s.valueCents
    const roundRatio = (value) => Number((BigInt(2) * BigInt(amount) * BigInt(value) + BigInt(total)) / (BigInt(2) * BigInt(total)))
    return { ...s, valueCents: total ? roundRatio(running) - roundRatio(before) : 0 }
  }).filter(s => s.valueCents > 0)
}
function subtractSources(pool, used) {
  const amounts = new Map(pool.map(s => [sourceKey(s), s.valueCents]))
  for (const s of used) {
    const left = (amounts.get(sourceKey(s)) || 0) - s.valueCents
    if (left < 0) throw new Error('CONFLICT: 转换冻结来源与已付来源不一致')
    amounts.set(sourceKey(s), left)
  }
  return pool.map(s => ({ ...s, valueCents: amounts.get(sourceKey(s)) || 0 })).filter(s => s.valueCents > 0)
}
async function refreshConversionSources(query, orderId) {
  const orders = await query(`SELECT sale_order_type, received, ref_sale_order_id, client_user_id, (SELECT COALESCE(MAX(id),0) FROM sale_order_payments WHERE sale_order_id=$1 AND status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')) AS last_cash_id FROM sale_orders WHERE sale_order_id = $1`, [orderId])
  const order = orders[0]
  if (!order || order.sale_order_type !== '转换单') return
  const rows = await query(`SELECT si.*, EXISTS (SELECT 1 FROM sale_items oi JOIN sale_orders co ON co.sale_order_id = oi.sale_order_id
    WHERE oi.ref_sale_item_id = si.sale_item_id AND oi.item_direction = '转出' AND co.status <> '已关闭')
    AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0
      ELSE COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0) >= si.quantity END AS exited
    FROM sale_items si WHERE si.sale_order_id = $1 ORDER BY si.sale_item_id`, [orderId])
  const refunds = await query(`SELECT id, public.try_jsonb(note) AS note FROM sale_order_payments
    WHERE sale_order_id = $1 AND change_type = '退款' AND status = '已支付' ORDER BY id`, [orderId])
  const consumed = new Map()
  const firstRefundIds = new Map()
  const fullyRefunded = new Set()
  for (const r of refunds) for (const it of r.note?.items || []) {
    if (!firstRefundIds.has(it.refSaleItemId)) firstRefundIds.set(it.refSaleItemId, Number(r.id))
    if (it.isFullItemRefund === true) fullyRefunded.add(it.refSaleItemId)
    const prior = consumed.get(it.refSaleItemId) || []
    // 旧已退转换缺少来源事实，不能以今天的池重建历史来源。
    if (!Array.isArray(it.conversionSources)) return
    consumed.set(it.refSaleItemId, [...prior, ...it.conversionSources])
  }
  let pool = []
  for (const out of rows.filter(r => r.item_direction === '转出')) {
    let value = parseSnapshot(out.conversion_value_snapshot)
    if (!value) {
      const refs = await query(`SELECT si.*, so.sale_order_type, so.client_user_id FROM sale_items si JOIN sale_orders so USING (sale_order_id) WHERE si.sale_item_id = $1`, [out.ref_sale_item_id])
      const ref = refs[0]
      if (!ref || ref.client_user_id !== order.client_user_id) return
      let original = parseSnapshot(ref.conversion_value_snapshot)
      if (!original && ref.sale_order_type === '转换单') return
      if (!original) original = snapshot([{ sourceOrderId: ref.sale_order_id, sourceItemId: ref.sale_item_id,
        pointOrderId: ref.sale_order_type === '销售单' ? ref.sale_order_id : null, valueCents: cents(ref.received) }])
      const priorOut = await query(`SELECT oi.conversion_value_snapshot FROM sale_items oi JOIN sale_orders co USING (sale_order_id)
        WHERE oi.ref_sale_item_id = $1 AND oi.item_direction = '转出' AND oi.sale_item_id <> $2 AND co.status <> '已关闭' ORDER BY oi.sale_item_id`, [ref.sale_item_id, out.sale_item_id])
      let available = original.sources
      for (const prior of priorOut) {
        const priorValue = parseSnapshot(prior.conversion_value_snapshot)
        if (!priorValue) return
        available = subtractSources(available, priorValue.sources)
      }
      value = snapshot(takeSources(available, cents(-Number(out.received))))
      await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [out.sale_item_id, JSON.stringify(value)])
    }
    pool.push(...value.sources)
  }
  // 真实补款沿既有 ref_sale_order_id 的单层积分链；无关联销售单不新建赠点归属。
  let pointOrderId = null
  if (order.ref_sale_order_id) {
    const roots = await query("SELECT sale_order_id FROM sale_orders WHERE sale_order_id = $1 AND sale_order_type = '销售单' AND client_user_id IS NOT DISTINCT FROM $2", [order.ref_sale_order_id, order.client_user_id])
    pointOrderId = roots[0]?.sale_order_id || null
  }
  pool = mergeSources([...pool, { sourceOrderId: orderId, pointOrderId, valueCents: cents(order.received) }])
  const incoming = rows.filter(r => r.item_direction === '转入')
  for (const row of incoming.filter(r => r.exited || consumed.has(r.sale_item_id) || parseSnapshot(r.conversion_value_snapshot)?.lastCashPaymentId != null)) {
    const value = parseSnapshot(row.conversion_value_snapshot)
    if (!value) return
    if (!row.exited && !fullyRefunded.has(row.sale_item_id)) {
      const extra = await query(`SELECT COALESCE(SUM(spir.amount::numeric),0) AS amount FROM sale_payment_item_receipts spir JOIN sale_order_payments cash ON cash.id=spir.sale_payment_id
        WHERE spir.sale_item_id=$1 AND cash.status='已支付' AND cash.change_type IN ('首次支付','回款','储值卡抵扣') AND cash.id > $2`, [row.sale_item_id, value.lastCashPaymentId ?? firstRefundIds.get(row.sale_item_id) ?? 0])
      const extraCents = cents(extra[0]?.amount || 0)
      value.sources = mergeSources([...value.sources, { sourceOrderId: orderId, pointOrderId, valueCents: extraCents }])
      value.valueCents += extraCents
      value.lastCashPaymentId = Number(order.last_cash_id)
      await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [row.sale_item_id, JSON.stringify(value)])
    }
    pool = subtractSources(pool, [...value.sources, ...(consumed.get(row.sale_item_id) || [])])
  }
  for (const row of incoming.filter(r => !r.exited && !consumed.has(r.sale_item_id) && parseSnapshot(r.conversion_value_snapshot)?.lastCashPaymentId == null)) {
    const value = snapshot(takeSources(pool, cents(row.received)))
    value.lastCashPaymentId = Number(order.last_cash_id)
    pool = subtractSources(pool, value.sources)
    await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [row.sale_item_id, JSON.stringify(value)])
  }
}
// 审批在订单/明细持锁后、CAS 成功后调用。毛退本金含手续费，积分不得因手续费留下。
async function recordConversionRefundSources(query, orderId, paymentId) {
  const payments = await query('SELECT public.try_jsonb(note) AS note FROM sale_order_payments WHERE id = $1 AND sale_order_id = $2', [paymentId, orderId])
  const note = payments[0]?.note
  if (note?.conversionRefund !== true) return []
  const roots = new Set()
  if ((note.items || []).every(it => Array.isArray(it.conversionSources))) {
    return [...new Set((note.items || []).flatMap(it => it.conversionSources.map(s => s.pointOrderId).filter(Boolean)))].sort()
  }
  for (const it of note.items || []) {
    const rows = await query("SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id = $1 AND sale_order_id = $2 AND item_direction = '转入'", [it.refSaleItemId, orderId])
    const value = parseSnapshot(rows[0]?.conversion_value_snapshot)
    if (!value) throw new Error('CONFLICT: 转换商品已付来源尚未确认，请核查后退款')
    const outgoing = await query(`SELECT oi.conversion_value_snapshot FROM sale_items oi JOIN sale_orders co USING (sale_order_id)
      WHERE oi.ref_sale_item_id = $1 AND oi.item_direction = '转出' AND co.status <> '已关闭' ORDER BY oi.sale_item_id`, [it.refSaleItemId])
    let available = value.sources
    for (const out of outgoing) {
      const outValue = parseSnapshot(out.conversion_value_snapshot)
      if (!outValue) throw new Error('CONFLICT: 再次转换的已付来源尚未确认')
      available = subtractSources(available, outValue.sources)
    }
    const taken = takeSources(available, cents(it.refundAmount))
    it.conversionSources = taken
    for (const s of taken) if (s.pointOrderId) roots.add(s.pointOrderId)
    await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [it.refSaleItemId, JSON.stringify({ ...value, ...snapshot(subtractSources(value.sources, taken)) })])
  }
  await query('UPDATE sale_order_payments SET note = $2 WHERE id = $1', [paymentId, JSON.stringify(note)])
  return [...roots].sort()
}
const CONVERSION_POINT_OFFSETS_SQL = `COALESCE((SELECT SUM(public.try_numeric(src ->> 'valueCents')) / 100
 FROM sale_order_payments cp
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(public.try_jsonb(cp.note) -> 'items') = 'array' THEN public.try_jsonb(cp.note) -> 'items' ELSE '[]'::jsonb END) item
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item -> 'conversionSources') = 'array' THEN item -> 'conversionSources' ELSE '[]'::jsonb END) src
 WHERE cp.change_type = '退款' AND cp.status = '已支付'
   AND public.try_jsonb(cp.note) ->> 'conversionRefund' = 'true' AND src ->> 'pointOrderId' = $1), 0)`
async function lockConversionPointRoots(query, orderId) {
  await query(`SELECT so.sale_order_id FROM sale_orders so WHERE so.sale_order_type = '销售单' AND so.sale_order_id IN (
    SELECT src ->> 'pointOrderId' FROM sale_items si CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(si.conversion_value_snapshot -> 'sources') = 'array' THEN si.conversion_value_snapshot -> 'sources' ELSE '[]'::jsonb END) src
      WHERE si.sale_order_id = $1
    UNION SELECT ref.sale_order_id FROM sale_items oi JOIN sale_items ref ON ref.sale_item_id = oi.ref_sale_item_id
      WHERE oi.sale_order_id = $1 AND oi.item_direction = '转出'
    UNION SELECT ref_sale_order_id FROM sale_orders WHERE sale_order_id = $1
  ) ORDER BY so.sale_order_id FOR UPDATE`, [orderId])
}
function stripConversionSourcesFromNote(note) {
  if (!note) return note
  try {
    const value = JSON.parse(note)
    if (!value || !Array.isArray(value.items)) return note
    return JSON.stringify({ ...value, items: value.items.map(it => {
      if (!it || typeof it !== 'object') return it
      const clean = { ...it }
      delete clean.conversionSources
      return clean
    }) })
  } catch (_) { return note }
}
module.exports = { stripConversionSourcesFromNote, lockConversionPointRoots, refreshConversionSources, recordConversionRefundSources, CONVERSION_POINT_OFFSETS_SQL, parseSnapshot, takeSources, snapshot }
