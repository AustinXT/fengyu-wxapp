


const LEVEL_RANK = { 初钻: 1, 星钻: 2, 粉钻: 3, 金钻: 4, 黑钻: 5 }

function rank(level) {
  if (!level) return 0
  return LEVEL_RANK[level] || 0
}


function determineMemberLevel(spend, threshold) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}


async function recalcMemberLevel(client, clientUserId, threshold, sourceEnd) {
  if (!clientUserId) return

  const cur = await client.query(
    'SELECT member_level, customer_type FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  const row = cur.rows[0]
  
  if (!row || row.customer_type !== '会员客') return
  const oldLevel = row.member_level || null

  
  
  const spendRes = await client.query(
    `SELECT COALESCE(SUM(GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)) FILTER (
              WHERE so.sale_order_type IN ('销售单','转换单')
                AND so.paid_at >= (NOW() - INTERVAL '12 months')
            ), 0) AS spend
       FROM sale_orders so
      WHERE so.client_user_id = $1`,
    [clientUserId]
  )
  const spend = Number(spendRes.rows[0] && spendRes.rows[0].spend) || 0
  const newLevel = determineMemberLevel(spend, threshold)

  
  if (rank(newLevel) <= rank(oldLevel)) return

  
  const upd = await client.query(
    `UPDATE client_wechat_users
        SET old_member_level = member_level,
            member_level = $2::member_level,
            member_level_upgraded_at = NOW(),
            member_level_locked_until = NOW() + INTERVAL '150 days',
            updated_at = NOW()
      WHERE user_id = $1 AND member_level IS DISTINCT FROM $2::member_level`,
    [clientUserId, newLevel]
  )
  if (upd.rowCount > 0) {
    
    
    const detail = JSON.stringify({
      _v: 3,
      _t: 'transition',
      from: oldLevel,
      to: newLevel,
      context: {
        rolling12mSpend: spend,
        trigger: 'payment',
        direction: 'upgrade',
        lockedUntil: '+150d',
      },
    })
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, $3, NOW())`,
      [clientUserId, detail, sourceEnd]
    )
  }
}

module.exports = { LEVEL_RANK, rank, determineMemberLevel, recalcMemberLevel }
