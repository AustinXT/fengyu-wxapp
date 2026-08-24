import { db } from '@/db'
import { sql } from 'drizzle-orm'

export async function getInvalidEmployeeAssignmentId(
  employeeIds: string[],
  targetStoreId: string,
  options: { requireServiceSkills?: boolean } = {},
): Promise<string | null> {
  const ids = [...new Set(employeeIds.filter(Boolean))]
  if (ids.length === 0) return null
  const employeeIdParams = sql.join(ids.map((id) => sql`${id}`), sql`, `)

  const rows = (await db.execute(sql`
    SELECT u.employee_id
    FROM staff_wechat_users u
    JOIN stores employee_store ON employee_store.store_id = u.store_id
    JOIN org_nodes employee_store_node ON employee_store_node.id = employee_store.org_node_id
    JOIN stores target_store ON target_store.store_id = ${targetStoreId}
    JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
    WHERE u.employee_id IN (${employeeIdParams})
      AND u.is_resigned = false
      AND u.store_id IS NOT NULL
      AND (
        u.store_id = ${targetStoreId}
        OR (
          u.is_on_business_trip = true
          AND employee_store_node.parent_id = target_store_node.parent_id
        )
      )
      AND (${options.requireServiceSkills === true} = false
        OR u.skills && ARRAY['美容师','养生师']::text[])
  `)) as unknown as Array<{ employee_id: string }>

  const validIds = new Set(rows.map((row) => row.employee_id))
  return ids.find((id) => !validIds.has(id)) ?? null
}
