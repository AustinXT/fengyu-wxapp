/**
 * 积分模块路由
 *
 * 注意：会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护，
 * 由 cronTask 每日凌晨3点根据滚动 12 个月消费额重算，与积分系统解耦。
 */

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { getPointsToYuanRate, getPointsDeductionMaxRate } = require('../utils/config')

const MAX_PAGE_SIZE = 50

/**
 * 查询积分余额及会员等级
 * 积分余额从 client_wechat_users.points_balance 直接读取；即将到期积分从 point_batches 计算。
 */
async function balance(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const [pointsToYuanRate, pointsDeductionMaxRate] = await Promise.all([
    getPointsToYuanRate(),
    getPointsDeductionMaxRate(),
  ])

  // 积分余额直接读 client_wechat_users.points_balance，批次到期信息实时按 point_batches 计算。
  const rows = await pg.query(`
    SELECT
      cwu.points_balance AS balance,
      cwu.member_level AS level_name,
      COALESCE((
        SELECT SUM(pb.remaining_amount)
        FROM point_batches pb
        WHERE pb.user_id = cwu.user_id
          AND pb.remaining_amount > 0
          AND pb.expire_at > NOW()
          AND pb.expire_at <= NOW() + INTERVAL '60 days'
      ), 0) AS expiring_soon_points,
      (
        SELECT MIN(pb.expire_at)
        FROM point_batches pb
        WHERE pb.user_id = cwu.user_id
          AND pb.remaining_amount > 0
          AND pb.expire_at > NOW()
      ) AS next_expire_at
    FROM client_wechat_users cwu
    WHERE cwu.user_id = $1
  `, [userId])

  ctx.result = {
    balance: Number(rows[0]?.balance) || 0,
    levelName: rows[0]?.level_name || null,
    levelBenefits: null,
    nextLevel: null,
    expiringSoonPoints: Number(rows[0]?.expiring_soon_points) || 0,
    nextExpireAt: rows[0]?.next_expire_at || null,
    pointsToYuanRate,
    pointsDeductionMaxRate,
  }
}

/**
 * 积分变动历史
 */
async function history(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const page = payload.page === undefined ? 1 : payload.page
  const pageSize = payload.pageSize === undefined ? 20 : payload.pageSize

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('INVALID_PARAMS: page 必须为大于等于 1 的整数')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`INVALID_PARAMS: pageSize 必须为 1-${MAX_PAGE_SIZE} 的整数`)
  }

  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) {
    throw new Error('INVALID_PARAMS: page 超出允许范围')
  }

  const records = await pg.query(`
    SELECT pt.id, pt.type, pt.amount, pt.ref_order_id, pt.created_at
    FROM point_transactions pt
    WHERE pt.user_id = $1
    ORDER BY pt.created_at DESC, pt.id DESC
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
