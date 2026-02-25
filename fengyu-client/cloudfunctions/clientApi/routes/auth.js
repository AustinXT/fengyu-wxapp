/**
 * 认证模块路由
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const mssql = require('../db/mssql')
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
 * 支持两种方式：
 * 1. CloudID 方式（推荐）：前端传入 wx.cloud.CloudID(cloudID)，云函数自动解密
 * 2. 直接传入手机号（用于测试或特殊场景）
 * 同时补全历史订单的 client_user_id
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { cloudID, phoneNumber: directPhone } = ctx.event.payload

  let phoneNumber = null

  // 方式1: CloudID 方式（推荐）
  if (cloudID) {
    // CloudID 对象在云函数中被自动解密，直接访问 cloudID.data 获取手机号
    // 结构: { data: { phoneNumber: string, purePhoneNumber: string, countryCode: string }, errCode: number }
    if (cloudID.errCode) {
      throw new Error(`INVALID_PARAMS: 手机号解密失败 (${cloudID.errMsg || cloudID.errCode})`)
    }

    // 优先使用 purePhoneNumber（纯数字），其次 phoneNumber（带区号）
    phoneNumber = cloudID.data?.purePhoneNumber || cloudID.data?.phoneNumber

    if (!phoneNumber) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  }
  // 方式2: 直接传入手机号（用于测试或特殊场景）
  else if (directPhone) {
    phoneNumber = directPhone
  }
  // 缺少参数
  else {
    throw new Error('INVALID_PARAMS: 缺少 cloudID 或 phoneNumber 参数')
  }

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

/**
 * 更新用户绑定门店
 * 验证门店是否有效(从 UDT_M_219 查询)
 */
async function bindStore(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { storeName } = ctx.event.payload

  // 参数校验
  if (!storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
  }

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  // 验证门店是否存在(从 WorkFine UDT_M_219 查询)
  const storeCheck = await mssql.query(`
    SELECT UDF_M_438 AS store_name
    FROM UDT_M_219
    WHERE UDF_M_438 = '${storeName.replace(/'/g, "''")}'
      AND (UDF_M_11956 IS NULL OR UDF_M_11956 != '是')
  `)

  if (storeCheck.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已停业')
  }

  const now = new Date()

  // 更新绑定门店
  await pg.query(
    'UPDATE client_wechat_users SET bound_store_name = $1, updated_at = $2 WHERE user_id = $3',
    [storeName, now, users[0].user_id]
  )

  ctx.result = {
    success: true,
    userId: users[0].user_id,
    boundStoreName: storeName
  }
}

module.exports = {
  login,
  bindPhone,
  bindStore
}
