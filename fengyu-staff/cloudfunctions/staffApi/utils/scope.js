/**
 * 员工权限 scope 工具
 *
 * - 将 permission_roles (role + scope_id + org_nodes.type) 归并为单一 staffLevel
 * - 展开 scope 到可见门店列表（scopeStoreIds）
 * - 派生 loginLevel 可选项 / effectiveStoreId
 * - 构造 SQL WHERE 片段给门店过滤使用
 *
 * org_nodes.type 枚举（中文）：总部 / 市场 / 门店 / 部门
 */

const LEVEL_HEADQUARTERS = 'headquarters'
const LEVEL_MARKET = 'market'
const LEVEL_STORE_MANAGER = 'store_manager'
const LEVEL_STORE_STAFF = 'store_staff'

const MANAGEMENT_LEVELS = new Set([LEVEL_HEADQUARTERS, LEVEL_MARKET])
const STORE_LEVELS = new Set([LEVEL_STORE_MANAGER, LEVEL_STORE_STAFF])

/**
 * 归并 roleBindings 到单一 staffLevel
 * @param {Array<{role: string, scopeType: string}>} roleBindings
 * @returns {string|null}
 */
function deriveStaffLevel(roleBindings) {
  if (!Array.isArray(roleBindings) || roleBindings.length === 0) return null

  let hasHq = false
  let hasMarket = false
  let hasStoreManager = false
  let hasStoreOther = false

  for (const rb of roleBindings) {
    if (!rb || !rb.scopeType) continue
    if (rb.scopeType === '总部') {
      hasHq = true
    } else if (rb.scopeType === '市场') {
      hasMarket = true
    } else if (rb.scopeType === '门店') {
      if (rb.role === 'manager') hasStoreManager = true
      else hasStoreOther = true
    }
    // 部门级忽略
  }

  if (hasHq) return LEVEL_HEADQUARTERS
  if (hasMarket) return LEVEL_MARKET
  if (hasStoreManager) return LEVEL_STORE_MANAGER
  if (hasStoreOther) return LEVEL_STORE_STAFF
  return null
}

/**
 * 基于 staffLevel + scopeStoreIds 计算登录模式候选
 * @param {string|null} staffLevel
 * @param {string[]} scopeStoreIds
 * @returns {Array<'store'|'management'>}
 */
function deriveAvailableLoginLevels(staffLevel, scopeStoreIds) {
  if (!staffLevel) return []
  if (STORE_LEVELS.has(staffLevel)) return ['store']
  if (MANAGEMENT_LEVELS.has(staffLevel)) {
    return scopeStoreIds && scopeStoreIds.length > 0
      ? ['store', 'management']
      : ['management']
  }
  return []
}

/**
 * 展开所有 scope 到可见门店列表（去重）
 * 规则：
 *  - 总部 scope → 全部 stores
 *  - 市场 scope → stores JOIN org_nodes, org_node 父为 marketId 且 type='门店'
 *  - 门店 scope → stores WHERE org_node_id = scopeId
 *  - 部门 scope → 忽略
 *
 * @param {Array<{role: string, scopeId: string, scopeType: string}>} roleBindings
 * @param {{query: Function}} pg
 * @returns {Promise<string[]>}
 */
async function expandScopeStoreIds(roleBindings, pg) {
  if (!Array.isArray(roleBindings) || roleBindings.length === 0) return []

  const store = new Set()
  let hqExpanded = false

  // 优先处理总部：命中直接全量返回
  for (const rb of roleBindings) {
    if (rb.scopeType === '总部') {
      const rows = await pg.query('SELECT store_id FROM stores')
      for (const r of rows) store.add(r.store_id)
      hqExpanded = true
      break
    }
  }

  if (hqExpanded) return Array.from(store)

  const marketIds = []
  const storeNodeIds = []
  for (const rb of roleBindings) {
    if (rb.scopeType === '市场') marketIds.push(rb.scopeId)
    else if (rb.scopeType === '门店') storeNodeIds.push(rb.scopeId)
  }

  if (marketIds.length > 0) {
    const rows = await pg.query(
      `SELECT s.store_id
       FROM stores s
       JOIN org_nodes o ON s.org_node_id = o.id
       WHERE o.parent_id = ANY($1::text[]) AND o.type = '门店'`,
      [marketIds]
    )
    for (const r of rows) store.add(r.store_id)
  }

  if (storeNodeIds.length > 0) {
    const rows = await pg.query(
      `SELECT store_id FROM stores WHERE org_node_id = ANY($1::text[])`,
      [storeNodeIds]
    )
    for (const r of rows) store.add(r.store_id)
  }

  return Array.from(store)
}

