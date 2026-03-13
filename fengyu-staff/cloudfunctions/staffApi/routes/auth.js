/**
 * 认证模块路由（员工端）
 * auth.login, auth.bindPhone
 *
 * employee_id 是 staff_wechat_users 的唯一主键。
 * 行来源：(a) WorkFine 历史同步，或 (b) bindPhone 时自动建档。
 * login 仅按 openid 查询；bindPhone 按 phone 匹配已有行或新建行。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')

/**
 * 生成员工编号：FY-WX-{YYMMDD}{3位序号}
 * 使用 advisory lock 防并发
 */
async function generateEmployeeId(client) {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const prefix = `FY-WX-${yy}${mm}${dd}`

  // advisory lock key: 固定前缀 hash
  await client.query("SELECT pg_advisory_xact_lock(hashtext('gen_employee_id'))")

  const { rows } = await client.query(
    "SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1 ORDER BY employee_id DESC LIMIT 1",
    [prefix + '%']
  )

  let seq = 1
  if (rows.length > 0) {
    const last = rows[0].employee_id
    seq = parseInt(last.slice(prefix.length), 10) + 1
  }

  return prefix + String(seq).padStart(3, '0')
}

/**
 * 员工微信登录
 * 按 openid 查询 staff_wechat_users：
 *   - 找到 → 返回员工信息
 *   - 未找到 → 返回 isNewUser:true（需 bindPhone 建档或关联）
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
 * 绑定手机号（手机号授权登录）
 * 支持 CloudID 方式（推荐）或直接传入手机号
 *
 * 逻辑：
 *   1. 按 phone 找到已有行 → 写入 openid（关联历史同步/管理后台创建的档案）
 *   2. 找不到 → 自动建档（生成 FY-WX-{YYMMDD}{序号} employee_id）
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone } = ctx.event.payload || {}
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

  // 按手机号查找已有行（含历史同步和管理后台创建的）
  const empRows = await pg.query(`
    SELECT
      u.employee_id, u.openid, u.name, u.position_name, u.is_resigned,
      u.store_id,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE u.phone = $1
    ORDER BY u.is_resigned ASC, u.employee_id DESC
    LIMIT 1
  `, [phoneNumber])

  if (empRows.length > 0) {
    // 找到已有行 → 关联 openid
    const emp = empRows[0]

    if (emp.openid && emp.openid !== OPENID) {
      throw new Error('INVALID_PARAMS: 该手机号已被其他账号绑定，请联系管理员')
    }

    await pg.query(
      'UPDATE staff_wechat_users SET openid = $1, last_login_at = now(), updated_at = now() WHERE employee_id = $2',
      [OPENID, emp.employee_id]
    )

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
    return
  }

  // 未找到 → 自动建档
  const employeeId = await pg.transaction(async (client) => {
    const id = await generateEmployeeId(client)

    await client.query(
      `INSERT INTO staff_wechat_users (employee_id, openid, phone, last_login_at, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now(), now())`,
      [id, OPENID, phoneNumber]
    )

    return id
  })

  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    phone: phoneNumber,
    staffWfId: employeeId,
    staffName: null,
    position: null,
    boundStoreName: null,
    boundStoreId: null,
  }
}

module.exports = {
  login,
  bindPhone
}
