/**
 * 回款逐项可分配额捕获（营业额分配基数）—— 管理后台独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：staff cloudfunctions/staffApi/utils/payment-allocatable.js /
 * clientApi utils/payment-allocatable.js / payNotify 内联 各保留同语义独立副本，改一端必同步其它端。
 *
 * 在每一笔回款事件落账的同事务内调用：把本次回款金额按规则落到各 sale_item，
 * 写 sale_payment_allocatable_items（按回款逐笔分配的可分配基数），并置该回款主流水行
 * allocation_status='待分配'。非「销售单/转换单」或历史单自动跳过（不参与营业额分配）。
 *
 * 与 staff routes/order.js 引用的 utils/payment-allocatable.js 字面同义。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'

// 营业额口径白名单：仅「销售单」「转换单」产生营业额、参与销售提成分配（与 allocations.ts 一致）
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

/**
 * @param tx            事务客户端（db.transaction 内）
 * @param salePaymentId 本回款事件主流水行 id（现金「首次支付/回款」行；纯储值卡回款取「储值卡抵扣」行）
 * @param saleOrderId   原销售单号
 * @param eventAmount   本次回款总额（现金 + 储值卡抵扣；提成率档位基准）
 * @param directedItems [{saleItemId, amount}] 定向回款逐项金额（现金+储值卡）；null/空 = 非定向按剩余实付(pending_received)比例摊
 * @returns [{saleItemId, amount, salesCategory}]
 */
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

  // guard：仅销售单/转换单且非历史单参与营业额分配
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
  if (items.length === 0) {
    // 转换单（明细仅转出/转入、无『购买』行）：按本笔净实收额落到「转入」行（业绩载体），
    // 与销售单一样按每笔回款逐笔分配。取全部转入行，按 sale_amount 比例把 evt 摊给各行（最大余数法，
    // Σ per row = evt；转换单 evt=补差额 ≤ Σ转入行 sale_amount，故每行 SPAI ≤ 其 sale_amount）；
    // 多转入行各按品类 sales_category 分得 SPAI，下游提成按行品类率归因正确。多笔回款各自 capture
    // （per-payment 幂等键 ON CONFLICT 覆盖本笔），Σ per item across payments = 总实收。
    // 无转入行兜底：仅置回款行『待分配』，不产 SPAI（保持列表可见）。
    const convRes = await tx.execute(sql`
      SELECT sale_item_id, sale_amount::numeric AS sale_amount, sales_category
        FROM sale_items
       WHERE sale_order_id = ${saleOrderId} AND item_direction = '转入'
       ORDER BY sale_item_id
    `)
    // CAS-EXEMPT: 转换单兜底首次置 allocation_status（初始化为『待分配』，非状态迁移，无前置态可守卫）
    await tx.execute(sql`
      UPDATE sale_order_payments SET allocation_status = '待分配'::allocation_status WHERE id = ${salePaymentId}
    `)
    const convRows = convRes as unknown as Array<{ sale_item_id: string; sale_amount: string | number; sales_category: string | null }>
    if (convRows.length === 0) return []
    // 按 sale_amount（cents）比例摊 evt 到全部转入行，最大余数法保证 Σ = evt（修旧码 LIMIT 1 全挂首行
    // 致多转入行异品类提成归因错误）。转入行 sale_amount 全 0（异常 SKU）时全记首行兜底。
    const convCaps = convRows.map((r) => ({ saleItemId: r.sale_item_id, cap: Math.round(Number(r.sale_amount) * 100) }))
    const positive = convCaps.filter((c) => c.cap > 0)
    let perItem: Array<{ saleItemId: string; amount: number }>
    if (positive.length === 0) {
      perItem = [{ saleItemId: convRows[0].sale_item_id, amount: evt }]
    } else {
      const totalW = positive.reduce((s, c) => s + c.cap, 0)
      const evtCents = Math.round(evt * 100)
      const parts = positive.map((c) => {
        const exact = (evtCents * c.cap) / totalW
        const fl = Math.floor(exact)
        return { saleItemId: c.saleItemId, cents: fl, frac: exact - fl }
      })
      const rem = evtCents - parts.reduce((s, p) => s + p.cents, 0)
      parts.sort((a, b) => b.frac - a.frac)
      for (let i = 0; i < rem; i++) parts[i].cents += 1
      perItem = parts.map((p) => ({ saleItemId: p.saleItemId, amount: p.cents / 100 }))
    }
    const convCatMap = new Map(convRows.map((r) => [r.sale_item_id, r.sales_category]))
    for (const d of perItem) {
      await tx.execute(sql`
        INSERT INTO sale_payment_allocatable_items
          (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
        VALUES (${salePaymentId}, ${saleOrderId}, ${d.saleItemId}, ${d.amount.toFixed(2)}::numeric, ${convCatMap.get(d.saleItemId) || null}, NOW())
        ON CONFLICT (sale_payment_id, sale_item_id)
        DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
      `)
    }
    return perItem.map((d) => ({ saleItemId: d.saleItemId, amount: d.amount, salesCategory: convCatMap.get(d.saleItemId) || null }))
  }
  const catMap = new Map(items.map((i) => [i.sale_item_id, i.sales_category]))

  let perItem: Array<{ saleItemId: string; amount: number }> = []
  if (Array.isArray(directedItems) && directedItems.length > 0) {
    // 定向回款：逐项金额即可分配额
    perItem = directedItems
      .map((d) => ({ saleItemId: String(d.saleItemId), amount: Math.round(Number(d.amount) * 100) / 100 }))
      .filter((d) => catMap.has(d.saleItemId) && d.amount > 0)
  } else {
    // 非定向：两段式瀑布分摊（2026-06-28 与 recalcPaidSessionsForOrder STEP1 数学一致，确保 Σ spai per item = 该行应有 received）
    //   第一段产能 pend_cap_i = max(0, pending_received_i − prior_allocated_i)（朝逐行实付草稿铺）
    //   第二段产能 sale_cap_i = max(0, sale_amount_i − max(pending_received_i, prior_allocated_i))（实付→应付余量）
    // eventAmount 先按 pend_cap 比例铺满（LEAST(evt, Σpend_cap)），溢出再按 sale_cap 比例铺开。
    // 补全款时 pend_cap 已耗尽 → 自动回落到 sale_cap，实现"回升到应付不冻结"。
    // 最大余数法保证 Σ = evt 且每项非负（与 staff/payNotify/clientApi 同语义）。
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

    // 分配辅助：按 weightCaps 把 amountCents 摊给 positive 项，最大余数法
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
    const cat = catMap.get(d.saleItemId) || null // 与三个 JS 副本字面对齐（空串 sales_category 归一化为 null）
    await tx.execute(sql`
      INSERT INTO sale_payment_allocatable_items
        (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
      VALUES (${salePaymentId}, ${saleOrderId}, ${d.saleItemId}, ${d.amount.toFixed(2)}::numeric, ${cat}, NOW())
      ON CONFLICT (sale_payment_id, sale_item_id)
      DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
    `)
    out.push({ saleItemId: d.saleItemId, amount: d.amount, salesCategory: cat })
  }

  // 置回款主流水行为待分配（线上自动分配会在 capture 之后覆盖为已分配）
  await tx.execute(sql`
    UPDATE sale_order_payments SET allocation_status = '待分配'::allocation_status WHERE id = ${salePaymentId}
  `)
  return out
}