/**
 * 构造门店过滤 SQL 片段
 * 门店模式：`column = $n` 单一门店
 * 管理层模式：`column = ANY($n::text[])` 多门店
 *
 * @param {{effectiveStoreId: string|null, scopeStoreIds: string[], loginLevel: string}} auth
 * @param {string} column - 列引用（如 'o.store_id' 或 'store_id'）
 * @param {number} startIndex - 参数起始下标（$n）
 * @returns {{sql: string, params: any[]} | null} null 表示无需过滤（几乎不出现）
 */
function buildStoreScopeCondition(auth, column, startIndex = 1) {
  if (auth.loginLevel === 'management') {
    // 管理层：按 scopeStoreIds 过滤（空集合返回恒假 sql）
    const ids = auth.scopeStoreIds || []
    if (ids.length === 0) {
      return { sql: 'FALSE', params: [] }
    }
    return {
      sql: `${column} = ANY($${startIndex}::text[])`,
      params: [ids],
    }
  }
  // 门店模式：单一门店
  if (!auth.effectiveStoreId) {
    return { sql: 'FALSE', params: [] }
  }
  return {
    sql: `${column} = $${startIndex}`,
    params: [auth.effectiveStoreId],
  }
}

/**
 * 判定一个 storeId 是否在当前 auth scope 内（不查 DB，纯内存判定）
 *
 * 门店模式：必须等于 effectiveStoreId
 * 管理层模式：必须 ∈ scopeStoreIds
 *
 * @param {{effectiveStoreId: string|null, scopeStoreIds: string[]|null, loginLevel: string}} auth
 * @param {string|null|undefined} storeId
 * @returns {boolean}
 */
function isStoreInScope(auth, storeId) {
  if (!storeId) return false
  if (auth.loginLevel === 'management') {
    const ids = auth.scopeStoreIds || []
    return ids.includes(storeId)
  }
  return storeId === auth.effectiveStoreId
}

/**
 * 断言 client_user_id 在当前 scope 内，否则抛 PERMISSION_DENIED。
 * 不抛即通过；通过路径返回 { boundStoreId } 供调用方复用。
 *
 * SUMMARY v3 §2 #13 / ticket 2026-05-17-scope-helper-cross-end-audit.md
 *
 * @param {{query: Function}} client - 事务客户端或 pg 池
 * @param {object} auth - ctx.auth
 * @param {string} clientUserId
 * @returns {Promise<{boundStoreId: string|null}>}
 */
