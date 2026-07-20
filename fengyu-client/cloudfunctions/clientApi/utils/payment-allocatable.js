/**
 * 回款逐项可分配额捕获（营业额分配基数）—— 顾客端独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：admin src/lib/payment-allocatable.ts /
 * clientApi utils/payment-allocatable.js / payNotify 内联 各保留同语义独立副本，
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
 * @param directedItems [{saleItemId, amount}] 定向回款逐项金额（现金+储值卡）；null/空 = 非定向按剩余实付(pending_received)比例摊
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
    `SELECT sale_item_id, sale_amount::numeric AS sale_amount, pending_received::numeric AS pending_received, sales_category
       FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
    [saleOrderId],
  )
  const items = itemsRes.rows
  if (items.length === 0) {
    // 转换单（明细仅转出/转入、无『购买』行）：按本笔净实收额落到「转入」行（业绩载体），
    // 与销售单一样按每笔回款逐笔分配。取转入行（LIMIT 1，按 sale_item_id 稳定排序）作 SPAI 挂载点；
    // 多笔回款各自 capture 累加 = 总实收；无转入行兜底：仅置回款行『待分配』，不产 SPAI（保持列表可见）。
    const convRes = await client.query(
      `SELECT sale_item_id, sales_category
         FROM sale_items
        WHERE sale_order_id = $1 AND item_direction = '转入'
        ORDER BY sale_item_id
        LIMIT 1`,
      [saleOrderId],
    )
    // CAS-EXEMPT: 转换单兜底首次置 allocation_status（初始化为『待分配』，非状态迁移，无前置态可守卫）
    await client.query(`UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1`, [salePaymentId])
    const convRow = convRes.rows[0]
    if (!convRow) return []
    const convCat = convRow.sales_category || null
    await client.query(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category`,
      [salePaymentId, saleOrderId, convRow.sale_item_id, evt.toFixed(2), convCat],
    )
    return [{ saleItemId: convRow.sale_item_id, amount: evt, salesCategory: convCat }]
  }
  const catMap = new Map(items.map((i) => [i.sale_item_id, i.sales_category]))

  let perItem = []
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
    // 最大余数法保证 Σ = evt 且每项非负。
    const priorRes = await client.query(
      `SELECT sale_item_id, COALESCE(SUM(amount::numeric), 0) AS allocated
         FROM sale_payment_allocatable_items WHERE sale_order_id = $1 GROUP BY sale_item_id`,
      [saleOrderId],
    )
    const priorMap = new Map(priorRes.rows.map((r) => [r.sale_item_id, Number(r.allocated)]))
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

    // 分配辅助：按 weights（Map saleItemId→cents 产能）把 amountCents 摊给 positive 项，最大余数法
    const allocate = (amountCents, weightCaps) => {
      const positive = weightCaps.filter((c) => c.cap > 0)
      const totalW = positive.reduce((s, c) => s + c.cap, 0)
      if (totalW <= 0 || amountCents <= 0) return new Map()
      const parts = positive.map((c) => {
        const exact = (amountCents * c.cap) / totalW
        const fl = Math.floor(exact)
        return { saleItemId: c.saleItemId, cents: fl, frac: exact - fl }
      })
      let rem = amountCents - parts.reduce((s, p) => s + p.cents, 0)
      parts.sort((a, b) => b.frac - a.frac)
      for (let i = 0; i < rem; i++) parts[i].cents += 1
      return new Map(parts.map((p) => [p.saleItemId, p.cents]))
    }

    const acc = new Map() // saleItemId → cents 累计
    const addCents = (m) => { for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v) }

    if (pendCapTotal > 0 || saleCapTotal > 0) {
      // 第一段：填 pend_cap（LEAST(evt, Σpend_cap)）
      const phase1Cents = Math.min(evtCents, Math.round(pendCapTotal * 100))
      addCents(allocate(phase1Cents, caps.map((c) => ({ saleItemId: c.saleItemId, cap: c.pendCap }))))
      // 第二段：溢出按 sale_cap 铺
      const phase2Cents = evtCents - phase1Cents
      if (phase2Cents > 0) {
        addCents(allocate(phase2Cents, caps.map((c) => ({ saleItemId: c.saleItemId, cap: c.saleCap }))))
      }
      perItem = items
        .map((i) => ({ saleItemId: i.sale_item_id, amount: (acc.get(i.sale_item_id) || 0) / 100 }))
        .filter((d) => d.amount > 0)
    } else {
      // 全摊满兜底：无任何产能（sale_amount 全为 0 等），全部记到首项
      perItem = [{ saleItemId: items[0].sale_item_id, amount: evt }]
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
 * 汇总刷新订单分配状态：有待分配回款→订单待分配；无待分配但有非NULL回款→已分配；无任何回款行→保持原值。
 * 维持 dashboard 待分配计数与订单列表展示（按回款逐笔分配的订单级汇总位）。
 */
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
                 WHERE sale_order_id = $1 AND allocation_status IS NOT NULL
              ) THEN '已分配'::allocation_status
              ELSE sale_orders.allocation_status END,
            updated_at = NOW()
      WHERE sale_order_id = $1`,
    [saleOrderId],
  )
}

module.exports = { capturePaymentAllocatables, refreshOrderAllocationRollup, ALLOCATABLE_ORDER_TYPES }
