/**
 * 员工认证中间件
 * 从 cloud.getWXContext() 获取 OPENID，查询 staff_wechat_users 获取员工信息
 * 并从 WorkFine 获取角色（店长/美容师）
 */

const cloud = require('wx-server-sdk')

const pg = require('../db/pg')
const mssql = require('../db/mssql')

// 员工信息缓存：OPENID → { data, ts }
const AUTH_CACHE = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/**
 * 认证中间件
 * 将员工信息注入到 ctx.auth
 * ctx.auth = { userId, openid, phone, staffWfId, position, storeName, marketName, department }
 * position: WorkFine 原始职位值（如 '门店经理'、'美容师'）
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
    return await next()
  }

  // 查询员工用户
  const users = await pg.query(
    'SELECT user_id, phone, employee_id, last_login_at FROM staff_wechat_users WHERE openid = $1',
    [effectiveOpenid]
  )

  let authData

  if (users.length === 0) {
    // 未注册的员工
    authData = {
      userId: null,
      openid: effectiveOpenid,
      phone: null,
      staffWfId: null,
      position: null,
      storeName: null,
      marketName: null,
      department: null
    }
  } else {
    const user = users[0]
    let position = null
    let storeName = null
    let marketName = null
    let department = null

    // 从 WorkFine 查询角色和门店信息
    if (user.employee_id) {
      try {
        const esc = (v) => String(v).replace(/'/g, "''")
        const staffRows = await mssql.query(`
          SELECT
            UDF_S_1147 AS staff_id,
            UDF_S_1161 AS position,
            UDF_S_1513 AS dept,
            UDF_S_1163 AS store_name,
            UDF_S_1160 AS market_name
          FROM UDT_S_287
          WHERE UDF_S_1147 = '${esc(user.employee_id)}'
            AND UDF_S_1624 NOT IN ('是', '离职')
        `)

        if (staffRows.length > 0) {
          const s = staffRows[0]
          position = s.position ? s.position.trim() : null
          storeName = s.store_name ? s.store_name.trim() : null
          marketName = s.market_name ? s.market_name.trim() : null
          department = s.dept ? s.dept.trim() : null
        }
      } catch (e) {
        console.error('[auth] WorkFine lookup failed:', e.message)
      }
    }

    authData = {
      userId: user.user_id,
      openid: effectiveOpenid,
      phone: user.phone,
      staffWfId: user.employee_id,
      position,
      storeName,
      marketName,
      department
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
 * 要求角色为店长（门店经理）
 */
function requireManager() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (ctx.auth.position !== '门店经理') {
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
