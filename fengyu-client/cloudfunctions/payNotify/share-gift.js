/**
 * 分享礼发放（跨云函数共享）
 *
 * 新客首单结清时，按首笔 `首次支付` 实付金额 × percent（clamp 到 [min,max]）向邀请人和新客
 * 各发一张动态面值代金券 + 一条站内消息；以 sale_order_id 为幂等根键。
 *
 * 以下三份副本必须保持字节级一致：
 *   - fengyu-client/cloudfunctions/payNotify/share-gift.js
 *   - fengyu-client/cloudfunctions/clientApi/share-gift.js
 *   - fengyu-staff/cloudfunctions/staffApi/share-gift.js
 *
 * 参考 ticket：notes/tickets/2026-04-24-share-gift-reward.md §5.2
 */

/**
 * @param {import('pg').PoolClient} client  事务内 client（由调用方负责 BEGIN/COMMIT）
 * @param {{saleOrderId:string, clientUserId:string, paidAmount?:number|string, source?:string}} order
 * @returns {Promise<{granted:boolean, reason?:string, value?:number, inviter?:string}>}
 */
async function grantShareGift(client, order) {
  // 0. 基础参数 + 首笔首次支付实付金额必须 > 0
  if (!order || !order.clientUserId || !order.saleOrderId) {
    return { granted: false, reason: 'no_paid_amount' }
  }
  const firstPaymentRow = (await client.query(
    `SELECT amount
       FROM sale_order_payments
      WHERE sale_order_id = $1
        AND status = '已支付'
        AND change_type = '首次支付'
        AND amount > 0
      ORDER BY paid_at ASC NULLS LAST, created_at ASC, id ASC
      LIMIT 1`,
    [order.saleOrderId]
  )).rows[0]
  const paid = Number(firstPaymentRow && firstPaymentRow.amount)
  if (!(paid > 0)) {
    return { granted: false, reason: 'no_paid_amount' }
  }

  // 1. 读 config
  const cfgRow = (await client.query(
    "SELECT value FROM system_configs WHERE key = 'share_gift_config'"
  )).rows[0]
  if (!cfgRow || !cfgRow.value) return { granted: false, reason: 'no_config' }
  let cfg
  try {
    cfg = typeof cfgRow.value === 'string' ? JSON.parse(cfgRow.value) : cfgRow.value
  } catch (e) {
    return { granted: false, reason: 'bad_config' }
  }
  if (!cfg || !cfg.enabled || !cfg.couponTemplateId) {
    return { granted: false, reason: 'disabled' }
  }

  // 2. 首单判定：同一 client_user_id 除当前订单外无其他已支付/已完成订单
  const firstOrderRow = (await client.query(
    `SELECT COUNT(*)::int AS c FROM sale_orders
      WHERE client_user_id = $1
        AND status IN ('已支付','已完成')
        AND sale_order_id <> $2`,
    [order.clientUserId, order.saleOrderId]
  )).rows[0]
  if (!firstOrderRow || firstOrderRow.c !== 0) {
    return { granted: false, reason: 'not_first_order' }
  }

  // 3. 查邀请人
  const inviterRow = (await client.query(
    `SELECT inviter_user_id FROM client_wechat_users WHERE user_id = $1`,
    [order.clientUserId]
  )).rows[0]
  const inviter = inviterRow && inviterRow.inviter_user_id
  if (!inviter) return { granted: false, reason: 'no_inviter' }

  // 4. 可选：邀请人资格（需有至少一笔已支付订单）
  if (cfg.inviterMustHavePaidOrder) {
    const rs = await client.query(
      `SELECT 1 FROM sale_orders
        WHERE client_user_id = $1 AND status IN ('已支付','已完成') LIMIT 1`,
      [inviter]
    )
    if (rs.rows.length === 0) return { granted: false, reason: 'inviter_not_qualified' }
  }

  // 5. 模板必须存在且启用
  const tpl = (await client.query(
    `SELECT template_id, is_active, validity_mode, valid_days, valid_to
       FROM coupon_templates WHERE template_id = $1`,
    [cfg.couponTemplateId]
  )).rows[0]
  if (!tpl || !tpl.is_active) return { granted: false, reason: 'template_unavailable' }

  // 6. 计算面值（保留 2 位，clamp 到 [minFaceValue, maxFaceValue]）
  const percent = Number(cfg.percent) > 0 ? Number(cfg.percent) : 0.15
  const raw = paid * percent
  const rounded = Math.round(raw * 100) / 100
  const minV = Number(cfg.minFaceValue) > 0 ? Number(cfg.minFaceValue) : 1
  const maxV = Number(cfg.maxFaceValue) > 0 ? Number(cfg.maxFaceValue) : 500
  const value = Math.max(minV, Math.min(maxV, rounded))

  // 7. expireAt：模板 days → 从 NOW 推；fixed → 用 valid_to；兜底 cfg.validityDays || 90
  let expireAt
  if (tpl.validity_mode === 'days' && tpl.valid_days) {
    expireAt = new Date(Date.now() + Number(tpl.valid_days) * 86400000)
  } else if (tpl.valid_to) {
    expireAt = new Date(tpl.valid_to)
  } else {
    const fallbackDays = Number(cfg.validityDays) > 0 ? Number(cfg.validityDays) : 90
    expireAt = new Date(Date.now() + fallbackDays * 86400000)
  }

  // 8. 发券 × 2（inviter / invitee），ON CONFLICT DO NOTHING 幂等
  const couponRecipients = [
    ['inviter', inviter],
    ['invitee', order.clientUserId],
  ]
  for (const [role, userId] of couponRecipients) {
    const couponId = `sg-${role}-${order.saleOrderId}`
    // 双写 external_ref：DB 层 uq_user_coupons_external_ref 兜底 TOCTOU
    await client.query(
      `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, face_value_override, external_ref, created_at)
       VALUES ($1, $2, $3, '未使用', $4, $5, $6, NOW())
       ON CONFLICT (coupon_id) DO NOTHING`,
      [couponId, cfg.couponTemplateId, userId, expireAt, value, couponId]
    )
  }

  // 9. 消息 × 2（标题为空仅跳过当条，另一条照常发）
  const validityDays = Math.max(1, Math.ceil((expireAt.getTime() - Date.now()) / 86400000))
  const vars = {
    paidAmount: paid.toFixed(2),
    couponValue: value.toFixed(2),
    validityDays: String(validityDays),
  }
  const render = (t) => String(t == null ? '' : t).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''))

  const messageTuples = [
    ['inviter', inviter, cfg.messageInviterTitle, cfg.messageInviterBody],
    ['invitee', order.clientUserId, cfg.messageInviteeTitle, cfg.messageInviteeBody],
  ]
  for (const [role, userId, title, body] of messageTuples) {
    if (!title) {
      console.warn(`[share-gift] 消息标题为空，跳过该条通知: role=${role}, order=${order.saleOrderId}`)
      continue
    }
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, 'sale_order', $5, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, render(title), render(body), `sg-msg-${role}-${order.saleOrderId}`, order.saleOrderId]
    )
  }

  // 10. operation_logs 一条审计
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('share.giftGranted', 'sale_order', $1, $2::jsonb, $3, NOW())`,
    [
      order.saleOrderId,
      JSON.stringify({
        _v: 1,
        inviter,
        invitee: order.clientUserId,
        paidAmount: paid,
        percent,
        faceValue: value,
        templateId: cfg.couponTemplateId,
      }),
      order.source || 'payNotify',
    ]
  )

  return { granted: true, value, inviter }
}

module.exports = { grantShareGift }
