/**
 * 认证模块路由（员工端）
 * auth.login, auth.bindPhone
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')

/**
 * 员工微信登录
 * 写入/更新 staff_wechat_users
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  const users = await pg.query(`
    SELECT
      u.user_id, u.phone, u.employee_id, u.name, u.position_name, u.is_resigned,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE u.openid = $1
  `, [OPENID])

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
      marketName: null,
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

    const isActive = user.employee_id && !user.is_resigned

    ctx.result = {
      isNewUser: false,
      userId: user.user_id,
      phone: user.phone,
      staffWfId: isActive ? user.employee_id : null,
      staffName: isActive ? user.name : null,
      position: isActive ? user.position_name : null,
      storeName: isActive ? user.store_name : null,
      marketName: isActive ? user.market_name : null,
      boundStoreName: isActive ? user.store_name : null,
      boundStoreId: isActive ? user.store_name : null
    }
  }
}

/**
 * 绑定手机号
 * 支持 CloudID 方式（推荐）或直接传入手机号
 * 绑定后从 staff_wechat_users 自动关联员工档案
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
    'SELECT user_id, phone, employee_id FROM staff_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在，请先登录')
  }

  const currentUser = users[0]

  // 从 PG 按手机号查找在职员工档案（可能是同步创建的无 openid 行）
  const empRows = await pg.query(`
    SELECT
      u.user_id, u.employee_id, u.name, u.position_name,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE u.phone = $1 AND u.is_resigned = false AND u.employee_id IS NOT NULL
    ORDER BY u.employee_id DESC
    LIMIT 1
  `, [phoneNumber])

  let staffWfId = currentUser.employee_id
  let position = null
  let storeName = null
  let marketName = null

  if (empRows.length > 0) {
    const emp = empRows[0]
    staffWfId = emp.employee_id
    position = emp.position_name
    storeName = emp.store_name
    marketName = emp.market_name

    if (emp.user_id !== currentUser.user_id) {
      // 找到的是另一行（同步创建的无 openid 行）：合并 — 把 openid/session_key 写到已有行，删除当前行
      await pg.query(
        `UPDATE staff_wechat_users SET openid = $1, session_key = (
           SELECT session_key FROM staff_wechat_users WHERE user_id = $2
         ), last_login_at = now(), updated_at = now()
         WHERE user_id = $3`,
        [OPENID, currentUser.user_id, emp.user_id]
      )
      await pg.query('DELETE FROM staff_wechat_users WHERE user_id = $1', [currentUser.user_id])

      // 清除认证缓存
      invalidateAuthCache(OPENID)

      ctx.result = {
        success: true,
        userId: emp.user_id,
        phone: phoneNumber,
        staffWfId,
        position,
        storeName,
        marketName
      }
      return
    }
  }

  if (!staffWfId) {
    throw new Error('INVALID_PARAMS: 未找到对应员工档案，请确认手机号是否正确或联系管理员')
  }

  const now = new Date()

  // 更新手机号和员工档案关联
  await pg.query(
    'UPDATE staff_wechat_users SET phone = $1, employee_id = $2, updated_at = $3 WHERE user_id = $4',
    [phoneNumber, staffWfId, now, currentUser.user_id]
  )

  // 清除认证缓存
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    userId: currentUser.user_id,
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
