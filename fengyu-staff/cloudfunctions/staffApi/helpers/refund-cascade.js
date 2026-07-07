/**
 * 退款审批通过级联回滚 helper（逐 item + 语义收敛）
 *
 * 2026-04-26 sale-order-domain-refactor §1.5 落地；2026-06-08 重构（Bug Q/M）：
 *   - 改为按本次退款明细逐 item 级联（params.items），不再用单 saleItemId / null 整单分支；
 *     修复「多项退真子集（退 A、B 不退 C）误走整单分支清掉 C 的分配/提成/券/提货」（Bug Q）。
 *   - 通道 3（券）仅整单全退（isWholeOrderRefund）才回滚。
 *
 * 2026-06-24 退款联级重构（记负数冲销）：
 *   - 通道 1（销售提成 sale_allocations）：由「软删 is_void」改为「记负数冲销」——对所有被退 item
 *     按本次实退额（params.items[].refundAmount）记负数镜像行（保留原正数行，报表 SUM 自动净额化），
 *     负数行挂退款流水 id（params.refundPaymentId）。消费过的卡退剩余次数 → 等比部分冲销，已消费业绩保留。
 *   - 通道 2（服务提成 service_commissions）：保持软删（仅零消费 isFullItemRefund item，恒 no-op）。
 *
 * 本文件为 staff 端独立实现，可自由修改，无需同步其他端。
 * （fengyu-admin 已有更新版本的 refund-cascade.ts，此 helper 仅为兼容旧调用保留，
 *   修改不会影响 admin 端，也不会触发任何跨端一致性校验。）
 *
 * 通道：
 *   1. sale_allocations:    INSERT 负数镜像行（记负数冲销销售提成，对所有被退 item 按 refundAmount，挂退款流水 id）
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
  const { saleOrderId, refundPaymentId, items, isWholeOrderRefund, refundReason } = params || {}
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
    effItems = r.rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, refundAmount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  // 仅「零消费全退」item 才作废服务提成（通道 2）+ 参与整单券判定（通道 3）；通道 1 不再依赖（Bug M 语义收敛）
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  // ========== 通道 1: sale_allocations 记负数冲销（销售提成；对所有被退 item 按实退额）==========
  // 业务口径（2026-06-24）：退款撤销营业额分配 = 记负数（保留原正数行 + 新增负数镜像行，报表 SUM 自动净额化）。
  // item 级目标冲销额 = min(本次该 item 退款额, 该 item 活跃正数分配 Σtotal_amount)，按各 (emp,role) 行
  // total_amount 权重最大余数法分摊到分；负数行挂退款流水 id（新维度，不撞 uq_sale_alloc_item_emp_role_payment）。
  // 消费过的卡退剩余次数 → 退额 < 已分配额 → 等比部分冲销，已消费部分业绩保留。两端镜像 admin lib/refund-cascade.ts。
  let voidedAllocations = 0
  for (const it of effItems) {
    const refundAmt = Number(it.refundAmount || 0)
    if (refundAmt <= 0) continue
    const allocRows = (await client.query(
      `SELECT employee_id, role_type,
              MAX(allocation_ratio) AS ratio,
              MAX(department_name) AS dept,
              SUM(total_amount::numeric) AS sum_total,
              MAX(commission_rate) AS rate,
              COALESCE(SUM(commission_amount::numeric), 0) AS sum_comm
         FROM sale_allocations
        WHERE sale_item_id = $1 AND is_void = false AND total_amount > 0
        GROUP BY employee_id, role_type`,
      [it.saleItemId],
    )).rows
    if (allocRows.length === 0) continue
    const baseCents = allocRows.reduce((s, r) => s + Math.round(Number(r.sum_total) * 100), 0)
    if (baseCents <= 0) continue
    const targetCents = Math.min(Math.round(refundAmt * 100), baseCents)
    // 最大余数法：按各组 total_amount 权重分摊 targetCents，余数逐分补给小数部分最大者（精确到分）
    const parts = allocRows.map((r) => {
      const wCents = Math.round(Number(r.sum_total) * 100)
      const exact = (targetCents * wCents) / baseCents
      const floorC = Math.floor(exact)
      return { r, cents: floorC, frac: exact - floorC }
    })
    const rem = targetCents - parts.reduce((s, p) => s + p.cents, 0)
    parts.sort((a, b) => b.frac - a.frac)
    for (let i = 0; i < rem; i++) parts[i].cents += 1
    for (const p of parts) {
      if (p.cents <= 0) continue
      const voidTotal = p.cents / 100
      const sumTotal = Number(p.r.sum_total)
      const sumComm = Number(p.r.sum_comm || 0)
      // 提成按该组 total→comm 比例同步冲销（保持原提成率），精确到分
      const voidComm = sumTotal > 0 ? Math.round((sumComm * voidTotal) / sumTotal * 100) / 100 : 0
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, role_type, department_name, allocation_ratio,
            total_amount, commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $10)
         ON CONFLICT (sale_item_id, employee_id, role_type, sale_payment_id) WHERE is_void = false DO NOTHING`,
        [it.saleItemId, p.r.employee_id, p.r.role_type, p.r.dept, p.r.ratio,
         (-voidTotal).toFixed(2), p.r.rate, (-voidComm).toFixed(2), refundPaymentId, now],
      )
      voidedAllocations += 1
    }
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
