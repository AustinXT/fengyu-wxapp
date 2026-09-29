/**
 * 款项逐项实收额捕获（营业额分配事实父表）—— 员工端独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：admin src/lib/payment-allocatable.ts /
 * clientApi utils/payment-allocatable.js / payNotify 独立副本保持同义，由 snapshot 守护。
 *
 * 在每一笔款项落账的同事务内调用：把本次款项金额落到各 sale_item，
 * 写 sale_payment_item_receipts（有符号商品子项实收），并置该款项主流水行
 * allocation_status='待分配'。非「销售单/转换单」或历史单自动跳过。
 */

const ALLOCATABLE_ORDER_TYPES = ['销售单', '转换单']

function roundCents(v) {
  return Math.round(v * 100) / 100
}

// #300：receipt = 本次收款前后转入行已兑现价值的差；转出折抵值不随回款改变。
// 与 paid-sessions STEP 1.6 同一封顶/已折走行/累计边界规则，四端整段守护。
const CONVERSION_RECEIPT_DELTAS_SQL = `WITH conversion_receipt_order AS (
      SELECT so.sale_order_type,
             GREATEST(0, so.received::numeric - so.refunded_amount::numeric) AS net_received,
             COALESCE((
               SELECT SUM(GREATEST(0, -out_item.received::numeric))
               FROM sale_items out_item
               WHERE out_item.sale_order_id = $1 AND out_item.item_direction = '转出'
             ), 0)::numeric AS converted_value,
             COALESCE((
               SELECT SUM(in_item.sale_amount::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = $1 AND in_item.item_direction = '转入'
                 AND in_item.sale_amount::numeric > 0
                 AND NOT EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = in_item.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭')
             ), 0)::numeric AS in_total,
             COALESCE((
               SELECT SUM(in_item.received::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = $1 AND in_item.item_direction = '转入'
                 AND EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = in_item.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭')
             ), 0)::numeric AS waived_in_received
      FROM sale_orders so
      WHERE so.sale_order_id = $1
    ),
    ranked AS (
      SELECT si.sale_item_id,
             si.sale_amount::numeric AS item_sale_amount,
             conversion_receipt_order.in_total,
             LEAST(conversion_receipt_order.in_total,
                   GREATEST(0, conversion_receipt_order.converted_value + conversion_receipt_order.net_received
                               - conversion_receipt_order.waived_in_received)) AS target_received,
             LEAST(conversion_receipt_order.in_total,
                   GREATEST(0, conversion_receipt_order.converted_value
                     + GREATEST(0, conversion_receipt_order.net_received - $2::numeric)
                     - conversion_receipt_order.waived_in_received)) AS target_before,
             SUM(si.sale_amount::numeric) OVER (
               ORDER BY si.sale_item_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_sale_amount
      FROM sale_items si
      CROSS JOIN conversion_receipt_order
      WHERE conversion_receipt_order.sale_order_type = '转换单'
        AND si.sale_order_id = $1
        AND si.item_direction = '转入'
        AND si.sale_amount::numeric > 0
        AND NOT EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = si.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭')
    ),
    allocated AS (
      SELECT sale_item_id,
             (
               ROUND(target_received * cumulative_sale_amount / in_total, 2)
               - ROUND(target_received * (cumulative_sale_amount - item_sale_amount) / in_total, 2)
              - (
               ROUND(target_before * cumulative_sale_amount / in_total, 2)
               - ROUND(target_before * (cumulative_sale_amount - item_sale_amount) / in_total, 2)
             ))::numeric(10, 2) AS amount
      FROM ranked
      WHERE in_total > 0
    )
    SELECT a.sale_item_id, a.amount, si.sales_category
    FROM allocated a
    JOIN sale_items si ON si.sale_item_id = a.sale_item_id
    WHERE a.amount <> 0
    ORDER BY a.sale_item_id`

async function upsertReceipt(client, { salePaymentId, saleOrderId, saleItemId, amount, salesCategory }) {
  const rows = await client.query(
    `INSERT INTO sale_payment_item_receipts
       (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (sale_payment_id, sale_item_id)
     DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
     RETURNING id`,
    [salePaymentId, saleOrderId, saleItemId, amount.toFixed(2), salesCategory],
  )
  return rows.rows[0]?.id
}