/**
 * 汇总刷新订单分配状态：有待分配回款→订单待分配；无待分配但有非NULL回款→已分配；无任何回款行→保持原值。
 * 维持 dashboard 待分配计数与订单列表展示（按回款逐笔分配的订单级汇总位）。
 */
export async function refreshOrderAllocationRollup(tx: AdminTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE sale_orders
       SET allocation_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM sale_order_payments
                WHERE sale_order_id = ${saleOrderId} AND allocation_status = '待分配'
             ) THEN '待分配'::allocation_status
             WHEN EXISTS (
               SELECT 1 FROM sale_order_payments
                WHERE sale_order_id = ${saleOrderId} AND allocation_status IS NOT NULL
             ) THEN '已分配'::allocation_status
             ELSE sale_orders.allocation_status END,
           updated_at = NOW()
     WHERE sale_order_id = ${saleOrderId}
  `)
}

/**
 * 退款审批后收敛回款分配状态。
 *
 * 退款不删除原正向分配；已分配明细由 refund-cascade 追加负数冲销。
 * 本函数只处理仍为「待分配」的回款：如果退款后已没有净可分配明细，或剩余净额明细已存在正向分配，
 * 则把该回款收敛为「已分配」（语义为无需继续分配），再刷新订单级汇总状态。
 */
export async function reconcileAllocationStatusAfterRefund(tx: AdminTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`
    WITH needs_allocation AS (
      SELECT p.id
        FROM sale_order_payments p
       WHERE p.sale_order_id = ${saleOrderId}
         AND p.allocation_status = '待分配'
         AND (
           EXISTS (
             SELECT 1
               FROM sale_payment_allocatable_items spai
               JOIN sale_items si ON si.sale_item_id = spai.sale_item_id
              WHERE spai.sale_payment_id = p.id
                AND GREATEST(COALESCE(si.received::numeric, 0), 0) > 0
                AND NOT EXISTS (
                  SELECT 1
                    FROM sale_allocations sa
                   WHERE sa.sale_payment_id = p.id
                     AND sa.sale_item_id = spai.sale_item_id
                     AND sa.is_void = false
                     AND sa.total_amount::numeric > 0
                )
           )
           OR (
             NOT EXISTS (
               SELECT 1 FROM sale_payment_allocatable_items spai WHERE spai.sale_payment_id = p.id
             )
             AND EXISTS (
               SELECT 1
                 FROM sale_orders so
                WHERE so.sale_order_id = p.sale_order_id
                  AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) > 0
             )
           )
         )
    )
    UPDATE sale_order_payments p
       SET allocation_status = '已分配'::allocation_status
     WHERE p.sale_order_id = ${saleOrderId}
       AND p.allocation_status = '待分配'
       AND NOT EXISTS (SELECT 1 FROM needs_allocation n WHERE n.id = p.id)
  `)
  await refreshOrderAllocationRollup(tx, saleOrderId)
}
