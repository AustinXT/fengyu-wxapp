

const pg = require('../db/pg')


async function balance(ctx) {
  const { userId } = ctx.auth

  
  const rows = await pg.query(`
    SELECT
      cwu.points_balance AS balance,
      cwu.member_level AS level_name
    FROM client_wechat_users cwu
    WHERE cwu.user_id = $1
  `, [userId])

  ctx.result = {
    balance: Number(rows[0]?.balance) || 0,
    levelName: rows[0]?.level_name || null,
    levelBenefits: null,
    nextLevel: null,
  }
}


async function history(ctx) {
  const { userId } = ctx.auth
  const { page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const records = await pg.query(`
    SELECT pt.id, pt.type, pt.amount, pt.ref_order_id, pt.created_at
    FROM point_transactions pt
    WHERE pt.user_id = $1
    ORDER BY pt.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, pageSize, offset])

  ctx.result = {
    records: records.map(r => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}

module.exports = { balance, history }
