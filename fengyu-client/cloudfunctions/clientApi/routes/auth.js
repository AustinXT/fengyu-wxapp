/**
 * 认证模块路由
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { requireFields } = require('../middleware/validate')

/**
 * 微信登录
 * 写入/更新 client_wechat_users
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  // 检查用户是否存在
  const users = await pg.query(
    'SELECT user_id, phone, bound_store_name, last_login_at FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  const now = new Date()

  if (users.length === 0) {
    // 新用户,创建记录
    const userId = generateUserId()
    await pg.query(
      `INSERT INTO client_wechat_users (user_id, openid, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $3, $3)`,
      [userId, OPENID, now]
    )

    ctx.result = {
      isNewUser: true,
      userId,
      phone: null,
      boundStoreName: null
    }
  } else {
    // 老用户,更新最后登录时间
    await pg.query(
      'UPDATE client_wechat_users SET last_login_at = $1, updated_at = $1 WHERE user_id = $2',
      [now, users[0].user_id]
    )

    ctx.result = {
      isNewUser: false,
      userId: users[0].user_id,
      phone: users[0].phone,
      boundStoreName: users[0].bound_store_name
    }
  }
}

/**
 * 绑定手机号
 * 同时补全历史订单的 client_user_id
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber } = ctx.event.payload

  // 参数校验
  requireFields('phoneNumber')(ctx, () => {})

  const now = new Date()

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  const userId = users[0].user_id

  // 检查手机号是否已被其他用户绑定
  const phoneUsers = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE phone = $1 AND user_id != $2',
    [phoneNumber, userId]
  )

  if (phoneUsers.length > 0) {
    throw new Error('INVALID_PARAMS: 该手机号已被其他用户绑定')
  }

  // 更新手机号
  await pg.query(
    'UPDATE client_wechat_users SET phone = $1, updated_at = $2 WHERE user_id = $3',
    [phoneNumber, now, userId]
  )

  // 补全历史订单的 client_user_id
  const updateResult = await pg.query(
    `UPDATE orders
     SET client_user_id = $1, updated_at = $2
     WHERE client_phone = $3 AND client_user_id IS NULL`,
    [userId, now, phoneNumber]
  )

  ctx.result = {
    success: true,
    userId,
    phone: phoneNumber,
    updatedOrdersCount: updateResult.rowCount || 0
  }
}

/**
 * 生成用户 ID(UUID)
 */
function generateUserId() {
  return 'user_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

module.exports = {
  login,
  bindPhone
}
