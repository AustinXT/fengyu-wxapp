/**
 * 员工认证中间件
 * 从 cloud.getWXContext() 获取 OPENID，查询 staff_wechat_users 获取员工信息
 * 权限角色从 permission_roles JOIN org_nodes 读取（拿 scopeType）
 *
 * ctx.auth 结构见 auth() 函数注释。
 */

const cloud = require('wx-server-sdk')

const pg = require('../db/pg')
const { testBypassAllowed } = require('../utils/runtime-guard')
const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
  expandScopeOrgNodeIds,
} = require('../utils/scope')
const { hasDataCenterDashboard } = require('../utils/permission-matrix')

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
 * 根据 staffLevel、scopeStoreIds、数据中心权限和请求参数，派生 loginLevel / effectiveStoreId。
 */
function resolveRuntimeAuth(base, loginLevelInput, currentStoreIdInput, hasDashboardPermission = false) {
  const { staffLevel, scopeStoreIds, fallbackStoreId } = base

  const available = deriveAvailableLoginLevels(
    staffLevel,
    scopeStoreIds,
    hasDashboardPermission,
  )

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
 *   scopeStoreIds,           // string[] — 有权可见的全部 store_id（全角色并集）
 *   scopeOrgNodeIds,         // string[] — 角色根节点自身及全部后代组织节点
 *   managerStoreIds,         // string[] — 仅 manager 角色绑定展开的门店；店长写操作授权用
 *   hasDataCenterDashboard,  // boolean — 当前权限矩阵是否授予 data_center:dashboard
 *   loginLevel,              // store | management | null
 *   currentStoreId,          // 门店模式下的当前门店
 *   effectiveStoreId,        // 业务 SQL 应该使用的门店过滤值；管理层模式 = null
 *   position, storeName, marketName, department, skills
 * }
 */
