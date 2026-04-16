/**
 * 员工认证中间件
 * 从 cloud.getWXContext() 获取 OPENID，查询 staff_wechat_users 获取员工信息
 * 权限角色从 permission_roles 表读取
 */

const cloud = require('wx-server-sdk')

const pg = require('../db/pg')

// 员工信息缓存：OPENID → { data, ts }
const AUTH_CACHE = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/**
 * 认证中间件
 * 将员工信息注入到 ctx.auth
 * ctx.auth = { openid, phone, staffWfId, storeId, roles, position, storeName, marketName, department, skills }
 */
async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  // 测试模式：支持通过 _testOpenid 参数进行测试
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  const effectiveOpenid = testOpenid || OPENID

  if (!effectiveOpenid) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  // 检查缓存
  const cached = AUTH_CACHE.get(effectiveOpenid)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    ctx.auth = cached.data
    // PR-1 兼容兜底：老缓存数据（部署瞬间 5 分钟窗口内）可能没有 skills 字段
    if (ctx.auth.skills === undefined) ctx.auth.skills = []
    return await next()
  }

  // 查询员工用户（JOIN 获取门店名、市场名、部门名）
  const users = await pg.query(`
    SELECT
      u.employee_id,
      u.phone,
      u.name,
      u.position_name,
      u.store_id,
      u.is_resigned,
      u.skills,
      s.store_name,
      m.name AS market_name,
      d.name AS department
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.openid = $1
  `, [effectiveOpenid])

  let authData

  if (users.length === 0) {
    // 未注册的员工（openid 尚未绑定到任何同步行）
    authData = {
      openid: effectiveOpenid,
      phone: null,
      staffWfId: null,
      storeId: null,
      roles: [],
      position: null,
      storeName: null,
      marketName: null,
      department: null,
      skills: []
    }
  } else {
    const user = users[0]
    // 离职员工视为未关联
    const isActive = user.employee_id && !user.is_resigned

    // 查询权限角色
    let roles = []
    if (isActive) {
      const roleRows = await pg.query(
        'SELECT role FROM permission_roles WHERE employee_id = $1',
        [user.employee_id]
      )
      roles = roleRows.map(r => r.role)
    }

    authData = {
      openid: effectiveOpenid,
      phone: user.phone,
      staffWfId: isActive ? user.employee_id : null,
      storeId: isActive ? user.store_id : null,
      roles,
      position: isActive ? user.position_name : null,
      storeName: isActive ? user.store_name : null,
      marketName: isActive ? user.market_name : null,
      department: isActive ? user.department : null,
      skills: isActive && Array.isArray(user.skills) ? user.skills : []
    }
  }

  // 写入缓存
  AUTH_CACHE.set(effectiveOpenid, { data: authData, ts: Date.now() })

  // 防止缓存无限增长（超过 200 条清理最早的一半）
  if (AUTH_CACHE.size > 200) {
    const keys = [...AUTH_CACHE.keys()]
    for (let i = 0; i < 100; i++) {
      AUTH_CACHE.delete(keys[i])
    }
  }

  ctx.auth = authData
  await next()
}

/**
 * 要求必须绑定手机号且已关联员工档案
 */
function requireStaffBound() {
  return async (ctx, next) => {
    if (!ctx.auth.phone) {
      throw new Error('PHONE_REQUIRED: 请先绑定手机号')
    }
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联，请联系管理员')
    }
    await next()
  }
}

/**
 * 要求角色为店长（manager）
 */
function requireManager() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (!ctx.auth.roles.includes('manager')) {
      throw new Error('PERMISSION_DENIED: 仅店长可执行此操作')
    }
    await next()
  }
}

/**
 * 清除指定 OPENID 的认证缓存
 * 在绑定手机号等修改用户信息后调用
 */
function invalidateAuthCache(openid) {
  AUTH_CACHE.delete(openid)
}

module.exports = {
  auth,
  requireStaffBound,
  requireManager,
  invalidateAuthCache
}
