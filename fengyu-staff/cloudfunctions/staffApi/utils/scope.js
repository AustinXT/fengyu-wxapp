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

const STORE_LEVELS = new Set([LEVEL_STORE_MANAGER, LEVEL_STORE_STAFF])

function rowsOf(result) {
  return Array.isArray(result) ? result : (result?.rows || [])
}

/** 多个根节点的递归后代 CTE，$n 指向 text[] 根节点参数。 */
function descendantStoresSqlForRoots(column, startIndex) {
  return `${column} IN (
    WITH RECURSIVE descendants(id, path) AS (
      SELECT root_id::text, ARRAY[root_id::text]
      FROM unnest($${startIndex}::text[]) AS roots(root_id)
      UNION ALL
      SELECT child.id, descendants.path || child.id
      FROM org_nodes child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT DISTINCT s.store_id
    FROM stores s
    JOIN descendants ON s.org_node_id = descendants.id
  )`
}

/** 单个根节点的递归后代 CTE，$n 指向 text 根节点参数。 */
function descendantStoresSqlForRoot(column, startIndex) {
  return `${column} IN (
    WITH RECURSIVE descendants(id, path) AS (
      SELECT $${startIndex}::text, ARRAY[$${startIndex}::text]
      UNION ALL
      SELECT child.id, descendants.path || child.id
      FROM org_nodes child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE NOT child.id = ANY(descendants.path)
    )
    SELECT DISTINCT s.store_id
    FROM stores s
    JOIN descendants ON s.org_node_id = descendants.id
  )`
}

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
 * 基于 staffLevel、scopeStoreIds 和 data_center:dashboard 计算登录模式候选。
 *
 * 门店模式仍沿用 staffLevel 的既有语义；管理层模式只由权限矩阵 action
 * 决定，且必须至少拥有一间可见门店，避免无 scope 账号进入空视图。
 * @param {string|null} staffLevel
 * @param {string[]} scopeStoreIds
 * @param {boolean} hasDataCenterDashboard
 * @returns {Array<'store'|'management'>}
 */
function deriveAvailableLoginLevels(staffLevel, scopeStoreIds, hasDataCenterDashboard = false) {
  if (!staffLevel) return []
  const hasStores = Array.isArray(scopeStoreIds) && scopeStoreIds.length > 0
  const levels = []

  if (STORE_LEVELS.has(staffLevel) || hasStores) {
    levels.push('store')
  }
  if (hasDataCenterDashboard && hasStores) {
    levels.push('management')
  }
  return levels
}

/** True when at least one valid role binding is attached to headquarters. */
function hasHeadquartersScope(roleBindings) {
  return Array.isArray(roleBindings)
    && roleBindings.some((binding) => binding && binding.scopeType === '总部')
}

/**
 * 展开所有 scope 到可见门店列表（去重）
 * 规则：
 *  - 总部 scope → 全部 stores
 *  - 市场/门店 scope → 绑定节点自身及任意层级后代关联的 stores
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
      const rows = rowsOf(await pg.query('SELECT store_id FROM stores'))
      for (const r of rows) store.add(r.store_id)
      hqExpanded = true
      break
    }
  }

  if (hqExpanded) return Array.from(store)

  const rootNodeIds = []
  for (const rb of roleBindings) {
    if ((rb.scopeType === '市场' || rb.scopeType === '门店') && rb.scopeId) {
      rootNodeIds.push(rb.scopeId)
    }
  }

  if (rootNodeIds.length > 0) {
    const rows = rowsOf(await pg.query(
      `SELECT DISTINCT s.store_id
       FROM stores s
       WHERE ${descendantStoresSqlForRoots('s.store_id', 1)}`,
      [Array.from(new Set(rootNodeIds))],
    ))
    for (const r of rows) store.add(r.store_id)
  }

  return Array.from(store)
}

/** 角色根节点自身及全部后代组织节点，供管理层二级市场校验和选项过滤使用。 */
async function expandScopeOrgNodeIds(roleBindings, pg) {
  if (!Array.isArray(roleBindings) || roleBindings.length === 0) return []
  if (roleBindings.some((rb) => rb && rb.scopeType === '总部')) {
    const rows = rowsOf(await pg.query('SELECT id FROM org_nodes'))
    return Array.from(new Set(rows.map((row) => row.id)))
  }

  const roots = Array.from(new Set(roleBindings
    .filter((rb) => rb && (rb.scopeType === '市场' || rb.scopeType === '门店') && rb.scopeId)
    .map((rb) => rb.scopeId)))
  if (roots.length === 0) return []

  const rows = rowsOf(await pg.query(
    `WITH RECURSIVE descendants(id, path) AS (
       SELECT root_id::text, ARRAY[root_id::text]
       FROM unnest($1::text[]) AS roots(root_id)
       UNION ALL
       SELECT child.id, descendants.path || child.id
       FROM org_nodes child
       JOIN descendants ON child.parent_id = descendants.id
       WHERE NOT child.id = ANY(descendants.path)
     )
     SELECT DISTINCT id FROM descendants`,
    [roots],
  ))
  return Array.from(new Set(rows.map((row) => row.id)))
}

