/**
 * 退款审批通过 5 通道级联回滚 helper
 *
 * 2026-04-26 sale-order-domain-refactor §1.5 落地：
 * 退款审批通过时同事务级联回滚 5 类衍生数据（与 admin/cascadeRefund 同思路）。
 *
 * 通道：
 *   1. sale_allocations:    UPDATE SET is_void=true, voided_at=NOW()  (sale_allocations 无 voided_reason)
 *   2. service_commissions: UPDATE SET is_void=true, voided_at=NOW(), voided_reason=$
 *   3. user_coupons:        UPDATE SET status='未使用', used_at=NULL, used_sale_order_id=NULL（仅未过期）
 *   4. point_transactions:  INSERT 反向流水（消费冲销）+ customer_points.balance 重算
 *   5. pickup_records:      UPDATE picked_up_quantity 反向恢复（家居产品退款时）
 *
 * 调用约定：必须在 pg.transaction(client => ...) 内调用，传入事务 client。
 *
 * @param {object} client - 事务内 pg 客户端
 * @param {object} params
 * @param {string} params.saleOrderId          - 原销售单号（refSaleOrderId）
 * @param {string|null} params.saleItemId      - 关联具体 sale_item（部分退款时传，否则按 saleOrderId 全单）
 * @param {number|null} params.sessionCount    - 退疗程卡次数（pickup 反推用）
 * @param {string} params.refundReason         - 退款原因（写入 voided_reason）
 * @returns {Promise<object>} cascade 结果摘要
 */
async function cascadeRefund(client, params) {
  const { saleOrderId, saleItemId, sessionCount, refundReason } = params || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: cascadeRefund 缺少 saleOrderId')
  }

  const voidedReason = refundReason
    ? `退款审批通过：${String(refundReason).slice(0, 200)}`
    : '退款审批通过'
  const now = new Date()

  // 关联 sale_items：若传 saleItemId 仅作单行级联；否则按订单全行级联
  // 这里统一收口为 itemIds 数组，避免 SQL 双分支
  let itemIds = []
  if (saleItemId) {
    itemIds = [saleItemId]
  } else {
    const itemRes = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
      [saleOrderId],
    )
    itemIds = itemRes.rows.map((r) => r.sale_item_id)
  }

  // ========== 通道 1: sale_allocations 软删 ==========
  let voidedAllocations = 0
  if (itemIds.length > 0) {
    const allocRes = await client.query(
      `UPDATE sale_allocations
          SET is_void = true, voided_at = $1, updated_at = $1
        WHERE sale_item_id = ANY($2) AND is_void = false`,
      [now, itemIds],
    )
    voidedAllocations = allocRes.rowCount || 0
  }

  // ========== 通道 2: service_commissions 软删 ==========
  // 关联：service_commissions → service_items.sale_item_id ∈ itemIds
  let voidedCommissions = 0
  if (itemIds.length > 0) {
    const commRes = await client.query(
      `UPDATE service_commissions sc
          SET is_void = true, voided_at = $1, voided_reason = $2, updated_at = $1
         FROM service_items sit
        WHERE sc.service_item_id = sit.service_item_id
          AND sit.sale_item_id = ANY($3)
          AND sc.is_void = false`,
      [now, voidedReason, itemIds],
    )
    voidedCommissions = commRes.rowCount || 0
  }

  // ========== 通道 3: user_coupons 回滚（仅未过期）==========
  const couponRes = await client.query(
    `UPDATE user_coupons
        SET status = '未使用', used_at = NULL, used_sale_order_id = NULL
      WHERE used_sale_order_id = $1
        AND status = '已使用'
        AND (expire_at IS NULL OR expire_at > NOW())`,
    [saleOrderId],
  )
  const refundedCoupons = couponRes.rowCount || 0

  // ========== 通道 4: point_transactions 反向流水 ==========
  // 写入与原"消费赠送/回款赠送"对冲的"消费冲销"行；同事务重算 customer_points.balance
  // 为简化（与 admin 对齐口径）：把所有 ref_sale_order_id=该单 + 正向 (consume_grant/repay_grant) 的流水反冲
  // 此处不要求严格匹配 saleItemId，因为 point_transactions 颗粒度是订单级
  let reversedPoints = 0
  let pointsBalanceUpdated = false
  // 1) 查所有原赠送流水
  const giftRes = await client.query(
    `SELECT id, user_id, change_type, amount
       FROM point_transactions
      WHERE ref_sale_order_id = $1
        AND change_type IN ('消费赠送', '回款赠送')
        AND amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM point_transactions pt2
          WHERE pt2.ref_sale_order_id = $1
            AND pt2.change_type = '消费冲销'
            AND pt2.amount = -point_transactions.amount
        )`,
    [saleOrderId],
  )
  for (const row of giftRes.rows) {
    await client.query(
      `INSERT INTO point_transactions
         (user_id, ref_sale_order_id, change_type, amount, note, created_at)
       VALUES ($1, $2, '消费冲销', $3, $4, $5)`,
      [row.user_id, saleOrderId, -Number(row.amount), voidedReason, now],
    )
    reversedPoints++
    // 同事务重算 balance
    await client.query(
      `UPDATE customer_points SET balance = COALESCE((
         SELECT SUM(amount) FROM point_transactions WHERE user_id = $1
       ), 0), updated_at = $2 WHERE user_id = $1`,
      [row.user_id, now],
    )
    pointsBalanceUpdated = true
  }

  // ========== 通道 5: pickup_records 反向恢复 ==========
  // 仅在传入 saleItemId 时执行；以 sessionCount/quantity 为反推数量
  let rolledBackPickups = 0
  if (saleItemId && sessionCount && Number(sessionCount) > 0) {
    const pickupRes = await client.query(
      `UPDATE sale_items
          SET picked_up_quantity = GREATEST(0, COALESCE(picked_up_quantity, 0) - $1),
              updated_at = $2
        WHERE sale_item_id = $3
          AND product_type = '家居产品'
          AND COALESCE(picked_up_quantity, 0) > 0`,
      [Number(sessionCount), now, saleItemId],
    )
    rolledBackPickups = pickupRes.rowCount || 0
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    pointsBalanceUpdated,
    rolledBackPickups,
  }
}

module.exports = { cascadeRefund }
