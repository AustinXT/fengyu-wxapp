import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { pendingRoleMigrationsSql } from '@/lib/role-migration-pending'
import { notifyOps } from '../lib/notify'

export async function auditRoleMigrations(db: Db) {
  const rows = await db.execute(sql`SELECT * FROM (${pendingRoleMigrationsSql()}) pending
    WHERE created_at::timestamptz < now() - interval '3 days'`) as unknown as Array<{ employee_id: string; event_id: string; binding_id: number }>
  if (rows.length) {
    const employees = [...new Set(rows.map(row => row.employee_id))]
    await db.execute(sql`INSERT INTO operation_logs(action,target_type,target_id,detail,source)
      VALUES ('cron.audit_role_migrations','role_migration',to_char(now(),'YYYY-MM-DD'),
      ${JSON.stringify({ total: rows.length, samples: rows.slice(0, 10) })}::jsonb,'cronTask')`)
    await notifyOps(`⚠️ 调店角色待办超过3天：${rows.length}条绑定；员工 ${employees.slice(0, 10).join('、')}。请到权限管理按员工复核。`)
  }
  return { overdueBindings: rows.length }
}
