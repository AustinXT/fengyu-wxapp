/**
 * 员工指派资格分为两个显式场景：
 * - localOnly（默认）：仅本门店员工，用于开单、服务单等普通指派；
 * - allocationSupport：本门店员工或任意已开启出差支援的员工，仅用于营业额/服务提成分配。
 */

function rowsOf(result) {
  return Array.isArray(result) ? result : (result?.rows || [])
}

async function getAssignableEmployeeIds(queryable, employeeIds, targetStoreId, options = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))]
  if (ids.length === 0) return new Set()

  const requireServiceSkills = options.requireServiceSkills === true
  const assignmentScope = options.assignmentScope === 'allocationSupport'
    ? 'allocationSupport'
    : 'localOnly'
  const assignmentCondition = assignmentScope === 'allocationSupport'
    ? '(u.store_id = $2 OR u.is_on_business_trip = true)'
    : 'u.store_id = $2'
  const result = await queryable.query(`
    SELECT u.employee_id
    FROM staff_wechat_users u
    WHERE u.employee_id = ANY($1::text[])
      AND u.is_resigned = false
      AND ${assignmentCondition}
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
    const message = options.assignmentScope === 'allocationSupport'
      ? '所选员工不属于本门店且未开启出差支援'
      : '所选员工不属于本门店'
    throw new Error(`INVALID_PARAMS: ${message}`)
  }
}

module.exports = {
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
}
