/**
 * 退款审批通过级联回滚 helper（逐 item + 语义收敛）
 *
 * 2026-04-26 sale-order-domain-refactor §1.5 落地；2026-06-08 重构（Bug Q/M）：
 *   - 改为按本次退款明细逐 item 级联（params.items），不再用单 saleItemId / null 整单分支；
 *     修复「多项退真子集（退 A、B 不退 C）误走整单分支清掉 C 的分配/提成/券/提货」（Bug Q）。
 *   - 通道 3（券）仅整单全退（isWholeOrderRefund）才回滚。
 *
 * 2026-06-24 退款联级重构（记负数冲销）：
 *   - 通道 1（销售提成 receipt 子分配）：对所有被退 item 写负数 receipt；若原 item 有正向子分配，
 *     再按本次实退额（params.items[].refundAmount）记负数镜像子分配（保留原正数行，报表 SUM 自动净额化）。
 *   - 通道 2（服务提成 service_commissions）：保持软删（仅零消费 isFullItemRefund item，恒 no-op）。
 *
 * **修改本文件必须同步 fengyu-admin/src/lib/refund-cascade.ts**
 * （独立副本设计，用户 veto cloudfunctions-shared 抽取；漂移由
 * `staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * `'SUMMARY v3 §2 #14'` describe 块的 5 通道 keyword 守护捕获）。
 *
 * 通道：
 *   1. sale_payment_item_allocations: INSERT 负数镜像子分配（仅原 item 有正向子分配时）
 *   2. service_commissions: UPDATE SET is_void=true, voided_at=NOW(), voided_reason=$（仅全退 item）
 *   3. user_coupons:        UPDATE SET status='未使用'（仅整单全退）+ 未使用分享礼券置为已过期
 *   4. point_transactions:  INSERT 反向流水（type='消费冲销'）+ client_wechat_users.points_balance 重算（订单级比例）
 *   5. pickup_records:      UPDATE sale_items.picked_up_quantity 反向恢复（逐被退家居 item，按 sessionCount）
 *
 * 列名 SOT 与 db/schema/points.ts 对齐：point_transactions.type / ref_order_id；无 note 列。
 *
 * @param {object} client - 事务内 pg 客户端
 * @param {object} params
 * @param {string} params.saleOrderId               - 原销售单号
 * @param {Array<{saleItemId:string, sessionCount:number|null, isFullItemRefund:boolean}>} params.items - 本次退款明细
 * @param {boolean} params.isWholeOrderRefund        - 是否整单全退（控制券回滚）
 * @param {string} params.refundReason               - 退款原因（写入 voided_reason）
 * @returns {Promise<object>} cascade 结果摘要
 */
function isLegacyOverpaySentinel(it) {
  return it && it.saleItemId === 'OVERPAY'
}

function addRefundCents(map, saleItemId, cents) {
  if (!saleItemId || cents <= 0) return
  map.set(saleItemId, (map.get(saleItemId) || 0) + cents)
}

function allocateCentsByWeight(totalCents, rows) {
  const weightTotal = rows.reduce((s, r) => s + r.weightCents, 0)
  const cappedTotal = Math.min(totalCents, weightTotal)
  if (cappedTotal <= 0 || rows.length === 0) return []
  const parts = rows.map((r) => {
    const exact = (cappedTotal * r.weightCents) / weightTotal
    const cents = Math.floor(exact)
    return { saleItemId: r.saleItemId, cents, frac: exact - cents }
  })
  const rem = cappedTotal - parts.reduce((s, p) => s + p.cents, 0)
  parts.sort((a, b) => b.frac - a.frac || a.saleItemId.localeCompare(b.saleItemId))
  for (let i = 0; i < rem; i += 1) parts[i].cents += 1
  return parts.filter((p) => p.cents > 0)
}

/**
 * 退款营业额按 role_type 独立成池，再在池内按员工尚未冲销的正向分配权重拆分。
 * 跨角色池各自最多冲销一份退款额；例如美容师/品项老师各 100%，全退后两池均归零。
 */
