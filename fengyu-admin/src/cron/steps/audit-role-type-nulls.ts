

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

export interface RoleTypeNullCheck {
  table: string
  column: string
  nullCount: number
}

export interface RoleTypeNullsAuditResult {
  alertedCount: number
  checks: RoleTypeNullCheck[]
}

const CHECKS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'sale_allocations', column: 'role_type' },
  { table: 'service_commissions', column: 'role_type' },
] as const

export async function auditRoleTypeNulls(db: Db): Promise<RoleTypeNullsAuditResult> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::bigint FROM sale_allocations    WHERE role_type IS NULL) AS sale_alloc_null,
      (SELECT COUNT(*)::bigint FROM service_commissions WHERE role_type IS NULL) AS svc_comm_null
  `)) as Array<{ sale_alloc_null: number | string; svc_comm_null: number | string }>

  const row = rows[0] ?? { sale_alloc_null: 0, svc_comm_null: 0 }
  const counts = [Number(row.sale_alloc_null) || 0, Number(row.svc_comm_null) || 0]

  const checks: RoleTypeNullCheck[] = CHECKS.map((c, i) => ({
    table: c.table,
    column: c.column,
    nullCount: counts[i] ?? 0,
  }))

  let alertedCount = 0
  for (const check of checks) {
    if (check.nullCount > 0) {
      alertedCount++
      
      console.error(
        `[cron-worker] dataIntegrity.roleTypeNull: ${check.table}.${check.column} has ${check.nullCount} NULL row(s)`,
      )
      
      const detail = JSON.stringify({
        table: check.table,
        column: check.column,
        nullCount: check.nullCount,
      })
      await db.execute(sql`
        INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
        VALUES ('dataIntegrity.roleTypeNull', 'table', ${check.table}, ${detail}::jsonb, 'cronTask', NOW())
      `)
    }
  }

  if (alertedCount > 0) {
    const lines = checks.map(
      (c) => `- ${c.table}.${c.column} NULL 行数：${c.nullCount}`,
    )
    await notifyOps(
      [
        '⚠️ [cron-worker] dataIntegrity.roleTypeNull',
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { alertedCount, checks }
}