/**
 * 管理层显式选择 all/market/store 时的门店条件。
 * 市场范围使用递归组织树，不允许通过“直属门店”绕过下属节点。
 */
function buildManagementStoreScope(scopeType, scopeId, column, startIndex = 1) {
  if (scopeType === 'all') return { sql: 'TRUE', params: [] }
  if (scopeType === 'store') {
    return { sql: `${column} = $${startIndex}`, params: [scopeId] }
  }
  return {
    sql: descendantStoresSqlForRoot(column, startIndex),
    params: [scopeId],
  }
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
 * 校验管理层请求 scope（scopeType / scopeId）是否在账号全部角色绑定的 scope 内。
 *
 * - all：仅总部 scope 可选；
 * - market：必须是 scopeOrgNodeIds 中的市场节点；
 * - store：必须在 scopeStoreIds 中。
 *
 * 管理层数据不使用 managerStoreIds。该集合只服务门店模式下的店长写操作，
 * 以便拥有多个角色绑定的员工按全部 scope 查看数据中心。
 *
 * @param {{roleBindings: Array, scopeStoreIds: string[], scopeOrgNodeIds: string[]}} auth
 * @param {string} scopeType 'all' | 'market' | 'store'
 * @param {string} [scopeId]
 */
function validateManagementScope(auth, scopeType, scopeId) {
  if (scopeType === 'all') {
    if (!hasHeadquartersScope(auth.roleBindings)) {
      throw new Error('PERMISSION_DENIED: 无权查看全部市场数据')
    }
    return
  }

  if (scopeType === 'market') {
    const allowed = auth.scopeOrgNodeIds || []
    if (!allowed.includes(scopeId)) {
      throw new Error('PERMISSION_DENIED: 越权访问其他市场数据')
    }
    return
  }

  if (scopeType === 'store') {
    const allowed = auth.scopeStoreIds || []
    if (!allowed.includes(scopeId)) {
      throw new Error('PERMISSION_DENIED: 越权访问其他门店数据')
    }
    return
  }

  throw new Error('PERMISSION_DENIED: 不支持的管理层范围')
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

// ===== 商品市场范围过滤（staffApi 内跨路由复用） =====

/**
 * 提取 market_scope 列的比较值 SQL 表达式。
 * market_scope 格式为逗号分隔的 org_nodes.id 或市场名。
 */
function marketScopeValues(scopeExpr) {
  return `string_to_array(regexp_replace(${scopeExpr}, '[[:space:]]+', '', 'g'), ',')`
}

/**
 * 组合套餐主商品范围过滤条件（不含 AND 前缀）。
 * products.market_scope — 仅按当前工作台 effectiveStoreId 判断。
 * 没有 effectiveStoreId 时返回全市场条件（market_scope IS NULL）。
 */
function buildBundleMarketScopeCondition(auth, params, productAlias = 'p') {
  const scopeExpr = `${productAlias}.market_scope`
  const valuesExpr = marketScopeValues(scopeExpr)
  const globalExpr = `${scopeExpr} IS NULL`
  const nonBlankExpr = `NULLIF(regexp_replace(${scopeExpr}, '[[:space:]]+', '', 'g'), '') IS NOT NULL`
  const effectiveStoreId = auth?.effectiveStoreId

  if (!effectiveStoreId) return globalExpr

  params.push(effectiveStoreId)
  const storeParam = `$${params.length}`
  return `(
    ${globalExpr}
    OR (
      ${nonBlankExpr}
      AND EXISTS (
        SELECT 1
        FROM stores s
        JOIN org_nodes sn ON s.org_node_id = sn.id
        JOIN org_nodes pm ON sn.parent_id = pm.id
        WHERE s.store_id = ${storeParam}
          AND pm.type = '市场'
          AND (
            pm.id = ANY(${valuesExpr})
            OR regexp_replace(pm.name, '[[:space:]]+', '', 'g') = ANY(${valuesExpr})
          )
      )
    )
  )`
}

/**
 * 组合套餐主商品范围过滤 AND 片段。
 * 用法: WHERE ... ${buildBundleMarketScopeFilter(auth, params)}
 */
function buildBundleMarketScopeFilter(auth, params, productAlias = 'p') {
  return `AND ${buildBundleMarketScopeCondition(auth, params, productAlias)}`
}

/**
 * 普通 SKU 开单范围过滤条件（不含 AND 前缀）。
 * product_skus.market_scope — 与套餐主商品保持一致，仅按 effectiveStoreId 判断。
 * 管理层未选门店时仅返回全市场 SKU。
 */
function buildNormalSkuMarketScopeCondition(auth, params, skuAlias = 'sk') {
  const scopeExpr = `${skuAlias}.market_scope`
  const valuesExpr = marketScopeValues(scopeExpr)
  const globalExpr = `${scopeExpr} IS NULL`
  const nonBlankExpr = `NULLIF(regexp_replace(${scopeExpr}, '[[:space:]]+', '', 'g'), '') IS NOT NULL`
  const effectiveStoreId = auth?.effectiveStoreId

  if (!effectiveStoreId) return globalExpr

  params.push(effectiveStoreId)
  const storeParam = `$${params.length}`
  return `(
    ${globalExpr}
    OR (
      ${nonBlankExpr}
      AND EXISTS (
        SELECT 1
        FROM stores store
        JOIN org_nodes store_node ON store.org_node_id = store_node.id
        JOIN org_nodes market_node ON store_node.parent_id = market_node.id
        WHERE store.store_id = ${storeParam}
          AND market_node.type = '市场'
          AND (
            market_node.id = ANY(${valuesExpr})
            OR regexp_replace(market_node.name, '[[:space:]]+', '', 'g') = ANY(${valuesExpr})
          )
      )
    )
  )`
}

/**
 * 普通 SKU 开单范围过滤 AND 片段。
 * 用法: WHERE ... ${buildNormalSkuMarketScopeFilter(auth, params)}
 */
function buildNormalSkuMarketScopeFilter(auth, params, skuAlias = 'sk') {
  return `AND ${buildNormalSkuMarketScopeCondition(auth, params, skuAlias)}`
}

module.exports = {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  hasHeadquartersScope,
  expandScopeStoreIds,
  expandScopeOrgNodeIds,
  buildManagementStoreScope,
  buildStoreScopeCondition,
  validateManagementScope,
  isStoreInScope,
  assertCustomerInScope,
  assertOrderInScope,
  assertEmployeeInScope,
  restrictToBoundEmployee,
  buildProfileScopeCondition,
  assertCustomerProfileVisible,
  buildBundleMarketScopeCondition,
  buildBundleMarketScopeFilter,
  buildNormalSkuMarketScopeCondition,
  buildNormalSkuMarketScopeFilter,
  marketScopeValues,
  LEVEL_HEADQUARTERS,
  LEVEL_MARKET,
  LEVEL_STORE_MANAGER,
  LEVEL_STORE_STAFF,
  STORE_LEVELS,
}
