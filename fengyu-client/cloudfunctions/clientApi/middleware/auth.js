/**
 * 认证中间件
 * 从 cloud.getWXContext() 获取 OPENID,查询 client_wechat_users 获取 user_id
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')

/**
 * 认证中间件
 * 将 user_id 注入到 ctx.auth
 */
async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  // 查询用户
  const users = await pg.query(
    'SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    // 用户不存在,返回未注册状态
    ctx.auth = {
      isOpenid: true,
      userId: null,
      phone: null,
      boundStoreName: null
    }
  } else {
    ctx.auth = {
      isOpenid: true,
      userId: users[0].user_id,
      phone: users[0].phone,
      boundStoreName: users[0].bound_store_name
    }
  }

  await next()
}

/**
 * 要求必须绑定手机号
 */
function requirePhone() {
  return async (ctx, next) => {
    if (!ctx.auth.phone) {
      throw new Error('PHONE_REQUIRED: 请先绑定手机号')
    }
    await next()
  }
}

module.exports = {
  auth,
  requirePhone
}
