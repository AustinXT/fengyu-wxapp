


async function grantShareGift(client, order) {
  
  const paid = Number(order && order.paidAmount)
  if (!order || !order.clientUserId || !order.saleOrderId || !(paid > 0)) {
    return { granted: false, reason: 'no_paid_amount' }
  }

  
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

  
  const inviterRow = (await client.query(
    `SELECT inviter_user_id FROM client_wechat_users WHERE user_id = $1`,
    [order.clientUserId]
  )).rows[0]
  const inviter = inviterRow && inviterRow.inviter_user_id
  if (!inviter) return { granted: false, reason: 'no_inviter' }

  
  if (cfg.inviterMustHavePaidOrder) {
    const rs = await client.query(
      `SELECT 1 FROM sale_orders
        WHERE client_user_id = $1 AND status IN ('已支付','已完成') LIMIT 1`,
      [inviter]
    )
    if (rs.rows.length === 0) return { granted: false, reason: 'inviter_not_qualified' }
  }

  
  const tpl = (await client.query(
    `SELECT template_id, is_active, validity_mode, valid_days, valid_to
       FROM coupon_templates WHERE template_id = $1`,
    [cfg.couponTemplateId]
  )).rows[0]
  if (!tpl || !tpl.is_active) return { granted: false, reason: 'template_unavailable' }

  
  const percent = Number(cfg.percent) > 0 ? Number(cfg.percent) : 0.15
  const raw = paid * percent
  const rounded = Math.round(raw * 100) / 100
  const minV = Number(cfg.minFaceValue) > 0 ? Number(cfg.minFaceValue) : 1
  const maxV = Number(cfg.maxFaceValue) > 0 ? Number(cfg.maxFaceValue) : 500
  const value = Math.max(minV, Math.min(maxV, rounded))

  
  let expireAt
  if (tpl.validity_mode === 'days' && tpl.valid_days) {
    expireAt = new Date(Date.now() + Number(tpl.valid_days) * 86400000)
  } else if (tpl.valid_to) {
    expireAt = new Date(tpl.valid_to)
  } else {
    const fallbackDays = Number(cfg.validityDays) > 0 ? Number(cfg.validityDays) : 90
    expireAt = new Date(Date.now() + fallbackDays * 86400000)
  }

  
  const couponRecipients = [
    ['inviter', inviter],
    ['invitee', order.clientUserId],
  ]
  for (const [role, userId] of couponRecipients) {
    const couponId = `sg-${role}-${order.saleOrderId}`
    
    await client.query(
      `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, face_value_override, external_ref, created_at)
       VALUES ($1, $2, $3, '未使用', $4, $5, $6, NOW())
       ON CONFLICT (coupon_id) DO NOTHING`,
      [couponId, cfg.couponTemplateId, userId, expireAt, value, couponId]
    )
  }

  
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