function planRolePoolRefundAllocations(rows, refundAmount) {
  const refundCents = Math.max(0, Math.round(Number(refundAmount || 0) * 100))
  if (refundCents <= 0 || rows.length === 0) return []

  const positiveReceiptCents = Math.round(Number(rows[0].positive_receipt_total || 0) * 100)
  const priorRefundReceiptCents = Math.round(Number(rows[0].prior_refund_receipt_total || 0) * 100)
  const availableReceiptCents = Math.max(0, positiveReceiptCents - priorRefundReceiptCents)
  const pools = new Map()

  for (const source of rows) {
    const positiveCents = Math.max(0, Math.round(Number(source.sum_total || 0) * 100))
    const priorNegativeCents = Math.max(0, Math.round(Number(source.prior_negative_total || 0) * 100))
    const remainingCents = Math.max(0, positiveCents - priorNegativeCents)
    if (remainingCents <= 0) continue
    const positiveCommissionCents = Math.max(0, Math.round(Number(source.sum_comm || 0) * 100))
    const priorNegativeCommissionCents = Math.max(0, Math.round(Number(source.prior_negative_comm || 0) * 100))
    const entry = {
      source,
      remainingCents,
      remainingCommissionCents: Math.max(0, positiveCommissionCents - priorNegativeCommissionCents),
    }
    const pool = pools.get(source.role_type)
    if (pool) pool.push(entry)
    else pools.set(source.role_type, [entry])
  }

  if (pools.size > 0 && availableReceiptCents <= 0) {
    throw new Error('INVALID_STATE: 退款营业额分配缺少可冲销的商品行实收')
  }

  const targets = []
  for (const roleType of Array.from(pools.keys()).sort()) {
    const pool = pools.get(roleType) || []
    const poolRemainingCents = pool.reduce((sum, row) => sum + row.remainingCents, 0)
    if (poolRemainingCents <= 0) continue
    const proportionalTarget = Math.round((refundCents * poolRemainingCents) / availableReceiptCents)
    const targetCents = Math.min(refundCents, poolRemainingCents, Math.max(0, proportionalTarget))
    if (targetCents <= 0) continue

    const parts = pool.map((row) => {
      const exact = (targetCents * row.remainingCents) / poolRemainingCents
      const cents = Math.floor(exact)
      return { ...row, cents, frac: exact - cents }
    })
    let remainder = targetCents - parts.reduce((sum, part) => sum + part.cents, 0)
    parts.sort((a, b) => b.frac - a.frac || a.source.employee_id.localeCompare(b.source.employee_id))
    for (let i = 0; remainder > 0 && parts.length > 0; i = (i + 1) % parts.length) {
      if (parts[i].cents < parts[i].remainingCents) {
        parts[i].cents += 1
        remainder -= 1
      }
    }

    for (const part of parts) {
      if (part.cents <= 0) continue
      const commissionCents = part.cents >= part.remainingCents
        ? part.remainingCommissionCents
        : Math.min(
            part.remainingCommissionCents,
            Math.round((part.remainingCommissionCents * part.cents) / part.remainingCents),
          )
      const ratio = Math.min(1, Math.max(0.001, part.cents / refundCents))
      targets.push({
        source: part.source,
        allocatedCents: part.cents,
        commissionCents,
        allocationRatio: ratio.toFixed(3),
      })
    }
  }
  return targets
}

