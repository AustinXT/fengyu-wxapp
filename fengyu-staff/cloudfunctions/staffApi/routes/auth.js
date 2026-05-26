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
const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
} = require('../utils/scope')

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
 * 查询员工权限角色（带 scope 类型）
 * @returns {Array<{role: string, scopeId: string, scopeType: string}>}
 */
async function queryRoleBindings(employeeId) {
  if (!employeeId) return []
  const rows = await pg.query(
    `SELECT pr.role, pr.scope_id, o.type AS scope_type, o.name AS scope_name
     FROM permission_roles pr
     LEFT JOIN org_nodes o ON o.id = pr.scope_id
     WHERE pr.employee_id = $1`,
    [employeeId]
  )
  return rows.map((r) => ({
    role: r.role,
    scopeId: r.scope_id,
    scopeType: r.scope_type,
    scopeName: r.scope_name,
  }))
}

/**
 * 根据 scopeStoreIds 批量取店名，给前端门店下拉用
 */
async function fetchScopedStores(storeIds) {
  if (!storeIds || storeIds.length === 0) return []
  const rows = await pg.query(
    `SELECT store_id, store_name
     FROM stores
     WHERE store_id = ANY($1::text[])
     ORDER BY store_name ASC`,
    [storeIds]
  )
  return rows.map((r) => ({ storeId: r.store_id, storeName: r.store_name }))
}

/**
 * 组装 auth 响应的权限层级字段
 */
async function buildLevelPayload(employeeId) {
  const roleBindings = await queryRoleBindings(employeeId)
  const roles = [...new Set(roleBindings.map((r) => r.role))]
  const staffLevel = deriveStaffLevel(roleBindings)
  const scopeStoreIds = await expandScopeStoreIds(roleBindings, pg)
  const availableLoginLevels = deriveAvailableLoginLevels(staffLevel, scopeStoreIds)
  const scopedStores = await fetchScopedStores(scopeStoreIds)
  return { roles, roleBindings, staffLevel, availableLoginLevels, scopedStores }
}

/**
 * 员工微信登录
 * 按 openid 查询 staff_wechat_users：
 *   - 找到 → 返回员工信息 + roles
 *   - 未找到 → 返回 isNewUser:true（需 bindPhone 建档或关联）
 */
async function login(ctx) {
  // 用 ctx.auth.openid（中间件已合并 _testOpenid），不要直接 cloud.getWXContext()
  // 否则测试模式 switchTestUser 切身份失效——_testOpenid 被忽略，永远返回真实员工
  const OPENID = ctx.auth.openid

  const users = await pg.query(`
    SELECT
      u.employee_id, u.phone, u.name, u.position_name, u.is_resigned,
      u.skills, u.avatar_url,
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
      roles: [],
      roleBindings: [],
      staffLevel: null,
      availableLoginLevels: [],
      scopedStores: [],
      skills: [],
      avatarUrl: null,
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
  const level = isActive
    ? await buildLevelPayload(user.employee_id)
    : { roles: [], roleBindings: [], staffLevel: null, availableLoginLevels: [], scopedStores: [] }

  ctx.result = {
    isNewUser: false,
    phone: user.phone,
    staffWfId: isActive ? user.employee_id : null,
    staffName: isActive ? user.name : null,
    position: isActive ? user.position_name : null,
    roles: level.roles,
    roleBindings: level.roleBindings,
    staffLevel: level.staffLevel,
    availableLoginLevels: level.availableLoginLevels,
    scopedStores: level.scopedStores,
    skills: isActive && Array.isArray(user.skills) ? user.skills : [],
    avatarUrl: user.avatar_url || null,
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
  const { OPENID: realOpenid } = cloud.getWXContext()
  const { phoneNumber: directPhone, _testOpenid: payloadTestOpenid } = ctx.event.payload || {}
  const phoneData = ctx.event.phoneData

  // 测试模式：_testOpenid 覆盖真实 openid（与 middleware/auth.js 同源逻辑）
  const testOpenid = process.env.ALLOW_TEST_OPENID === 'true'
    ? (payloadTestOpenid || ctx.event._testOpenid)
    : null
  const OPENID = testOpenid || realOpenid

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
  // 方式2: 直接传入手机号（测试用，仅 ALLOW_TEST_OPENID=true 时启用）
  else if (directPhone) {
    if (process.env.ALLOW_TEST_OPENID !== 'true') {
      throw new Error('INVALID_PARAMS: phoneNumber 直传仅在测试环境启用')
    }
    phoneNumber = directPhone
  } else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  // openid 预检：拦截换绑 / 残留行场景，避免 INSERT 命中 uq_staff_users_openid
  // 员工端 bindPhone 仅负责首次绑定；换手机号由管理后台操作
  const byOpenid = await pg.query(
    'SELECT employee_id, phone FROM staff_wechat_users WHERE openid = $1 LIMIT 1',
    [OPENID]
  )
  if (byOpenid.length > 0 && byOpenid[0].phone !== phoneNumber) {
    if (testOpenid) {
      // 测试模式：dev openid 允许重新映射到另一员工，先把旧绑定置空
      await pg.query(
        'UPDATE staff_wechat_users SET openid = NULL WHERE employee_id = $1',
        [byOpenid[0].employee_id]
      )
    } else {
      throw new Error('INVALID_PARAMS: 该微信账号已绑定其他手机号，如需变更请联系管理员')
    }
  }
  // byOpenid.length === 0 → 继续往下按 phone 查 / INSERT
  // byOpenid.length > 0 且 phone 相同 → 幂等，phone 查询会命中同一行走 UPDATE openid（no-op）

  // 按手机号查找已有行（含历史同步和管理后台创建的）
  const empRows = await pg.query(`
    SELECT
      u.employee_id, u.openid, u.name, u.position_name, u.is_resigned,
      u.skills, u.avatar_url,
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
      if (!testOpenid) {
        throw new Error('INVALID_PARAMS: 该手机号已被其他账号绑定，请联系管理员')
      }
      // 测试模式：允许覆盖目标员工的旧 openid 绑定（下面的 UPDATE 会写新 OPENID）
    }

    await pg.query(
      'UPDATE staff_wechat_users SET openid = $1, last_login_at = now(), updated_at = now() WHERE employee_id = $2',
      [OPENID, emp.employee_id]
    )

    invalidateAuthCache(OPENID)

    const level = await buildLevelPayload(emp.employee_id)

    ctx.result = {
      success: true,
      phone: phoneNumber,
      staffWfId: emp.employee_id,
      staffName: emp.name,
      position: emp.position_name,
      roles: level.roles,
      roleBindings: level.roleBindings,
      staffLevel: level.staffLevel,
      availableLoginLevels: level.availableLoginLevels,
      scopedStores: level.scopedStores,
      skills: Array.isArray(emp.skills) ? emp.skills : [],
      avatarUrl: emp.avatar_url || null,
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
    roles: [],
    roleBindings: [],
    staffLevel: null,
    availableLoginLevels: [],
    scopedStores: [],
    skills: [],
    avatarUrl: null,
    boundStoreName: null,
    boundStoreId: null,
  }
}

module.exports = {
  login,
  bindPhone
}
