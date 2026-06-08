/**
 * 退款审批通过级联回滚 helper（逐 item + 语义收敛）
 *
 * 2026-04-26 sale-order-domain-refactor §1.5 落地；2026-06-08 重构（Bug Q/M）：
 *   - 改为按本次退款明细逐 item 级联（params.items），不再用单 saleItemId / null 整单分支；
 *     修复「多项退真子集（退 A、B 不退 C）误走整单分支清掉 C 的分配/提成/券/提货」（Bug Q）。
 *   - 通道 1/2（分配/提成）仅作废「被全退」的 item（isFullItemRefund），部分次数退款不动二者，
 *     保护已发生服务的提成（Bug M 语义收敛）。
 *   - 通道 3（券）仅整单全退（isWholeOrderRefund）才回滚。
 *
 * **修改本文件必须同步 fengyu-admin/src/lib/refund-cascade.ts**
 * （独立副本设计，用户 veto cloudfunctions-shared 抽取；漂移由
 * `staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * `'SUMMARY v3 §2 #14'` describe 块的 5 通道 keyword 守护捕获）。
 *
 * 通道：
 *   1. sale_allocations:    UPDATE SET is_void=true, voided_at=NOW()（仅全退 item）
 *   2. service_commissions: UPDATE SET is_void=true, voided_at=NOW(), voided_reason=$（仅全退 item）
 *   3. user_coupons:        UPDATE SET status='未使用'（仅整单全退）
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
async function cascadeRefund(client, params) {
  const { saleOrderId, items, isWholeOrderRefund, refundReason } = params || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: cascadeRefund 缺少 saleOrderId')
  }

  const voidedReason = refundReason
    ? `退款审批通过：${String(refundReason).slice(0, 200)}`
    : '退款审批通过'
  const now = new Date()

  // 兜底：items 为空（老退款行无 note.items / 整单退无明细）→ 查所有购买项视为全退（兼容历史数据）
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
      [saleOrderId],
    )
    effItems = r.rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  // 仅「全退」的 item 才作废分配/提成（Bug M 语义收敛）
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  // ========== 通道 1: sale_allocations 软删（仅全退 item）==========
  let voidedAllocations = 0
  if (fullItemIds.length > 0) {
    const allocRes = await client.query(
      `UPDATE sale_allocations
          SET is_void = true, voided_at = $1, updated_at = $1
        WHERE sale_item_id = ANY($2) AND is_void = false`,
      [now, fullItemIds],
    )
    voidedAllocations = allocRes.rowCount || 0
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
  if (wholeOrder) {
    const couponRes = await client.query(
      `UPDATE user_coupons
          SET status = '未使用', used_at = NULL, used_sale_order_id = NULL
        WHERE used_sale_order_id = $1
          AND status = '已使用'
          AND (expire_at IS NULL OR expire_at > NOW())`,
      [saleOrderId],
    )
    refundedCoupons = couponRes.rowCount || 0
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
    await client.query(
      `UPDATE client_wechat_users
          SET points_balance = COALESCE((
                SELECT SUM(amount) FROM point_transactions WHERE user_id = $1
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
  // 「已结算」= 已提货 + 已退），LEAST(quantity) 封顶，使 refundable 正确归零、不可超退。
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
    reversedPoints,
    pointsBalanceUpdated,
    rolledBackPickups,
  }
}

module.exports = { cascadeRefund }
