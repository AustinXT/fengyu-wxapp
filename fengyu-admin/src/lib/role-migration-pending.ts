import { sql } from 'drizzle-orm'

/** 明确调店记录的待办，兼任须人工确认，不能由主门店不同直接推断。 */
export function pendingRoleMigrationsSql(employeeId?: string) {
  return sql`
    WITH latest AS (
      SELECT id, target_id, detail, created_at FROM operation_logs
      WHERE action = 'permission.scopeSync.skipped' AND detail->>'reason' = 'manual_review_required'
    )
    SELECT l.id::text AS event_id, l.target_id AS employee_id, l.created_at,
      e.name AS employee_name, pr.id::float8 AS binding_id, pr.role, pr.scope_id
    FROM latest l
    JOIN staff_wechat_users e ON e.employee_id = l.target_id AND e.is_resigned = false

    JOIN stores old_store ON old_store.store_id = l.detail->>'oldStoreId'
    JOIN permission_roles pr ON pr.employee_id = e.employee_id AND pr.scope_id = old_store.org_node_id
      AND l.detail->'roles' ? pr.role
    LEFT JOIN stores current_store ON current_store.store_id = e.store_id
    WHERE pr.scope_id IS DISTINCT FROM current_store.org_node_id
      AND ${employeeId ? sql`e.employee_id = ${employeeId}` : sql`true`}
      AND NOT EXISTS (
        SELECT 1 FROM operation_logs done WHERE done.action = 'permission.scopeReview.completed'
          AND done.target_id = e.employee_id AND done.detail->>'eventId' = l.id::text
          AND done.detail->'bindingIds' @> jsonb_build_array(pr.id)
      )
    ORDER BY l.created_at, pr.id
  `
}