async function buildReceiptRefundItems(client, saleOrderId, refundPaymentId, effItems) {
  const requestedCentsByItem = new Map()
  let overpayCents = 0
  for (const it of effItems) {
    const cents = Math.round(Number(it.refundAmount || 0) * 100)
    if (cents <= 0) continue
    if (isLegacyOverpaySentinel(it)) {
      overpayCents += cents
    } else {
      addRefundCents(requestedCentsByItem, it.saleItemId, cents)
    }
  }

  const requestedTotalCents = overpayCents
    + Array.from(requestedCentsByItem.values()).reduce((sum, cents) => sum + cents, 0)
  if (requestedTotalCents <= 0) return []

  const residualRows = await client.query(
      `SELECT si.sale_item_id,
              COALESCE(SUM(CASE
                WHEN sop.status = '已支付'
                 AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
                THEN spir.amount::numeric ELSE 0 END), 0) AS positive_amount,
              COALESCE(ABS(SUM(CASE
                WHEN sop.status = '已支付'
                 AND sop.change_type = '退款'
                 AND spir.sale_payment_id IS DISTINCT FROM $2
                THEN spir.amount::numeric ELSE 0 END)), 0) AS prior_refund_amount
         FROM sale_items si
         LEFT JOIN sale_payment_item_receipts spir
           ON spir.sale_order_id = si.sale_order_id
          AND spir.sale_item_id = si.sale_item_id
         LEFT JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
        WHERE si.sale_order_id = $1
          AND si.item_direction = '购买'
        GROUP BY si.sale_item_id
        ORDER BY si.sale_item_id`,
      [saleOrderId, refundPaymentId],
  )
  const availableCentsByItem = new Map(residualRows.rows.map((r) => [
    r.sale_item_id,
    Math.max(
      0,
      Math.round(Number(r.positive_amount || 0) * 100)
        - Math.round(Number(r.prior_refund_amount || 0) * 100),
    ),
  ]))
  const refundCentsByItem = new Map()
  let overflowCents = overpayCents
  for (const [saleItemId, requestedCents] of requestedCentsByItem) {
    const mappedCents = Math.min(requestedCents, availableCentsByItem.get(saleItemId) || 0)
    addRefundCents(refundCentsByItem, saleItemId, mappedCents)
    overflowCents += requestedCents - mappedCents
  }
  const candidates = residualRows.rows
    .map((r) => ({
      saleItemId: r.sale_item_id,
      weightCents: Math.max(
        0,
        (availableCentsByItem.get(r.sale_item_id) || 0) - (refundCentsByItem.get(r.sale_item_id) || 0),
      ),
    }))
    .filter((r) => r.weightCents > 0)
  for (const part of allocateCentsByWeight(overflowCents, candidates)) {
    addRefundCents(refundCentsByItem, part.saleItemId, part.cents)
  }
  const mappedTotalCents = Array.from(refundCentsByItem.values()).reduce((sum, cents) => sum + cents, 0)
  if (mappedTotalCents !== requestedTotalCents) {
    throw new Error('INVALID_STATE: 退款金额无法完整映射到商品行实收')
  }

  return Array.from(refundCentsByItem.entries()).map(([saleItemId, cents]) => ({
    saleItemId,
    refundAmount: cents / 100,
  }))
}

