import { sql } from 'drizzle-orm'
import { db } from '@/db'
type Source = { sourceOrderId: string; sourceItemId?: string; pointOrderId: string | null; valueCents: number }
type Snapshot = { version: number; valueCents: number; sources: Source[] }
type Row = Record<string, any>
type Query = (text: string, params: unknown[]) => Promise<Row[]>
export function conversionSourceQuery(tx: Pick<typeof db, 'execute'>): Query {
  return async (text, params) => {
    const pieces = text.split(/(\$\d+)/)
    const statement = sql.join(pieces.map(part => /^\$\d+$/.test(part) ? sql`${params[Number(part.slice(1)) - 1]}` : sql.raw(part)), sql.raw(''))
    return await tx.execute(statement) as unknown as Row[]
  }
}
// #548 内部已付本金来源；每端独立副本，禁止由客户端提交。
function cents(value: unknown): number {
  const n = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('CONFLICT: 转换来源金额无效')
  return n
}
export function snapshot(sources: Source[]): Snapshot {
  return { version: 1, valueCents: sources.reduce((sum, s) => sum + s.valueCents, 0), sources }
}
export function parseSnapshot(value: any): Snapshot | null {
  if (value == null) return null
  const v = typeof value === 'string' ? JSON.parse(value) : value
  if (v.version !== 1 || !Number.isSafeInteger(v.valueCents) || v.valueCents < 0 || !Array.isArray(v.sources)
      || v.sources.some((s: Source) => typeof s.sourceOrderId !== 'string' || !s.sourceOrderId || !Number.isSafeInteger(s.valueCents) || s.valueCents < 0
        || (s.pointOrderId != null && typeof s.pointOrderId !== 'string'))
      || v.sources.reduce((sum: number, s: Source) => sum + s.valueCents, 0) !== v.valueCents) {
    throw new Error('CONFLICT: 转换来源快照损坏，请核查来源')
  }
  return v
}
function sourceKey(s: Source): string { return JSON.stringify([s.sourceOrderId, s.sourceItemId || null, s.pointOrderId || null]) }
function mergeSources(sources: Source[]): Source[] {
  const map = new Map<string, Source>()
  for (const s of sources) {
    const key = sourceKey(s), prior = map.get(key)
    map.set(key, { ...s, valueCents: (prior?.valueCents || 0) + s.valueCents })
  }
  return [...map.values()].filter(s => s.valueCents > 0).sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)))
}
// 整数分按累计比例分配，不逐笔 floor，不丢尾差。
export function takeSources(sources: Source[], amount: number): Source[] {
  const total = sources.reduce((sum, s) => sum + s.valueCents, 0)
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > total) throw new Error('CONFLICT: 转换已付来源不足，请核查来源')
  let running = 0
  return sources.map(s => {
    const before = running; running += s.valueCents
    const roundRatio = (value: number) => Number((BigInt(2) * BigInt(amount) * BigInt(value) + BigInt(total)) / (BigInt(2) * BigInt(total)))
    return { ...s, valueCents: total ? roundRatio(running) - roundRatio(before) : 0 }
  }).filter(s => s.valueCents > 0)
}
function subtractSources(pool: Source[], used: Source[]): Source[] {
  const amounts = new Map(pool.map(s => [sourceKey(s), s.valueCents]))
  for (const s of used) {
    const left = (amounts.get(sourceKey(s)) || 0) - s.valueCents
    if (left < 0) throw new Error('CONFLICT: 转换冻结来源与已付来源不一致')
    amounts.set(sourceKey(s), left)
  }
  return pool.map(s => ({ ...s, valueCents: amounts.get(sourceKey(s)) || 0 })).filter(s => s.valueCents > 0)
}
export async function refreshConversionSources(query: Query, orderId: string): Promise<void> {
  const orders = await query('SELECT sale_order_type, received, ref_sale_order_id, client_user_id FROM sale_orders WHERE sale_order_id = $1', [orderId])
  const order = orders[0]
  if (!order || order.sale_order_type !== '转换单') return
  const rows = await query(`SELECT si.*, EXISTS (SELECT 1 FROM sale_items oi JOIN sale_orders co ON co.sale_order_id = oi.sale_order_id
    WHERE oi.ref_sale_item_id = si.sale_item_id AND oi.item_direction = '转出' AND co.status <> '已关闭')
    AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0
      ELSE COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0) >= si.quantity END AS exited
    FROM sale_items si WHERE si.sale_order_id = $1 ORDER BY si.sale_item_id`, [orderId])
  const refunds = await query(`SELECT public.try_jsonb(note) AS note FROM sale_order_payments
    WHERE sale_order_id = $1 AND change_type = '退款' AND status = '已支付' ORDER BY id`, [orderId])
  const consumed = new Map<string, Source[]>()
  for (const r of refunds) for (const it of r.note?.items || []) {
    const prior = consumed.get(it.refSaleItemId) || []
    // 旧已退转换缺少来源事实，不能以今天的池重建历史来源。
    if (!Array.isArray(it.conversionSources)) return
    consumed.set(it.refSaleItemId, [...prior, ...it.conversionSources])
  }
  let pool: Source[] = []
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
  let pointOrderId: string | null = null
  if (order.ref_sale_order_id) {
    const roots = await query("SELECT sale_order_id FROM sale_orders WHERE sale_order_id = $1 AND sale_order_type = '销售单' AND client_user_id IS NOT DISTINCT FROM $2", [order.ref_sale_order_id, order.client_user_id])
    pointOrderId = roots[0]?.sale_order_id || null
  }
  pool = mergeSources([...pool, { sourceOrderId: orderId, pointOrderId, valueCents: cents(order.received) }])
  const incoming = rows.filter(r => r.item_direction === '转入')
  for (const row of incoming.filter(r => r.exited || consumed.has(r.sale_item_id))) {
    const value = parseSnapshot(row.conversion_value_snapshot)
    if (!value) return
    pool = subtractSources(pool, [...value.sources, ...(consumed.get(row.sale_item_id) || [])])
  }
  for (const row of incoming.filter(r => !r.exited && !consumed.has(r.sale_item_id))) {
    const value = snapshot(takeSources(pool, cents(row.received)))
    pool = subtractSources(pool, value.sources)
    await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [row.sale_item_id, JSON.stringify(value)])
  }
}
// 审批在订单/明细持锁后、CAS 成功后调用。毛退本金含手续费，积分不得因手续费留下。
export async function recordConversionRefundSources(query: Query, orderId: string, paymentId: number): Promise<string[]> {
  const payments = await query('SELECT public.try_jsonb(note) AS note FROM sale_order_payments WHERE id = $1 AND sale_order_id = $2', [paymentId, orderId])
  const note = payments[0]?.note
  if (note?.conversionRefund !== true) return []
  const roots = new Set<string>()
  if ((note.items || []).every((it: Row) => Array.isArray(it.conversionSources))) {
    return [...new Set<string>((note.items || []).flatMap((it: Row) => it.conversionSources.map((s: Source) => s.pointOrderId).filter(Boolean)))].sort()
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
    await query('UPDATE sale_items SET conversion_value_snapshot = $2::jsonb WHERE sale_item_id = $1', [it.refSaleItemId, JSON.stringify(snapshot(subtractSources(value.sources, taken)))])
  }
  await query('UPDATE sale_order_payments SET note = $2 WHERE id = $1', [paymentId, JSON.stringify(note)])
  return [...roots].sort()
}
export const CONVERSION_POINT_OFFSETS_SQL = `COALESCE((SELECT SUM(public.try_numeric(src ->> 'valueCents')) / 100
 FROM sale_order_payments cp
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(public.try_jsonb(cp.note) -> 'items') = 'array' THEN public.try_jsonb(cp.note) -> 'items' ELSE '[]'::jsonb END) item
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item -> 'conversionSources') = 'array' THEN item -> 'conversionSources' ELSE '[]'::jsonb END) src
 WHERE cp.change_type = '退款' AND cp.status = '已支付'
   AND public.try_jsonb(cp.note) ->> 'conversionRefund' = 'true' AND src ->> 'pointOrderId' = $1), 0)`

export async function lockConversionPointRoots(query: Query, orderId: string): Promise<void> {
  await query(`SELECT so.sale_order_id FROM sale_orders so WHERE so.sale_order_type = '销售单' AND so.sale_order_id IN (
    SELECT src ->> 'pointOrderId' FROM sale_items si CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(si.conversion_value_snapshot -> 'sources') = 'array' THEN si.conversion_value_snapshot -> 'sources' ELSE '[]'::jsonb END) src
      WHERE si.sale_order_id = $1
    UNION SELECT ref.sale_order_id FROM sale_items oi JOIN sale_items ref ON ref.sale_item_id = oi.ref_sale_item_id
      WHERE oi.sale_order_id = $1 AND oi.item_direction = '转出'
    UNION SELECT ref_sale_order_id FROM sale_orders WHERE sale_order_id = $1
  ) ORDER BY so.sale_order_id FOR UPDATE`, [orderId])
}
