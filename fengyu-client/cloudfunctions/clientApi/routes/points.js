/**
 * 积分模块路由
 */

const pg = require('../db/pg')

/**
 * 查询积分余额及会员等级
 */
async function balance(ctx) {
  const { userId } = ctx.auth

  // Get point balance and level
  const rows = await pg.query(`
    SELECT cp.balance, cp.level_id, ml.name AS level_name, ml.min_points, ml.benefits
    FROM customer_points cp
    LEFT JOIN member_levels ml ON cp.level_id = ml.level_id
    WHERE cp.user_id = $1
  `, [userId])

  // Get next level
  let nextLevel = null
  if (rows.length > 0) {
    const currentBalance = rows[0].balance
    const nextLevels = await pg.query(
      'SELECT level_id, name, min_points FROM member_levels WHERE min_points > $1 ORDER BY min_points ASC LIMIT 1',
      [currentBalance]
    )
    if (nextLevels.length > 0) nextLevel = nextLevels[0]
  }

  ctx.result = {
    balance: rows.length > 0 ? rows[0].balance : 0,
    levelName: rows.length > 0 ? rows[0].level_name : null,
    levelBenefits: rows.length > 0 ? rows[0].benefits : null,
    nextLevel: nextLevel ? { name: nextLevel.name, minPoints: nextLevel.min_points } : null,
  }
}

/**
 * 积分变动历史
 */
async function history(ctx) {
  const { userId } = ctx.auth
  const { page = 1, pageSize = 20, type } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  let whereClause = 'WHERE pt.user_id = $1'
  const params = [userId]
  if (type) {
    params.push(type)
    whereClause += ` AND pt.type = $${params.length}`
  }
  params.push(pageSize, offset)

  const records = await pg.query(`
    SELECT pt.id, pt.type, pt.amount, pt.ref_order_id, pt.created_at
    FROM point_transactions pt
    ${whereClause}
    ORDER BY pt.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params)

  ctx.result = {
    records: records.map(r => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}

module.exports = { balance, history }
