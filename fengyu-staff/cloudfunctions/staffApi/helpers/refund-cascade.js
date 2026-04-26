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
 *   4. point_transactions:  INSERT 反向流水（type='消费冲销'）+ client_wechat_users.points_balance 重算
 *   5. pickup_records:      UPDATE picked_up_quantity 反向恢复（家居产品退款时）
 *
 * 列名 SOT（与 db/schema/points.ts 完全对齐）：
 *   - point_transactions.type        （不是 change_type）
 *   - point_transactions.ref_order_id（不是 ref_sale_order_id）
 *   - point_transactions 无 note 列；balance 重算写 client_wechat_users.points_balance（无独立 customer_points 表）
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
  // 写入与原"消费赠送/回款赠送/获取"对冲的"消费冲销"行；同事务重算 client_wechat_users.points_balance
  // SOT 对齐 db/schema/points.ts：列名 type / ref_order_id（不是 change_type / ref_sale_order_id）
  // point_transactions 无 note 列。
  let reversedPoints = 0
  let pointsBalanceUpdated = false
  // 1) 查所有原赠送流水（注意：列名为 type，不是 change_type）
  const giftRes = await client.query(
    `SELECT id, user_id, type, amount
       FROM point_transactions
      WHERE ref_order_id = $1
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM point_transactions pt2
          WHERE pt2.ref_order_id = $1
            AND pt2.type = '消费冲销'
            AND pt2.amount = -point_transactions.amount
        )`,
    [saleOrderId],
  )
  for (const row of giftRes.rows) {
    await client.query(
      `INSERT INTO point_transactions
         (user_id, ref_order_id, type, amount, created_at)
       VALUES ($1, $2, '消费冲销', $3, $4)`,
      [row.user_id, saleOrderId, -Number(row.amount), now],
    )
    reversedPoints++
    // 同事务重算 balance（合并表 client_wechat_users.points_balance，无独立 customer_points 表）
    await client.query(
      `UPDATE client_wechat_users
          SET points_balance = COALESCE((
                SELECT SUM(amount) FROM point_transactions WHERE user_id = $1
              ), 0),
              points_updated_at = $2,
              updated_at = $2
        WHERE user_id = $1`,
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