async function assertCustomerInScope(client, auth, clientUserId) {
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  const rows = await client.query(
    'SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1',
    [clientUserId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不存在')
  }
  const boundStoreId = rows[0].bound_store_id
  if (!isStoreInScope(auth, boundStoreId)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }
  return { boundStoreId }
}

/**
 * 是否需把顾客档案可见性收紧到"绑定本员工"（仅门店普通员工 store_staff）。
 * 店长（store_manager）/ 市场 / 总部仍按门店 scope 看全店顾客。
 *
 * @param {{staffLevel: string|null}} auth
 * @returns {boolean}
 */
function restrictToBoundEmployee(auth) {
  return auth && auth.staffLevel === LEVEL_STORE_STAFF
}

/**
 * 构造"顾客档案"可见性过滤 SQL 片段：门店 scope 之上，
 * 普通员工额外要求 bound_employee_id = 自己。
 *
 * @param {object} auth - ctx.auth
 * @param {string} customerAlias - client_wechat_users 别名（如 'c'）；门店列用 `${alias}.bound_store_id`
 * @param {number} startIndex - 参数起始下标（$n）
 * @returns {{sql: string, params: any[]}}
 */
function buildProfileScopeCondition(auth, customerAlias, startIndex = 1) {
  const store = buildStoreScopeCondition(auth, `${customerAlias}.bound_store_id`, startIndex)
  if (!restrictToBoundEmployee(auth)) return store
  const empIdx = startIndex + store.params.length
  return {
    sql: `${store.sql} AND ${customerAlias}.bound_employee_id = $${empIdx}`,
    params: [...store.params, auth.staffWfId],
  }
}

/**
 * 断言 client_user_id 对当前账号"顾客档案"可见，否则抛 PERMISSION_DENIED。
 * 门店校验复用 assertCustomerInScope；普通员工额外要求 bound_employee_id = 自己。
 * 顾客档案页（detail 及其子 Tab）的统一可见性闸门。
 *
 * @param {{query: Function}} client
 * @param {object} auth - ctx.auth
 * @param {string} clientUserId
 * @returns {Promise<{boundStoreId: string|null, boundEmployeeId: string|null}>}
 */
async function assertCustomerProfileVisible(client, auth, clientUserId) {
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  const rows = await client.query(
    'SELECT bound_store_id, bound_employee_id FROM client_wechat_users WHERE user_id = $1',
    [clientUserId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不存在')
  }
  const { bound_store_id: boundStoreId, bound_employee_id: boundEmployeeId } = rows[0]
  if (!isStoreInScope(auth, boundStoreId)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }
  if (restrictToBoundEmployee(auth) && boundEmployeeId !== auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 顾客未分配给当前员工')
  }
  return { boundStoreId, boundEmployeeId }
}

/**
 * 断言 sale_order_id 在当前 scope 内，否则抛 PERMISSION_DENIED。
 *
 * @param {{query: Function}} client
 * @param {object} auth
 * @param {string} saleOrderId
 * @returns {Promise<{storeId: string|null}>}
 */
async function assertOrderInScope(client, auth, saleOrderId) {
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  const rows = await client.query(
    'SELECT store_id FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 订单不存在')
  }
  const storeId = rows[0].store_id
  if (!isStoreInScope(auth, storeId)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  return { storeId }
}

/**
 * 断言 employee_id 在当前 scope 内（按 staff_wechat_users.store_id），否则抛 PERMISSION_DENIED。
 * 允许"查询自己"无条件通过（auth.staffWfId 等于目标）。
 *
 * @param {{query: Function}} client
 * @param {object} auth
 * @param {string} employeeId
 * @returns {Promise<{storeId: string|null}>}
 */
async function assertEmployeeInScope(client, auth, employeeId) {
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')
  if (auth.staffWfId === employeeId) return { storeId: auth.storeId || null }
  const rows = await client.query(
    'SELECT store_id FROM staff_wechat_users WHERE employee_id = $1',
    [employeeId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 员工不存在')
  }
  const storeId = rows[0].store_id
  if (!isStoreInScope(auth, storeId)) {
    throw new Error('PERMISSION_DENIED: 员工不在当前门店范围内')
  }
  return { storeId }
}

module.exports = {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
  buildStoreScopeCondition,
  isStoreInScope,
  assertCustomerInScope,
  assertOrderInScope,
  assertEmployeeInScope,
  restrictToBoundEmployee,
  buildProfileScopeCondition,
  assertCustomerProfileVisible,
  LEVEL_HEADQUARTERS,
  LEVEL_MARKET,
  LEVEL_STORE_MANAGER,
  LEVEL_STORE_STAFF,
  MANAGEMENT_LEVELS,
  STORE_LEVELS,
}