async function capturePaymentAllocatables(client, { salePaymentId, saleOrderId, eventAmount, directedItems }) {
  const evt = roundCents(Number(eventAmount))
  if (!salePaymentId || !(evt > 0)) return []

  const ordRes = await client.query(
    'SELECT sale_order_type, legacy_source FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId],
  )
  const ord = ordRes.rows[0]
  if (!ord || !ALLOCATABLE_ORDER_TYPES.includes(ord.sale_order_type) || ord.legacy_source === 'workfine') {
    return []
  }

  const itemsRes = await client.query(
    `SELECT sale_item_id, sale_amount::numeric AS sale_amount, pending_received::numeric AS pending_received,
            waived_amount::numeric AS waived_amount, sales_category
       FROM sale_items
      WHERE sale_order_id = $1
        AND item_direction = '购买'
      ORDER BY sale_item_id`,
    [saleOrderId],
  )
  const items = itemsRes.rows

  if (items.length === 0) {
    const convRes = await client.query(CONVERSION_RECEIPT_DELTAS_SQL, [saleOrderId, evt])
    const rows = convRes.rows
    if (rows.length === 0) return []

    const convGuard = await client.query(`UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1 AND (allocation_status IS NULL OR allocation_status = '待分配')`, [salePaymentId])
    if (convGuard.rowCount === 0) return []
    const perItem = rows.map((r) => ({ saleItemId: r.sale_item_id, amount: Number(r.amount) }))

    const catMap = new Map(rows.map((r) => [r.sale_item_id, r.sales_category]))
    const out = []
    for (const d of perItem) {
      const receiptId = await upsertReceipt(client, {
        salePaymentId,
        saleOrderId,
        saleItemId: d.saleItemId,
        amount: d.amount,
        salesCategory: catMap.get(d.saleItemId) || null,
      })
      out.push({ receiptId, saleItemId: d.saleItemId, amount: d.amount, salesCategory: catMap.get(d.saleItemId) || null })
    }
    return out
  }

  const catMap = new Map(items.map((i) => [i.sale_item_id, i.sales_category]))
  let perItem = []

  if (Array.isArray(directedItems) && directedItems.length > 0) {
    perItem = directedItems
      .map((d) => ({ saleItemId: String(d.saleItemId), amount: roundCents(Number(d.amount)) }))
      .filter((d) => catMap.has(d.saleItemId) && d.amount > 0)
  } else {
    const priorRes = await client.query(
      `SELECT spir.sale_item_id, COALESCE(SUM(spir.amount::numeric), 0) AS allocated
         FROM sale_payment_item_receipts spir
         JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
        WHERE spir.sale_order_id = $1
          AND sop.status = '已支付'
          AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
        GROUP BY spir.sale_item_id`,
      [saleOrderId],
    )
    const priorMap = new Map(priorRes.rows.map((r) => [r.sale_item_id, Number(r.allocated)]))
    const caps = items.map((i) => {
      const prior = priorMap.get(i.sale_item_id) || 0
      const pending = Number(i.pending_received)
      const saleAmt = Number(i.sale_amount)
      // #182：折抵退出的行（waived_amount > 0）债务已归零、剩余权益已注销，不得再吸收新款项。
      // 它的 pending_received 被钉成「毛已付」作为 paid-sessions STEP 1 的预留依据，
      // 若照常算 pendCap = pending − prior，在无历史 receipt 的老单上（prior = 0）会得到
      // 一整笔产能，把本该落在真正欠款行上的回款分到已结清行 —— 钱记错归属，欠款行
      // 少拿 receipt、paid_sessions 解锁不足。
      if (Number(i.waived_amount) > 0) {
        return { saleItemId: i.sale_item_id, pendCap: 0, saleCap: 0 }
      }
      return {
        saleItemId: i.sale_item_id,
        pendCap: Math.max(0, roundCents(pending - prior)),
        saleCap: Math.max(0, roundCents(saleAmt - Math.max(pending, prior))),
      }
    })
    const pendCapTotal = roundCents(caps.reduce((s, c) => s + c.pendCap, 0))
    const saleCapTotal = roundCents(caps.reduce((s, c) => s + c.saleCap, 0))
    const evtCents = Math.round(evt * 100)

    const allocate = (amountCents, weightCaps) => {
      const positive = weightCaps.filter((c) => c.cap > 0)
      const totalW = positive.reduce((s, c) => s + c.cap, 0)
      if (totalW <= 0 || amountCents <= 0) return new Map()
      const parts = positive.map((c) => {
        const exact = (amountCents * c.cap) / totalW
        const cents = Math.floor(exact)
        return { saleItemId: c.saleItemId, cents, frac: exact - cents }
      })
      const rem = amountCents - parts.reduce((s, p) => s + p.cents, 0)
      parts.sort((a, b) => b.frac - a.frac)
      for (let i = 0; i < rem; i++) parts[i].cents += 1
      return new Map(parts.map((p) => [p.saleItemId, p.cents]))
    }

    const acc = new Map()
    const addCents = (m) => {
      for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v)
    }

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
      // 两段产能都为 0 的兜底（订单已结清却又来了一笔款）。#182：优先落在**未被折抵**的行上 ——
      // 折抵行的剩余权益已注销，把钱记到它头上既错归属又毫无意义。
      const fallback = items.find((i) => !(Number(i.waived_amount) > 0)) || items[0]
      perItem = [{ saleItemId: fallback.sale_item_id, amount: evt }]
    }
  }

  // CAS guard: 若已是 已分配（payNotify 重试/并发），跳过 receipt 写入
  const guardRes = await client.query(`UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1 AND (allocation_status IS NULL OR allocation_status = '待分配')`, [salePaymentId])
  if (guardRes.rowCount === 0) return []

  const out = []
  for (const d of perItem) {
    const cat = catMap.get(d.saleItemId) || null
    const receiptId = await upsertReceipt(client, {
      salePaymentId,
      saleOrderId,
      saleItemId: d.saleItemId,
      amount: d.amount,
      salesCategory: cat,
    })
    out.push({ receiptId, saleItemId: d.saleItemId, amount: d.amount, salesCategory: cat })
  }

  return out
}

