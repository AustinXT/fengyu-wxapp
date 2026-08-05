/**
 * STEP 6 — role_type NULL 行回归监控
 *
 * 背景：
 *   `sale_payment_item_allocations.role_type` 沿用销售分配角色字段（旧
 *   `sale_allocations.role_type` 历史曾积累 156k+ NULL，详见
 *   `notes/tickets/2026-04-25-role-type-not-null-guard.md`），通过一次性 backfill
 *   清零；`service_commissions.role_type` 同源问题，已配套 backfill。
 *   schema 同步加了 `.notNull()`（migration 落库后由 PG 兜底），但在 migration
 *   未跑或某条 INSERT 路径绕过 schema 之前，仍然可能再次积累 NULL。
 *
 * 决策：参照 STEP 5（auditPointsBalance），只告警不修复。
 *   - 每日跑 1 次 SELECT，统计两表 role_type IS NULL 的行数
 *   - 任一表 > 0 → INSERT operation_logs(action='dataIntegrity.roleTypeNull')
 *     + console.error（cron-worker 容器日志最低介入门槛的告警通道）
 *   - 永远不 UPDATE（修复需人工 + backfill 脚本）
 *
 * 监控 SQL（只读）：
 *   SELECT
 *     (SELECT COUNT(*) FROM sale_payment_item_allocations WHERE role_type IS NULL) AS sale_alloc_null,
 *     (SELECT COUNT(*) FROM service_commissions WHERE role_type IS NULL) AS svc_comm_null;
 *
 * 当前项目无企微 webhook / SMS / 邮件等告警通道，最小可行版本：
 *   告警 = console.error（容器日志） + operation_logs 行（admin 后台可查）。
 *   完整告警通道作为后续 ticket（见 notes/tickets/2026-04-25-crontask-data-integrity-monitor.md）。
 */

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
  { table: 'sale_payment_item_allocations', column: 'role_type' },
  { table: 'service_commissions', column: 'role_type' },
] as const

export async function auditRoleTypeNulls(db: Db): Promise<RoleTypeNullsAuditResult> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::bigint FROM sale_payment_item_allocations WHERE role_type IS NULL) AS sale_alloc_null,
      (SELECT COUNT(*)::bigint FROM service_commissions              WHERE role_type IS NULL) AS svc_comm_null
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
      // 容器日志层告警（cron-worker stdout/stderr → docker logs / 监控聚合）
      console.error(
        `[cron-worker] dataIntegrity.roleTypeNull: ${check.table}.${check.column} has ${check.nullCount} NULL row(s)`,
      )
      // operation_logs 行（admin 后台可查；与 STEP 5 source='cronTask' 一致）
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
