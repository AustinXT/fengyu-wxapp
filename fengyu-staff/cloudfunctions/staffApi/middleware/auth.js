

const cloud = require('wx-server-sdk')

const pg = require('../db/pg')
const { testBypassAllowed } = require('../utils/runtime-guard')
const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  canAccessManagementLevel,
  expandScopeStoreIds,
} = require('../utils/scope')


const AUTH_CACHE = new Map()
const CACHE_TTL = 5 * 60 * 1000 


function readLoginParams(ctx) {
  const payload = ctx.event.payload || {}
  return {
    loginLevel: payload._loginLevel || ctx.event._loginLevel || null,
    currentStoreId: payload._currentStoreId || ctx.event._currentStoreId || null,
  }
}


function resolveRuntimeAuth(base, loginLevelInput, currentStoreIdInput) {
  const { staffLevel, scopeStoreIds, fallbackStoreId } = base

  const available = deriveAvailableLoginLevels(staffLevel, scopeStoreIds)

  
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

  
  if (loginLevel === 'management') {
    return { loginLevel, currentStoreId: null, effectiveStoreId: null }
  }

  
  let storeId = currentStoreIdInput
  if (!storeId) {
    
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


async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  
  let effectiveOpenid = OPENID
  if (testBypassAllowed('ALLOW_TEST_OPENID')) {
    const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
    if (testOpenid) effectiveOpenid = testOpenid
  }

  if (!effectiveOpenid) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  
  let base = AUTH_CACHE.get(effectiveOpenid)
  if (base && Date.now() - base.ts < CACHE_TTL) {
    base = base.data
  } else {
    base = await loadAuthBase(effectiveOpenid)
    AUTH_CACHE.set(effectiveOpenid, { data: base, ts: Date.now() })

    
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


async function loadAuthBase(effectiveOpenid) {
  
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
  let managerStoreIds = []

  if (users.length === 0) {
    
    authData = {
      openid: effectiveOpenid,
      phone: null,
      name: null,
      staffWfId: null,
      storeId: null,
      roles: [],
      roleBindings: [],
      staffLevel: null,
      scopeStoreIds: [],
      managerStoreIds: [],
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
      
      const rows = await pg.query(`
        SELECT pr.role, pr.scope_id, o.type AS scope_type, o.name AS scope_name
        FROM permission_roles pr
        LEFT JOIN org_nodes o ON o.id = pr.scope_id
        WHERE pr.employee_id = $1
      `, [user.employee_id])
      roleBindings = rows.map(r => ({
        role: r.role,
        scopeId: r.scope_id,
        scopeType: r.scope_type,
        scopeName: r.scope_name,
      }))
      staffLevel = deriveStaffLevel(roleBindings)
      scopeStoreIds = await expandScopeStoreIds(roleBindings, pg)
      
      const managerBindings = roleBindings.filter((r) => r.role === 'manager')
      managerStoreIds = managerBindings.length > 0
        ? await expandScopeStoreIds(managerBindings, pg)
        : []
    }

    const roles = [...new Set(roleBindings.map(r => r.role))]

    authData = {
      openid: effectiveOpenid,
      phone: user.phone,
      name: isActive ? user.name : null,
      staffWfId: isActive ? user.employee_id : null,
      storeId: isActive ? user.store_id : null,
      roles,
      roleBindings,
      staffLevel,
      scopeStoreIds,
      managerStoreIds,
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


function requireManager() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    const bindings = ctx.auth.roleBindings || []
    
    
    
    const VALID_MANAGER_SCOPES = ['总部', '市场', '门店']
    const hasManagerRole = bindings.length > 0
      ? bindings.some((r) => r.role === 'manager' && VALID_MANAGER_SCOPES.includes(r.scopeType))
      : (Array.isArray(ctx.auth.roles) && ctx.auth.roles.includes('manager'))
    if (!hasManagerRole) {
      throw new Error('PERMISSION_DENIED: 仅店长可执行此操作')
    }
    
    
    const managerStoreIds = ctx.auth.managerStoreIds || []
    const eff = ctx.auth.effectiveStoreId
    if (eff && managerStoreIds.length > 0 && !managerStoreIds.includes(eff)) {
      throw new Error('PERMISSION_DENIED: 当前门店不在您的店长管辖范围内')
    }
    await next()
  }
}


function requireManagementLevel() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (!canAccessManagementLevel(ctx.auth.staffLevel)) {
      throw new Error('PERMISSION_DENIED: 仅管理层可执行此操作')
    }
    if (ctx.auth.loginLevel !== 'management') {
      throw new Error('PERMISSION_DENIED: 请以管理层身份登录')
    }
    await next()
  }
}


function invalidateAuthCache(openid) {
  AUTH_CACHE.delete(openid)
}

module.exports = {
  auth,
  requireStaffBound,
  requireManager,
  requireManagementLevel,
  invalidateAuthCache,
  
  _resolveRuntimeAuth: resolveRuntimeAuth,
}
