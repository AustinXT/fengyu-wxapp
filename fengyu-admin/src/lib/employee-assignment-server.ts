import { db } from '@/db'
import { sql } from 'drizzle-orm'

export async function getInvalidEmployeeAssignmentId(
  employeeIds: string[],
  targetStoreId: string,
  options: {
    requireServiceSkills?: boolean
    assignmentScope?: 'localOnly' | 'allocationSupport'
  } = {},
): Promise<string | null> {
  const ids = [...new Set(employeeIds.filter(Boolean))]
  if (ids.length === 0) return null
  const employeeIdParams = sql.join(ids.map((id) => sql`${id}`), sql`, `)
  const assignmentCondition = options.assignmentScope === 'allocationSupport'
    ? sql`(u.store_id = ${targetStoreId} OR u.is_on_business_trip = true)`
    : sql`u.store_id = ${targetStoreId}`

  const rows = (await db.execute(sql`
    SELECT u.employee_id
    FROM staff_wechat_users u
    WHERE u.employee_id IN (${employeeIdParams})
      AND u.is_resigned = false
      AND ${assignmentCondition}
      AND (${options.requireServiceSkills === true} = false
        OR u.skills && ARRAY['美容师','养生师']::text[])
  `)) as unknown as Array<{ employee_id: string }>

  const validIds = new Set(rows.map((row) => row.employee_id))
  return ids.find((id) => !validIds.has(id)) ?? null
}
