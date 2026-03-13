/**
 * 认证模块路由（员工端）
 * auth.login, auth.bindPhone
 *
 * employee_id（WorkFine 同步）是 staff_wechat_users 的唯一主键。
 * 微信登录不建行；绑定手机号时按 phone 找到同步行，写入 openid。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')

/**
 * 员工微信登录
 * 按 openid 查询 staff_wechat_users：
 *   - 找到 → 返回员工信息
 *   - 未找到 → 返回 isNewUser:true（不建行，等 bindPhone 写入 openid）
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  const users = await pg.query(`
    SELECT
      u.employee_id, u.phone, u.name, u.position_name, u.is_resigned,
      u.store_id,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE u.openid = $1
  `, [OPENID])

  if (users.length === 0) {
    // openid 尚未绑定到任何同步行，需先 bindPhone
    ctx.result = {
      isNewUser: true,
      phone: null,
      staffWfId: null,
      staffName: null,
      position: null,
      boundStoreName: null,
      boundStoreId: null,
    }
    return
  }

  // 老用户，更新最后登录时间
  const user = users[0]
  await pg.query(
    'UPDATE staff_wechat_users SET last_login_at = $1, updated_at = $1 WHERE employee_id = $2',
    [new Date(), user.employee_id]
  )

  const isActive = user.employee_id && !user.is_resigned

  ctx.result = {
    isNewUser: false,
    phone: user.phone,
    staffWfId: isActive ? user.employee_id : null,
    staffName: isActive ? user.name : null,
    position: isActive ? user.position_name : null,
    boundStoreName: isActive ? user.store_name : null,
    boundStoreId: isActive ? user.store_id : null,
  }
}

/**
 * 绑定手机号
 * 支持 CloudID 方式（推荐）或直接传入手机号
 * 按手机号找到同步创建的在职行 → 写入 openid
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

  // 按手机号查找在职员工同步行
  const empRows = await pg.query(`
    SELECT
      u.employee_id, u.openid, u.name, u.position_name,
      u.store_id,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE u.phone = $1 AND u.is_resigned = false
    ORDER BY u.employee_id DESC
    LIMIT 1
  `, [phoneNumber])

  if (empRows.length === 0) {
    throw new Error('INVALID_PARAMS: 未找到对应员工档案，请确认手机号是否正确或联系管理员')
  }

  const emp = empRows[0]

  // 如果该行已被另一个 openid 绑定，说明手机号已被占用
  if (emp.openid && emp.openid !== OPENID) {
    throw new Error('INVALID_PARAMS: 该手机号已被其他账号绑定，请联系管理员')
  }

  // 写入 openid 到同步行
  await pg.query(
    'UPDATE staff_wechat_users SET openid = $1, last_login_at = now(), updated_at = now() WHERE employee_id = $2',
    [OPENID, emp.employee_id]
  )

  // 清除认证缓存
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    phone: phoneNumber,
    staffWfId: emp.employee_id,
    staffName: emp.name,
    position: emp.position_name,
    boundStoreName: emp.store_name,
    boundStoreId: emp.store_id,
  }
}

module.exports = {
  login,
  bindPhone
}
