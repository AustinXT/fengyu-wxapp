/**
 * 员工认证中间件
 * 从 cloud.getWXContext() 获取 OPENID，查询 staff_wechat_users 获取员工信息
 * 权限角色从 permission_roles JOIN org_nodes 读取（拿 scopeType）
 *
 * ctx.auth 结构见 auth() 函数注释。
 */

const cloud = require('wx-server-sdk')

const pg = require('../db/pg')
const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
  MANAGEMENT_LEVELS,
  STORE_LEVELS,
} = require('../utils/scope')

// 员工基础信息缓存（不含 loginLevel/currentStoreId 等动态字段）：OPENID → { data, ts }
const AUTH_CACHE = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/**
 * 从 payload / event 读取登录层级相关参数
 */
function readLoginParams(ctx) {
  const payload = ctx.event.payload || {}
  return {
    loginLevel: payload._loginLevel || ctx.event._loginLevel || null,
    currentStoreId: payload._currentStoreId || ctx.event._currentStoreId || null,
  }
}

/**
 * 根据 staffLevel + scopeStoreIds + fallback storeId + 请求参数，派生 loginLevel / effectiveStoreId
 */
function resolveRuntimeAuth(base, loginLevelInput, currentStoreIdInput) {
  const { staffLevel, scopeStoreIds, fallbackStoreId } = base

  const available = deriveAvailableLoginLevels(staffLevel, scopeStoreIds)

  // 1. loginLevel
  let loginLevel = loginLevelInput
  if (loginLevel && !available.includes(loginLevel)) {
    throw new Error('PERMISSION_DENIED: 无权以该身份登录')
  }
  if (!loginLevel) {
    loginLevel = available[0] || null
  }

  if (!loginLevel) {
    return { loginLevel: null, currentStoreId: null, effectiveStoreId: null }
  }

  // 2. 管理层模式：effectiveStoreId = null（查询基于 scopeStoreIds）
  if (loginLevel === 'management') {
    return { loginLevel, currentStoreId: null, effectiveStoreId: null }
  }

  // 3. 门店模式：effectiveStoreId 需要在 scopeStoreIds 内
  let storeId = currentStoreIdInput
  if (!storeId) {
    // fallback：优先 staff 自身 store_id；否则取 scope 第一个
    if (fallbackStoreId && scopeStoreIds.includes(fallbackStoreId)) {
      storeId = fallbackStoreId
    } else if (scopeStoreIds.length > 0) {
      storeId = scopeStoreIds[0]
    }
  }

  if (!storeId) {
    return { loginLevel, currentStoreId: null, effectiveStoreId: null }
  }

  if (!scopeStoreIds.includes(storeId)) {
    throw new Error('PERMISSION_DENIED: 无权访问该门店')
  }

  return { loginLevel, currentStoreId: storeId, effectiveStoreId: storeId }
}

/**
 * 认证中间件
 *
 * ctx.auth = {
 *   openid, phone, staffWfId,
 *   storeId,                 // staff_wechat_users.store_id — 员工档案默认门店（兼容字段）
 *   roles,                   // string[]（兼容字段，去重后的 role 名）
 *   roleBindings,            // [{role, scopeId, scopeType}]
 *   staffLevel,              // headquarters | market | store_manager | store_staff | null
 *   scopeStoreIds,           // string[] — 有权可见的全部 store_id
 *   loginLevel,              // store | management | null
 *   currentStoreId,          // 门店模式下的当前门店
 *   effectiveStoreId,        // 业务 SQL 应该使用的门店过滤值；管理层模式 = null
 *   position, storeName, marketName, department, skills
 * }
 */
async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  // 测试模式: 仅在显式开启时允许通过 _testOpenid 参数覆盖（生产环境不设此变量）
  let effectiveOpenid = OPENID
  if (process.env.ALLOW_TEST_OPENID === 'true') {
    const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
    if (testOpenid) effectiveOpenid = testOpenid
  }

  if (!effectiveOpenid) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  // 基础信息缓存命中 → 直接用，再跑运行时派生
  let base = AUTH_CACHE.get(effectiveOpenid)
  if (base && Date.now() - base.ts < CACHE_TTL) {
    base = base.data
  } else {
    base = await loadAuthBase(effectiveOpenid)
    AUTH_CACHE.set(effectiveOpenid, { data: base, ts: Date.now() })

    // 防止缓存无限增长
    if (AUTH_CACHE.size > 200) {
      const keys = [...AUTH_CACHE.keys()]
      for (let i = 0; i < 100; i++) {
        AUTH_CACHE.delete(keys[i])
      }
    }
  }

  const { loginLevel: liInput, currentStoreId: csInput } = readLoginParams(ctx)
  const runtime = resolveRuntimeAuth(base, liInput, csInput)

  ctx.auth = {
    ...base.authData,
    loginLevel: runtime.loginLevel,
    currentStoreId: runtime.currentStoreId,
    effectiveStoreId: runtime.effectiveStoreId,
  }

  await next()
}

