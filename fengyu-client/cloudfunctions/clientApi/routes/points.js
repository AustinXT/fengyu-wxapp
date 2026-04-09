/**
 * 积分模块路由
 *
 * 注意：会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护，
 * 由 cronTask 每日凌晨3点根据滚动 12 个月消费额重算，与积分系统解耦。
 */

const pg = require('../db/pg')

/**
 * 查询积分余额及会员等级
 * 积分余额从 client_wechat_users.points_balance 直接读取（已去掉 customer_points 表）
 */
async function balance(ctx) {
  const { userId } = ctx.auth

  // 积分余额直接读 client_wechat_users.points_balance（已去掉 customer_points 表）
  const rows = await pg.query(`
    SELECT
      cwu.points_balance AS balance,
      cwu.member_level AS level_name
    FROM client_wechat_users cwu
    WHERE cwu.user_id = $1
  `, [userId])

  ctx.result = {
    balance: rows[0]?.balance || 0,
    levelName: rows[0]?.level_name || null,
    levelBenefits: null,
    nextLevel: null,
  }
}

/**
 * 积分变动历史
 */
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
      amount: r.amount,
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}

module.exports = { balance, history }
