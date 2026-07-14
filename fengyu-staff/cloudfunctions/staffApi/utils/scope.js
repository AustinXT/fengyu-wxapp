

const LEVEL_HEADQUARTERS = 'headquarters'
const LEVEL_MARKET = 'market'
const LEVEL_STORE_MANAGER = 'store_manager'
const LEVEL_STORE_STAFF = 'store_staff'

const MANAGEMENT_LEVELS = new Set([LEVEL_HEADQUARTERS, LEVEL_MARKET])
const STORE_LEVELS = new Set([LEVEL_STORE_MANAGER, LEVEL_STORE_STAFF])


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
    
  }

  if (hasHq) return LEVEL_HEADQUARTERS
  if (hasMarket) return LEVEL_MARKET
  if (hasStoreManager) return LEVEL_STORE_MANAGER
  if (hasStoreOther) return LEVEL_STORE_STAFF
  return null
}


function deriveAvailableLoginLevels(staffLevel, scopeStoreIds) {
  if (!staffLevel) return []
  
  
  
  if (staffLevel === LEVEL_STORE_MANAGER) {
    return scopeStoreIds && scopeStoreIds.length > 0
      ? ['store', 'management']
      : ['store']
  }
  if (STORE_LEVELS.has(staffLevel)) return ['store']
  if (MANAGEMENT_LEVELS.has(staffLevel)) {
    return scopeStoreIds && scopeStoreIds.length > 0
      ? ['store', 'management']
      : ['management']
  }
  return []
}


function canAccessManagementLevel(staffLevel) {
  return MANAGEMENT_LEVELS.has(staffLevel) || staffLevel === LEVEL_STORE_MANAGER
}


async function expandScopeStoreIds(roleBindings, pg) {
  if (!Array.isArray(roleBindings) || roleBindings.length === 0) return []

  const store = new Set()
  let hqExpanded = false

  
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


function buildStoreScopeCondition(auth, column, startIndex = 1) {
  if (auth.loginLevel === 'management') {
    
    const ids = auth.scopeStoreIds || []
    if (ids.length === 0) {
      return { sql: 'FALSE', params: [] }
    }
    return {
      sql: `${column} = ANY($${startIndex}::text[])`,
      params: [ids],
    }
  }
  
  if (!auth.effectiveStoreId) {
    return { sql: 'FALSE', params: [] }
  }
  return {
    sql: `${column} = $${startIndex}`,
    params: [auth.effectiveStoreId],
  }
}


function validateManagementScope(auth, scopeType, scopeId) {
  if (auth.staffLevel === LEVEL_HEADQUARTERS) return

  if (auth.staffLevel === LEVEL_STORE_MANAGER) {
    if (scopeType === 'store') {
      const allowed = auth.managerStoreIds || []
      if (!allowed.includes(scopeId)) {
        throw new Error('PERMISSION_DENIED: 越权访问其他门店数据')
      }
      return
    }
    throw new Error('PERMISSION_DENIED: 店长账号仅可查看所辖门店')
  }

  if (auth.staffLevel === LEVEL_MARKET) {
    if (scopeType === 'all') {
      throw new Error('PERMISSION_DENIED: 市场账号不允许查看全部市场数据')
    }
    if (scopeType === 'market') {
      const allowed = (auth.roleBindings || [])
        .filter((rb) => rb && rb.scopeType === '市场')
        .map((rb) => rb.scopeId)
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
  }
}


function isStoreInScope(auth, storeId) {
  if (!storeId) return false
  if (auth.loginLevel === 'management') {
    const ids = auth.scopeStoreIds || []
    return ids.includes(storeId)
  }
  return storeId === auth.effectiveStoreId
}


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


function restrictToBoundEmployee(auth) {
  return auth && auth.staffLevel === LEVEL_STORE_STAFF
}


function buildProfileScopeCondition(auth, customerAlias, startIndex = 1) {
  const store = buildStoreScopeCondition(auth, `${customerAlias}.bound_store_id`, startIndex)
  if (!restrictToBoundEmployee(auth)) return store
  const empIdx = startIndex + store.params.length
  return {
    sql: `${store.sql} AND ${customerAlias}.bound_employee_id = $${empIdx}`,
    params: [...store.params, auth.staffWfId],
  }
}


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
  canAccessManagementLevel,
  expandScopeStoreIds,
  buildStoreScopeCondition,
  validateManagementScope,
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