/**
 * 从 DB 读取员工基础信息（静态部分，不含 loginLevel）
 */
async function loadAuthBase(effectiveOpenid) {
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
  let roleBindings = []
  let staffLevel = null
  let scopeStoreIds = []

  if (users.length === 0) {
    // 未注册员工
    authData = {
      openid: effectiveOpenid,
      phone: null,
      staffWfId: null,
      storeId: null,
      roles: [],
      roleBindings: [],
      staffLevel: null,
      scopeStoreIds: [],
      position: null,
      storeName: null,
      marketName: null,
      department: null,
      skills: [],
    }
  } else {
    const user = users[0]
    const isActive = user.employee_id && !user.is_resigned

    if (isActive) {
      // 查角色 + scopeType
      const rows = await pg.query(`
        SELECT pr.role, pr.scope_id, o.type AS scope_type
        FROM permission_roles pr
        LEFT JOIN org_nodes o ON o.id = pr.scope_id
        WHERE pr.employee_id = $1
      `, [user.employee_id])
      roleBindings = rows.map(r => ({
        role: r.role,
        scopeId: r.scope_id,
        scopeType: r.scope_type,
      }))
      staffLevel = deriveStaffLevel(roleBindings)
      scopeStoreIds = await expandScopeStoreIds(roleBindings, pg)
    }

    const roles = [...new Set(roleBindings.map(r => r.role))]

    authData = {
      openid: effectiveOpenid,
      phone: user.phone,
      staffWfId: isActive ? user.employee_id : null,
      storeId: isActive ? user.store_id : null,
      roles,
      roleBindings,
      staffLevel,
      scopeStoreIds,
      position: isActive ? user.position_name : null,
      storeName: isActive ? user.store_name : null,
      marketName: isActive ? user.market_name : null,
      department: isActive ? user.department : null,
      skills: isActive && Array.isArray(user.skills) ? user.skills : [],
    }
  }

  return {
    authData,
    staffLevel,
    scopeStoreIds,
    fallbackStoreId: authData.storeId,
  }
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
 * 要求拥有 (manager, 门店) 角色绑定
 * 语义不变：只要在某个门店是店长，即可通过（不强制当前 loginLevel）
 */
function requireManager() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    const bindings = ctx.auth.roleBindings || []
    const hasStoreManager = bindings.some(
      (r) => r.role === 'manager' && r.scopeType === '门店'
    )
    // 兼容：旧缓存或旧测试数据可能整份 bindings 都没 scopeType，此时退化到 roles 判定
    const hasAnyScopeType = bindings.some((r) => r.scopeType)
    const legacyFallback =
      !hasAnyScopeType &&
      Array.isArray(ctx.auth.roles) &&
      ctx.auth.roles.includes('manager')
    if (!hasStoreManager && !legacyFallback) {
      throw new Error('PERMISSION_DENIED: 仅店长可执行此操作')
    }
    await next()
  }
}

/**
 * 要求以管理层身份登录（总部 / 市场 层级，且当前 loginLevel = management）
 */
function requireManagementLevel() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (!MANAGEMENT_LEVELS.has(ctx.auth.staffLevel)) {
      throw new Error('PERMISSION_DENIED: 仅管理层可执行此操作')
    }
    if (ctx.auth.loginLevel !== 'management') {
      throw new Error('PERMISSION_DENIED: 请以管理层身份登录')
    }
    await next()
  }
}

/**
 * 清除指定 OPENID 的认证缓存
 */
function invalidateAuthCache(openid) {
  AUTH_CACHE.delete(openid)
}

module.exports = {
  auth,
  requireStaffBound,
  requireManager,
  requireManagementLevel,
  invalidateAuthCache,
  // 导出 helper 便于测试
  _resolveRuntimeAuth: resolveRuntimeAuth,
}
