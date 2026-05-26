/**
 * cron-07：STEP 7 auditRoleTypeNulls 端到端
 *
 * 业务口径：检查 sale_allocations / service_commissions 的 role_type 是否有 NULL。
 * 不修复，仅告警 + notifyOps。
 *
 * 关键：返回的 checks 数组含两张表的 nullCount。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'

interface RoleTypeNullsResult {
  checks: Array<{ table: string; column: string; nullCount: number }>
  alertedCount: number
}

function runAudit(): RoleTypeNullsResult {
  const out = runCronStep('roleTypeNullsAudit')
  const summary = parseStepSummary<RoleTypeNullsResult>(out, 'roleTypeNullsAudit')
  if (!summary) throw new Error(`roleTypeNullsAudit summary 解析失败:\n${out}`)
  return summary
}

test.describe.serial('cron-07 auditRoleTypeNulls', () => {
  // 此 STEP 直接查全表，不需要 fixture。我们只断言结果结构和当前状态。
  // 如果生产 DB 当前有 role_type NULL 数据，totalNull > 0；否则 = 0。

  test('7.1 返回结构包含 2 张表的检查结果', () => {
    const result = runAudit()
    expect(Array.isArray(result.checks)).toBe(true)
    expect(result.checks.length).toBe(2)
    const tables = result.checks.map((c) => c.table).sort()
    expect(tables).toEqual(['sale_allocations', 'service_commissions'])
  })

  test('7.2 alertedCount 是个非负整数', () => {
    const result = runAudit()
    expect(typeof result.alertedCount).toBe('number')
    expect(result.alertedCount).toBeGreaterThanOrEqual(0)
  })

  test('7.3 当前 PG 中 role_type 状态与 audit 输出一致', () => {
    const allocNull = Number(
      psql(`SELECT COUNT(*) FROM sale_allocations WHERE role_type IS NULL`),
    )
    const commNull = Number(
      psql(`SELECT COUNT(*) FROM service_commissions WHERE role_type IS NULL`),
    )
    const result = runAudit()
    const allocCheck = result.checks.find((c) => c.table === 'sale_allocations')
    const commCheck = result.checks.find((c) => c.table === 'service_commissions')
    expect(allocCheck?.nullCount).toBe(allocNull)
    expect(commCheck?.nullCount).toBe(commNull)
  })
})