async function cascadeRefund(client, params) {
  const { saleOrderId, refundPaymentId, items, isWholeOrderRefund, refundReason } = params || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: cascadeRefund 缺少 saleOrderId')
  }

  const voidedReason = refundReason
    ? `退款审批通过：${String(refundReason).slice(0, 500)}`
    : '退款审批通过'
  const now = new Date()

  // 兜底：items 为空（老退款行无 note.items / 整单退无明细）→ 查所有购买项视为全退（兼容历史数据）
  // ⚠️切勿把 OVERPAY 哨兵行（多收余数退款，refSaleItemId='OVERPAY'）从这里过滤掉：
  //   余数单独退时它是 effItems 唯一元素，过滤会使 effItems 变空 → 触发本兜底 → 误把全品项当全退+wholeOrder=true。
  //   哨兵行天然安全：下方通道 1/2/5 按 sale_item_id='OVERPAY' 查询无匹配自动跳过；
  //   通道 3 由 wholeOrder（创建时对余数单为 false）控制不回滚券；通道 4（积分）订单级按 refunded/received 比例冲销（退款本应如此）。
  //   详见 utils/refund.js computeOverpayRemainder + plan fy-xsd-wx-2607150028。
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
      [saleOrderId],
    )
    effItems = r.rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, refundAmount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  // 仅「零消费全退」item 才作废服务提成（通道 2）+ 参与整单券判定（通道 3）；通道 1 不再依赖（Bug M 语义收敛）
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  // ========== 通道 1: receipt + sale_payment_item_allocations 记负数冲销 ==========
  // 先为被退 item 写负数 receipt，确保 sale_items.received / paid_sessions 可按净额重算。
  // OVERPAY 是订单级哨兵，不触发其它级联；在本通道按正向 receipt 残留映射回真实 item。
  // 仅当该 item 有原正向子分配时，才按原 (employee, role) 权重生成负数子分配；无原正向则不生成赤字分配。
  let voidedAllocations = 0
  let refundAllocatedCents = 0
  const receiptRefundItems = await buildReceiptRefundItems(client, saleOrderId, refundPaymentId, effItems)
  for (const it of receiptRefundItems) {
    const refundAmt = Number(it.refundAmount || 0)
    if (refundAmt <= 0) continue
    const itemRows = await client.query(
      `SELECT sales_category FROM sale_items
        WHERE sale_order_id = $1
          AND sale_item_id = $2
        LIMIT 1`,
      [saleOrderId, it.saleItemId],
    )
    if (itemRows.rows.length === 0) continue
    const refundReceiptRows = await client.query(
      `INSERT INTO sale_payment_item_receipts
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
       RETURNING id`,
      [refundPaymentId, saleOrderId, it.saleItemId, (-refundAmt).toFixed(2), itemRows.rows[0].sales_category || null],
    )
    const refundReceiptId = refundReceiptRows.rows[0] && refundReceiptRows.rows[0].id
    if (!refundReceiptId) continue

    const allocRows = (await client.query(
      `WITH positive_grouped AS (
         SELECT spia.employee_id, spia.role_type,
                MAX(spia.department_name) AS dept,
                SUM(spia.allocated_amount::numeric) AS sum_total,
                MAX(spia.commission_rate) AS rate,
                COALESCE(SUM(spia.commission_amount::numeric), 0) AS sum_comm
           FROM sale_payment_item_allocations spia
           JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
           JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
          WHERE spir.sale_order_id = $1
            AND spir.sale_item_id = $2
            AND spia.is_void = false
            AND spia.allocated_amount > 0
            AND spir.amount > 0
            AND sop.status = '已支付'
            AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
          GROUP BY spia.employee_id, spia.role_type
       ),
       prior_negative AS (
         SELECT spia.employee_id, spia.role_type,
                COALESCE(ABS(SUM(spia.allocated_amount::numeric)), 0) AS prior_negative_total,
                COALESCE(ABS(SUM(spia.commission_amount::numeric)), 0) AS prior_negative_comm
           FROM sale_payment_item_allocations spia
           JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
           JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
          WHERE spir.sale_order_id = $1
            AND spir.sale_item_id = $2
            AND spia.is_void = false
            AND spia.allocated_amount < 0
            AND spir.amount < 0
            AND spir.sale_payment_id IS DISTINCT FROM $3
            AND sop.status = '已支付'
            AND sop.change_type = '退款'
          GROUP BY spia.employee_id, spia.role_type
       ),
       receipt_totals AS (
         SELECT COALESCE(SUM(CASE
                  WHEN sop.status = '已支付'
                   AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
                   AND spir.amount > 0
                  THEN spir.amount::numeric ELSE 0 END), 0) AS positive_receipt_total,
                COALESCE(ABS(SUM(CASE
                  WHEN sop.status = '已支付'
                   AND sop.change_type = '退款'
                   AND spir.amount < 0
                   AND spir.sale_payment_id IS DISTINCT FROM $3
                  THEN spir.amount::numeric ELSE 0 END)), 0) AS prior_refund_receipt_total
           FROM sale_payment_item_receipts spir
           JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
          WHERE spir.sale_order_id = $1
            AND spir.sale_item_id = $2
       )
       SELECT pg.*, COALESCE(pn.prior_negative_total, 0) AS prior_negative_total,
              COALESCE(pn.prior_negative_comm, 0) AS prior_negative_comm,
              rt.positive_receipt_total, rt.prior_refund_receipt_total
         FROM positive_grouped pg
         LEFT JOIN prior_negative pn
           ON pn.employee_id = pg.employee_id AND pn.role_type = pg.role_type
         CROSS JOIN receipt_totals rt`,
      [saleOrderId, it.saleItemId, refundPaymentId],
    )).rows
    if (allocRows.length === 0) continue
    const targets = planRolePoolRefundAllocations(allocRows, refundAmt)
    for (const target of targets) {
      const voidTotal = target.allocatedCents / 100
      const voidComm = target.commissionCents / 100
      const insertRes = await client.query(
          `INSERT INTO sale_payment_item_allocations
             (sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio,
              allocated_amount, commission_rate, commission_amount, is_void, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $9)
           ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false
           DO UPDATE SET department_name = EXCLUDED.department_name,
                         allocation_ratio = EXCLUDED.allocation_ratio,
                         allocated_amount = EXCLUDED.allocated_amount,
                         commission_rate = EXCLUDED.commission_rate,
                         commission_amount = EXCLUDED.commission_amount,
                         updated_at = EXCLUDED.updated_at`,
        [refundReceiptId, target.source.employee_id, target.source.role_type, target.source.dept,
         target.allocationRatio, (-voidTotal).toFixed(2), target.source.rate,
         (-voidComm).toFixed(2), now],
      )
      voidedAllocations += insertRes.rowCount || 0
    }
    const currentRefundAlloc = await client.query(
      `SELECT COALESCE(ABS(SUM(spia.allocated_amount::numeric)), 0) AS refund_allocated
         FROM sale_payment_item_allocations spia
        WHERE spia.sale_payment_item_receipt_id = $1
          AND spia.is_void = false
          AND spia.allocated_amount < 0`,
      [refundReceiptId],
    )
    const allocatedCents = Math.round(Number(currentRefundAlloc.rows[0]?.refund_allocated || 0) * 100)
    if (allocatedCents > 0) {
      refundAllocatedCents += allocatedCents
    }
  }
  if (refundAllocatedCents > 0) {
    await client.query(
      `UPDATE sale_order_payments
        SET allocation_status = '已分配'
      WHERE id = $1
        AND change_type = '退款'
          AND (allocation_status IS NULL OR allocation_status = '待分配')`,
      [refundPaymentId],
    )
  }

  // ========== 通道 2: service_commissions 软删（仅全退 item）==========
  let voidedCommissions = 0
  if (fullItemIds.length > 0) {
    const commRes = await client.query(
      `UPDATE service_commissions sc
          SET is_void = true, voided_at = $1, voided_reason = $2, updated_at = $1
         FROM service_items sit
        WHERE sc.service_item_id = sit.service_item_id
          AND sit.sale_item_id = ANY($3)
          AND sc.is_void = false`,
      [now, voidedReason, fullItemIds],
    )
    voidedCommissions = commRes.rowCount || 0
  }

  // ========== 通道 3: user_coupons 回滚（仅整单全退；部分退款不退券）==========
  let refundedCoupons = 0
  let revokedShareGiftCoupons = 0
  if (wholeOrder) {
    const couponRes = await client.query(
      `UPDATE user_coupons
          SET status = '未使用', used_at = NULL, used_sale_order_id = NULL, updated_at = NOW()
        WHERE used_sale_order_id = $1
          AND status = '已使用'
          AND (expire_at IS NULL OR expire_at > NOW())`,
      [saleOrderId],
    )
    refundedCoupons = couponRes.rowCount || 0

    const shareGiftRes = await client.query(
      `UPDATE user_coupons
          SET status = '已过期',
              expire_at = NOW() - INTERVAL '1 second',
              updated_at = NOW()
        WHERE coupon_id = ANY($1::text[])
          AND status = '未使用'`,
      // text[] 是 SQL 唯一占位符 $1 的单个绑定值，不能拆成两个参数。
      [[`sg-inviter-${saleOrderId}`, `sg-invitee-${saleOrderId}`]],
    )
    revokedShareGiftCoupons = shareGiftRes.rowCount || 0
  }

  // ========== 通道 4: point_transactions 比例冲销（订单级，按 refunded/received 比例）==========
  let reversedPoints = 0
  let pointsBalanceUpdated = false
  const giftRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
       FROM point_transactions
      WHERE ref_order_id = $1
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0`,
    [saleOrderId],
  )
  const grantedTotal = Number(giftRes.rows[0]?.g || 0)
  const pointUserId = giftRes.rows[0]?.user_id || null
  if (grantedTotal > 0 && pointUserId) {
    const orderRes = await client.query(
      `SELECT received, COALESCE(refunded_amount, 0) AS refunded
         FROM sale_orders
        WHERE sale_order_id = $1`,
      [saleOrderId],
    )
    const received = Number(orderRes.rows[0]?.received || 0)
    const refunded = Number(orderRes.rows[0]?.refunded || 0)
    const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
    const reversedRes = await client.query(
      `SELECT COALESCE(-SUM(amount), 0) AS reversed
         FROM point_transactions
        WHERE user_id = $1
          AND ref_order_id = $2
          AND type = '消费冲销'`,
      [pointUserId, saleOrderId],
    )
    const reverseDelta = Math.max(0, target - Number(reversedRes.rows[0]?.reversed || 0))
    await client.query(
      `INSERT INTO point_transactions
         (user_id, ref_order_id, type, amount, created_at)
       VALUES ($1, $2, '消费冲销', $3, $4)
       ON CONFLICT (user_id, ref_order_id, type)
         WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
       DO UPDATE SET amount = EXCLUDED.amount`,
      [pointUserId, saleOrderId, -target, now],
    )
    reversedPoints = target
    if (reverseDelta > 0) {
      await client.query(
        `WITH locked_batches AS (
           SELECT id, ref_order_id, expire_at, remaining_amount
             FROM point_batches
            WHERE user_id = $1
              AND remaining_amount > 0
              AND expire_at > NOW()
            ORDER BY CASE WHEN $3::text IS NOT NULL AND ref_order_id = $3 THEN 0 ELSE 1 END, expire_at, id
            FOR UPDATE
         ),
         prioritized AS (
           SELECT id,
                  remaining_amount,
                  SUM(remaining_amount) OVER (
                    ORDER BY CASE WHEN $3::text IS NOT NULL AND ref_order_id = $3 THEN 0 ELSE 1 END, expire_at, id
                  ) AS running
             FROM locked_batches
         ),
         allocation AS (
           SELECT id,
                  LEAST(remaining_amount, GREATEST(0, $2 - (running - remaining_amount))) AS consume_amount
             FROM prioritized
            WHERE running - remaining_amount < $2
         )
         UPDATE point_batches pb
            SET remaining_amount = pb.remaining_amount - allocation.consume_amount,
                updated_at = NOW()
           FROM allocation
          WHERE pb.id = allocation.id
            AND allocation.consume_amount > 0`,
        [pointUserId, reverseDelta, saleOrderId],
      )
    }
    await client.query(
      `UPDATE client_wechat_users
          SET points_balance = COALESCE((
                SELECT SUM(remaining_amount)
                  FROM point_batches
                 WHERE user_id = $1
                   AND expire_at > NOW()
              ), 0),
              points_updated_at = $2,
              updated_at = $2
        WHERE user_id = $1`,
      [pointUserId, now],
    )
    pointsBalanceUpdated = true
  }

  // ========== 通道 5: 家居退款计入已结算（逐被退家居 item，按退款数量）==========
  // 修复（家居提货账 schema-free 止血 2026-06-08）：退家居退的是「未提货」数量，
  // 原 `GREATEST(0, picked_up - qty)` 错把退款数从已提货里减 → 损坏提货账 + refundable
  // (=quantity-picked_up) 回升致可重复退（资损）。改为把已退数计入 picked_up（语义升级为
  // 「已结算」= 已提货 + 已退 + 已转换（2026-09-14 #125）），LEAST(quantity) 封顶，使 refundable 正确归零、不可超退。
  // 代价：picked_up 不再纯指已物理提货（pickup_records 仍是真实提货源）；彻底分离待 refunded_quantity 列。
  // 字段名 rolledBackPickups 保留（跨端 snapshot 守护），语义现为「计入已结算的家居退款行数」。
  let rolledBackPickups = 0
  for (const it of effItems) {
    const qty = it.sessionCount && Number(it.sessionCount) > 0 ? Number(it.sessionCount) : null
    if (!qty) continue
    const pickupRes = await client.query(
      `UPDATE sale_items
          SET picked_up_quantity = LEAST(quantity, COALESCE(picked_up_quantity, 0) + $1),
              updated_at = $2
        WHERE sale_item_id = $3
          AND product_type = '家居产品'`,
      [qty, now, it.saleItemId],
    )
    rolledBackPickups += pickupRes.rowCount || 0
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    revokedShareGiftCoupons,
    reversedPoints,
    pointsBalanceUpdated,
    rolledBackPickups,
  }
}

module.exports = { cascadeRefund, planRolePoolRefundAllocations }
