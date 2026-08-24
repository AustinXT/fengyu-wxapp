/**
 * 员工跨店候选资格：本门店员工，或同一市场内已开启出差支援的员工。
 * 市场归属以 stores → 门店 org_node.parent_id 为权威，不使用业务单据的 market_name 快照。
 */

function rowsOf(result) {
  return Array.isArray(result) ? result : (result?.rows || [])
}

async function getAssignableEmployeeIds(queryable, employeeIds, targetStoreId, options = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))]
  if (ids.length === 0) return new Set()

  const requireServiceSkills = options.requireServiceSkills === true
  const result = await queryable.query(`
    SELECT u.employee_id
    FROM staff_wechat_users u
    JOIN stores employee_store ON employee_store.store_id = u.store_id
    JOIN org_nodes employee_store_node ON employee_store_node.id = employee_store.org_node_id
    JOIN stores target_store ON target_store.store_id = $2
    JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
    WHERE u.employee_id = ANY($1::text[])
      AND u.is_resigned = false
      AND u.store_id IS NOT NULL
      AND (
        u.store_id = $2
        OR (
          u.is_on_business_trip = true
          AND employee_store_node.parent_id = target_store_node.parent_id
        )
      )
      AND ($3::boolean = false OR u.skills && ARRAY['美容师','养生师']::text[])
  `, [ids, targetStoreId, requireServiceSkills])

  return new Set(rowsOf(result).map((row) => row.employee_id))
}

async function isEmployeeAssignableToStore(queryable, employeeId, targetStoreId, options = {}) {
  if (!employeeId || !targetStoreId) return false
  const validIds = await getAssignableEmployeeIds(queryable, [employeeId], targetStoreId, options)
  return validIds.has(employeeId)
}

async function assertEmployeesAssignableToStore(queryable, employeeIds, targetStoreId, options = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))]
  if (ids.length === 0) return
  const validIds = await getAssignableEmployeeIds(queryable, ids, targetStoreId, options)
  const invalidId = ids.find((id) => !validIds.has(id))
  if (invalidId) {
    throw new Error('INVALID_PARAMS: 所选员工不属于本门店或同市场出差支援范围')
  }
}

module.exports = {
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
}