async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  // 测试模式: 仅在 env 开启 且 非生产运行时 允许 _testOpenid 覆盖（prod 由 runtime-guard 硬闸禁用）
  let effectiveOpenid = OPENID
  if (testBypassAllowed('ALLOW_TEST_OPENID')) {
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

  // Permission matrix is intentionally resolved outside the 5-minute auth base
  // cache, so matrix edits propagate with its own 30-second cache window.
  const hasDashboardPermission = base.authData.staffWfId
    ? await hasDataCenterDashboard(base.authData.roleBindings)
    : false

  const { loginLevel: liInput, currentStoreId: csInput } = readLoginParams(ctx)
  const runtime = resolveRuntimeAuth(
    base,
    liInput,
    csInput,
    hasDashboardPermission,
  )

  ctx.auth = {
    ...base.authData,
    hasDataCenterDashboard: hasDashboardPermission,
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
  let managerStoreIds = []
  let inventoryStoreIds = []
  let scopeOrgNodeIds = []

  if (users.length === 0) {
    // 未注册员工
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
      scopeOrgNodeIds: [],
      managerStoreIds: [],
      inventoryStoreIds: [],
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
      // 查角色定义 + scopeType。能力标记来自数据库，角色键仅作兼容标识。
      const rows = await pg.query(`
        SELECT pr.role, pr.scope_id, o.type AS scope_type, o.name AS scope_name,
               rd.name AS role_name, rd.is_store_manager, rd.is_super_admin, rd.actions
        FROM permission_roles pr
        JOIN permission_role_definitions rd ON rd.role_key = pr.role
        LEFT JOIN org_nodes o ON o.id = pr.scope_id
        WHERE pr.employee_id = $1
      `, [user.employee_id])
      roleBindings = rows.map(r => ({
        role: r.role,
        roleName: r.role_name || r.role,
        isStoreManager: r.is_store_manager ?? r.role === 'manager',
        isSuperAdmin: Boolean(r.is_super_admin),
        actions: Array.isArray(r.actions) ? r.actions : [],
        scopeId: r.scope_id,
        scopeType: r.scope_type,
        scopeName: r.scope_name,
      }))
      staffLevel = deriveStaffLevel(roleBindings)
      const [allScopeStores, allScopeNodes] = await Promise.all([
        expandScopeStoreIds(roleBindings, pg),
        expandScopeOrgNodeIds(roleBindings, pg),
      ])
      scopeStoreIds = allScopeStores
      scopeOrgNodeIds = allScopeNodes
      const inventoryBindings = roleBindings.filter((binding) => (
        binding.isSuperAdmin
        || binding.actions.some((action) => [
          'inventory:store_operate', 'inventory:market_operate', 'inventory:market_approve',
        ].includes(action))
      ))
      inventoryStoreIds = inventoryBindings.length === 0
        ? []
        : inventoryBindings.length === roleBindings.length
          ? allScopeStores
          : await expandScopeStoreIds(inventoryBindings, pg)
      // 仅展开具有店长能力的角色绑定 → 店长写操作可达的门店集。
      const managerBindings = roleBindings.filter((r) => r.isStoreManager)
      // 只有 manager 角色时，全角色范围就是 manager 范围；避免重复查询且保持口径一致。
      managerStoreIds = managerBindings.length === 0
        ? []
        : managerBindings.length === roleBindings.length
          ? allScopeStores
          : await expandScopeStoreIds(managerBindings, pg)
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
      scopeOrgNodeIds,
      managerStoreIds,
      inventoryStoreIds,
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
 * 要求拥有 manager 角色（总部 / 市场 / 门店 任一层级均可）。
 * 门店模式下（已选定 effectiveStoreId）还要求该门店落在 manager 角色覆盖的门店集
 * （managerStoreIds，仅展开 manager 绑定）内，从而把市场/总部 manager 精确限定到本人管辖门店，
 * 并拦掉「manager@门店A + finance@门店B 在 B 越权做店长操作」的情形。
 */
const VALID_MANAGER_SCOPES = ['总部', '市场', '门店']

/**
 * 是否具有有效的 manager 角色绑定。
 *
 * 角色字符串只作为旧测试/缓存的兼容回退；正常请求必须由 roleBindings 确认作用域，
 * 防止 manager 被错误绑定到部门节点后获得门店管理能力。
 */
function hasValidManagerRole(auth) {
  const bindings = auth?.roleBindings || []
  if (bindings.length > 0) {
    return bindings.some((role) => (
      (role.isStoreManager ?? role.role === 'manager') && VALID_MANAGER_SCOPES.includes(role.scopeType)
    ))
  }
  return Array.isArray(auth?.roles) && auth.roles.includes('manager')
}

/**
 * 当前请求是否是“当前门店的有效店长”。
 *
 * manager 角色是作用域角色，不能仅靠 roles.includes('manager') 判断。所有门店写能力
 * 均要求门店模式、有效 manager 绑定、有效门店 id 以及 managerStoreIds 命中。这里故意
 * 不对空 managerStoreIds 降级，避免旧缓存或异常数据把权限扩大为全门店。
 */
function isCurrentStoreManager(auth) {
  if (!auth) return false
  // 路由单测常直接构造最小 auth（无运行时字段）。真实 auth() 一定填充这些字段，
  // 因而该兼容分支不会放宽任何外部请求，只保留既有 unit fixture 的语义。
  const hasRuntimeFields = Object.prototype.hasOwnProperty.call(auth, 'loginLevel')
    || Object.prototype.hasOwnProperty.call(auth, 'effectiveStoreId')
    || Object.prototype.hasOwnProperty.call(auth, 'managerStoreIds')
  if (!hasRuntimeFields) return hasValidManagerRole(auth)
  if (auth.loginLevel !== 'store' || !auth.effectiveStoreId) return false
  if (!hasValidManagerRole(auth)) return false
  return Array.isArray(auth.managerStoreIds)
    && auth.managerStoreIds.includes(auth.effectiveStoreId)
}

function requireManager() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (!hasValidManagerRole(ctx.auth)) {
      throw new Error('PERMISSION_DENIED: 仅店长可执行此操作')
    }
    // 真实请求总由 auth() 注入 loginLevel。保留没有运行时字段的旧缓存/单测兼容，
    // 但只要明确处于管理层模式就一律禁止门店写操作。
    if (ctx.auth.loginLevel === 'management') {
      throw new Error('PERMISSION_DENIED: 管理层模式仅支持只读操作')
    }
    if (!isCurrentStoreManager(ctx.auth)) {
      throw new Error('PERMISSION_DENIED: 当前门店不在您的店长管辖范围内')
    }
    await next()
  }
}

/**
 * 要求拥有数据中心权限且以管理层身份登录。
 * 数据范围由各 mgmt 路由的 validateManagementScope 收口到账号全部 scope。
 */
function requireManagementLevel() {
  return async (ctx, next) => {
    if (!ctx.auth.staffWfId) {
      throw new Error('UNAUTHORIZED: 员工档案未关联')
    }
    if (!ctx.auth.hasDataCenterDashboard) {
      throw new Error('PERMISSION_DENIED: 缺少数据中心权限')
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
  hasValidManagerRole,
  isCurrentStoreManager,
  invalidateAuthCache,
  // 导出 helper 便于测试
  _resolveRuntimeAuth: resolveRuntimeAuth,
}
