import { psql } from './scope-helpers'

const sqlStr = (value: string) => `'${value.replace(/'/g, "''")}'`

export interface AuditLogRow {
  action: string
  targetId: string
  detail: Record<string, unknown> | null
  operatorEmployeeId: string
  createdAt: string
}

/** 读取指定对象的最新审计记录；供跨模块配置链路共用。 */
export function readLatestAudit(action: string, targetId: string): AuditLogRow | null {
  const row = psql(
    `SELECT action, target_id, COALESCE(detail::text, ''), operator_employee_id, created_at::text ` +
      `FROM operation_logs WHERE action = ${sqlStr(action)} AND target_id = ${sqlStr(targetId)} ` +
      `ORDER BY created_at DESC LIMIT 1`,
  )
  if (!row) return null
  const first = row.indexOf('|')
  const second = row.indexOf('|', first + 1)
  const last = row.lastIndexOf('|')
  const previous = row.lastIndexOf('|', last - 1)
  if (first < 0 || second < 0 || previous < 0 || last < 0) return null
  const detailText = row.slice(second + 1, previous)
  let detail: Record<string, unknown> | null = null
  try {
    detail = detailText ? JSON.parse(detailText) : null
  } catch {
    detail = null
  }
  return {
    action: row.slice(0, first),
    targetId: row.slice(first + 1, second),
    detail,
    operatorEmployeeId: row.slice(previous + 1, last),
    createdAt: row.slice(last + 1),
  }
}
