/**
 * 认证模块路由（员工端）
 * auth.login, auth.bindPhone
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { invalidateAuthCache } = require('../middleware/auth')

/**
 * 员工微信登录
 * 写入/更新 staff_wechat_users
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  const users = await pg.query(
    'SELECT user_id, phone, staff_wf_id, last_login_at FROM staff_wechat_users WHERE openid = $1',
    [OPENID]
  )

  const now = new Date()

  if (users.length === 0) {
    // 新员工用户，创建记录
    const userId = generateUserId()
    await pg.query(
      `INSERT INTO staff_wechat_users (user_id, openid, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $3, $3)`,
      [userId, OPENID, now]
    )

    ctx.result = {
      isNewUser: true,
      userId,
      phone: null,
      staffWfId: null,
      staffName: null,
      position: null,
      storeName: null,
      boundStoreName: null,
      boundStoreId: null
    }
  } else {
    // 老用户，更新最后登录时间
    const user = users[0]
    await pg.query(
      'UPDATE staff_wechat_users SET last_login_at = $1, updated_at = $1 WHERE user_id = $2',
      [now, user.user_id]
    )

    // 如果已绑定员工档案，从 WorkFine 查职位信息
    let position = null
    let staffName = null
    let storeName = null
    let marketName = null

    if (user.staff_wf_id) {
      const esc = (v) => String(v).replace(/'/g, "''")
      try {
        const staffRows = await mssql.query(`
          SELECT
            UDF_S_1155 AS name,
            UDF_S_1161 AS position,
            UDF_S_1163 AS store_name,
            UDF_S_1160 AS market_name
          FROM UDT_S_287
          WHERE UDF_S_1147 = '${esc(user.staff_wf_id)}'
            AND UDF_S_1624 NOT IN ('是', '离职')
        `)

        if (staffRows.length > 0) {
          staffName = staffRows[0].name ? staffRows[0].name.trim() : null
          position = staffRows[0].position ? staffRows[0].position.trim() : null
          storeName = staffRows[0].store_name ? staffRows[0].store_name.trim() : null
          marketName = staffRows[0].market_name ? staffRows[0].market_name.trim() : null
        }
      } catch (e) {
        console.error('[auth.login] WorkFine lookup failed:', e.message)
      }
    }

    ctx.result = {
      isNewUser: false,
      userId: user.user_id,
      phone: user.phone,
      staffWfId: user.staff_wf_id,
      staffName,
      position,
      storeName,
      marketName,
      boundStoreName: storeName,
      boundStoreId: storeName
    }
  }
}

/**
 * 绑定手机号
 * 支持 CloudID 方式（推荐）或直接传入手机号
 * 绑定后从 WorkFine 自动关联员工档案
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone } = ctx.event.payload || {}
  // CloudID 必须在 event 顶层才能被微信平台自动解密
  const phoneData = ctx.event.phoneData

  let phoneNumber = null

  // 方式1: CloudID 方式（推荐）
  if (phoneData) {
    if (phoneData.errCode) {
      throw new Error(`INVALID_PARAMS: 手机号解密失败 (${phoneData.errMsg || phoneData.errCode})`)
    }
    const resolved = phoneData.data
    if (!resolved) {
      throw new Error('INVALID_PARAMS: CloudID 未被解密，请检查是否放在 data 顶层')
    }
    phoneNumber = resolved.purePhoneNumber || resolved.phoneNumber
    if (!phoneNumber) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  }
  // 方式2: 直接传入手机号（测试用）
  else if (directPhone) {
    phoneNumber = directPhone
  } else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone, staff_wf_id FROM staff_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在，请先登录')
  }

  const userId = users[0].user_id

  // 检查手机号是否已被其他用户绑定
  const phoneUsers = await pg.query(
    'SELECT user_id FROM staff_wechat_users WHERE phone = $1 AND user_id != $2',
    [phoneNumber, userId]
  )
  if (phoneUsers.length > 0) {
    throw new Error('INVALID_PARAMS: 该手机号已被其他账号绑定')
  }

  // 从 WorkFine 查询员工档案（按手机号）
  const esc = (v) => String(v).replace(/'/g, "''")
  const staffRows = await mssql.query(`
    SELECT
      UDF_S_1147 AS staff_wf_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department,
      UDF_S_1163 AS store_name,
      UDF_S_1160 AS market_name
    FROM UDT_S_287
    WHERE UDF_S_1152 = '${esc(phoneNumber)}'
      AND UDF_S_1624 NOT IN ('是', '离职')
    ORDER BY UDF_S_1147 DESC
  `)

  let staffWfId = users[0].staff_wf_id
  let position = null
  let storeName = null
  let marketName = null

  if (staffRows.length > 0) {
    const s = staffRows[0]
    staffWfId = s.staff_wf_id
    position = s.position ? s.position.trim() : null
    storeName = s.store_name ? s.store_name.trim() : null
    marketName = s.market_name ? s.market_name.trim() : null
  }

  if (!staffWfId) {
    throw new Error('INVALID_PARAMS: 未找到对应员工档案，请确认手机号是否正确或联系管理员')
  }

  const now = new Date()

  // 更新手机号和员工档案关联
  await pg.query(
    'UPDATE staff_wechat_users SET phone = $1, staff_wf_id = $2, updated_at = $3 WHERE user_id = $4',
    [phoneNumber, staffWfId, now, userId]
  )

  // 清除认证缓存
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    userId,
    phone: phoneNumber,
    staffWfId,
    position,
    storeName,
    marketName
  }
}

function generateUserId() {
  return 'staff_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

module.exports = {
  login,
  bindPhone
}
