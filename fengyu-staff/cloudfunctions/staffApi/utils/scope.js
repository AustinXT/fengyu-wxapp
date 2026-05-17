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

module.exports = {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
  buildStoreScopeCondition,
  LEVEL_HEADQUARTERS,
  LEVEL_MARKET,
  LEVEL_STORE_MANAGER,
  LEVEL_STORE_STAFF,
  MANAGEMENT_LEVELS,
  STORE_LEVELS,
}