async function refreshOrderAllocationRollup(client, saleOrderId) {
  await client.query(
    `UPDATE sale_orders
        SET allocation_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM sale_order_payments
                 WHERE sale_order_id = $1 AND allocation_status = '待分配'
              ) THEN '待分配'::allocation_status
              WHEN EXISTS (
                SELECT 1 FROM sale_order_payments
                 WHERE sale_order_id = $1 AND allocation_status = '已分配'
              ) THEN '已分配'::allocation_status
              ELSE NULL::allocation_status END,
            updated_at = NOW()
      WHERE sale_order_id = $1`,
    [saleOrderId],
  )
}

async function reconcileAllocationStatusAfterRefund(client, saleOrderId) {
  await client.query(
    `WITH full_refund_zero_net AS (
       SELECT so.sale_order_id
         FROM sale_orders so
        WHERE so.sale_order_id = $1
          AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) <= 0.01
     )
     UPDATE sale_order_payments p
        SET allocation_status = NULL
      WHERE p.sale_order_id = $1
        AND p.allocation_status IN ('待分配', '已分配')
        AND EXISTS (SELECT 1 FROM full_refund_zero_net)`,
    [saleOrderId],
  )
  await client.query(
    `WITH needs_allocation AS (
       SELECT p.id
         FROM sale_order_payments p
        WHERE p.sale_order_id = $1
          AND p.allocation_status = '待分配'
          AND (
            EXISTS (
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
      WHERE p.sale_order_id = $1
        AND p.allocation_status = '待分配'
        AND NOT EXISTS (SELECT 1 FROM needs_allocation n WHERE n.id = p.id)`,
    [saleOrderId],
  )
  await refreshOrderAllocationRollup(client, saleOrderId)
}

module.exports = {
  capturePaymentAllocatables,
  refreshOrderAllocationRollup,
  reconcileAllocationStatusAfterRefund,
  ALLOCATABLE_ORDER_TYPES,
}
