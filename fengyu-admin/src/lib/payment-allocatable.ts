
import { sql } from 'drizzle-orm'
import { db } from '@/db'


const ALLOCATABLE_ORDER_TYPES = ['销售单', '转换单']

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface DirectedItem {
  saleItemId: string
  amount: number
}

export interface CapturedAllocatable {
  saleItemId: string
  amount: number
  salesCategory: string | null
}


export async function capturePaymentAllocatables(
  tx: AdminTx,
  args: {
    salePaymentId: number | string | null | undefined
    saleOrderId: string
    eventAmount: number
    directedItems?: DirectedItem[] | null
  },
): Promise<CapturedAllocatable[]> {
  const { salePaymentId, saleOrderId, eventAmount, directedItems } = args
  const evt = Math.round(Number(eventAmount) * 100) / 100
  if (!salePaymentId || !(evt > 0)) return []

  
  const ordRes = await tx.execute(sql`
    SELECT sale_order_type, legacy_source FROM sale_orders WHERE sale_order_id = ${saleOrderId}
  `)
  const ord = (ordRes as unknown as any[])[0]
  if (!ord || !ALLOCATABLE_ORDER_TYPES.includes(ord.sale_order_type) || ord.legacy_source === 'workfine') {
    return []
  }

  const itemsRes = await tx.execute(sql`
    SELECT sale_item_id, sale_amount::numeric AS sale_amount, pending_received::numeric AS pending_received, sales_category
      FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
  `)
  const items = itemsRes as unknown as Array<{
    sale_item_id: string
    sale_amount: string | number
    pending_received: string | number
    sales_category: string | null
  }>
  if (items.length === 0) return []
  const catMap = new Map(items.map((i) => [i.sale_item_id, i.sales_category]))

  let perItem: Array<{ saleItemId: string; amount: number }> = []
  if (Array.isArray(directedItems) && directedItems.length > 0) {
    
    perItem = directedItems
      .map((d) => ({ saleItemId: String(d.saleItemId), amount: Math.round(Number(d.amount) * 100) / 100 }))
      .filter((d) => catMap.has(d.saleItemId) && d.amount > 0)
  } else {
    
    
    
    
    
    
    const priorRes = await tx.execute(sql`
      SELECT sale_item_id, COALESCE(SUM(amount::numeric), 0) AS allocated
        FROM sale_payment_allocatable_items WHERE sale_order_id = ${saleOrderId} GROUP BY sale_item_id
    `)
    const priorRows = priorRes as unknown as Array<{ sale_item_id: string; allocated: string | number }>
    const priorMap = new Map(priorRows.map((r) => [r.sale_item_id, Number(r.allocated)]))
    const caps = items.map((i) => {
      const prior = priorMap.get(i.sale_item_id) || 0
      const pending = Number(i.pending_received)
      const saleAmt = Number(i.sale_amount)
      return {
        saleItemId: i.sale_item_id,
        pendCap: Math.max(0, Math.round((pending - prior) * 100) / 100),
        saleCap: Math.max(0, Math.round((saleAmt - Math.max(pending, prior)) * 100) / 100),
      }
    })
    const pendCapTotal = Math.round(caps.reduce((s, c) => s + c.pendCap, 0) * 100) / 100
    const saleCapTotal = Math.round(caps.reduce((s, c) => s + c.saleCap, 0) * 100) / 100
    const evtCents = Math.round(evt * 100)

    
    const allocate = (amountCents: number, weightCaps: Array<{ saleItemId: string; cap: number }>): Map<string, number> => {
      const positive = weightCaps.filter((c) => c.cap > 0)
      const totalW = positive.reduce((s, c) => s + c.cap, 0)
      if (totalW <= 0 || amountCents <= 0) return new Map()
      const parts = positive.map((c) => {
        const exact = (amountCents * c.cap) / totalW
        const fl = Math.floor(exact)
        return { saleItemId: c.saleItemId, cents: fl, frac: exact - fl }
      })
      const rem = amountCents - parts.reduce((s, p) => s + p.cents, 0)
      parts.sort((a, b) => b.frac - a.frac)
      for (let i = 0; i < rem; i++) parts[i].cents += 1
      return new Map(parts.map((p) => [p.saleItemId, p.cents]))
    }

    const acc = new Map<string, number>()
    const addCents = (m: Map<string, number>) => { for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v) }

    if (pendCapTotal > 0 || saleCapTotal > 0) {
      const phase1Cents = Math.min(evtCents, Math.round(pendCapTotal * 100))
      addCents(allocate(phase1Cents, caps.map((c) => ({ saleItemId: c.saleItemId, cap: c.pendCap }))))
      const phase2Cents = evtCents - phase1Cents
      if (phase2Cents > 0) {
        addCents(allocate(phase2Cents, caps.map((c) => ({ saleItemId: c.saleItemId, cap: c.saleCap }))))
      }
      perItem = items
        .map((i) => ({ saleItemId: i.sale_item_id, amount: (acc.get(i.sale_item_id) || 0) / 100 }))
        .filter((d) => d.amount > 0)
    } else {
      perItem = [{ saleItemId: items[0].sale_item_id, amount: evt }]
    }
  }

  const out: CapturedAllocatable[] = []
  for (const d of perItem) {
    const cat = catMap.get(d.saleItemId) || null 
    await tx.execute(sql`
      INSERT INTO sale_payment_allocatable_items
        (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
      VALUES (${salePaymentId}, ${saleOrderId}, ${d.saleItemId}, ${d.amount.toFixed(2)}::numeric, ${cat}, NOW())
      ON CONFLICT (sale_payment_id, sale_item_id)
      DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
    `)
    out.push({ saleItemId: d.saleItemId, amount: d.amount, salesCategory: cat })
  }

  
  await tx.execute(sql`
    UPDATE sale_order_payments SET allocation_status = '待分配'::allocation_status WHERE id = ${salePaymentId}
  `)
  return out
}


export async function refreshOrderAllocationRollup(tx: AdminTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE sale_orders
       SET allocation_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM sale_order_payments
                WHERE sale_order_id = ${saleOrderId} AND allocation_status = '待分配'
             ) THEN '待分配'::allocation_status ELSE '已分配'::allocation_status END,
           updated_at = NOW()
     WHERE sale_order_id = ${saleOrderId}
  `)
}
