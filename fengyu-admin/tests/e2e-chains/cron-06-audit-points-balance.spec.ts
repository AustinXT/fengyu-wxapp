/**
 * cron-06：STEP 6 auditPointsBalance 端到端
 *
 * 业务口径：检查 client_wechat_users.points_balance 与 point_transactions SUM(amount) 是否一致。
 * 不一致仅告警（INSERT operation_logs(action='points.balanceMismatch')），不修补。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { countOperationLogs, getPointsBalance } from './_helpers/cron-asserts'

interface AuditResult {
  mismatchCount: number
  checkedCount: number
}

function runAudit(): AuditResult {
  const out = runCronStep('pointsAudit')
  const summary = parseStepSummary<AuditResult>(out, 'pointsAudit')
  if (!summary) throw new Error(`pointsAudit summary 解析失败:\n${out}`)
  return summary
}

/** 给 user 插入一条 point_transactions（成功 INSERT 但不联动 points_balance）*/
function insertPointTxn(userId: string, amount: number, ref?: string): void {
  const refValue = ref ? `'${ref}'` : 'NULL'
  psql(`
    INSERT INTO point_transactions (user_id, type, amount, external_ref, created_at)
    VALUES ('${userId}', '调整', ${amount}, ${refValue}, NOW())
  `)
}

test.describe.serial('cron-06 auditPointsBalance', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('6.1 一致：balance = SUM(txns) → 不告警', () => {
    const uid = upsertClient('PA_61', { customerType: '会员客', pointsBalance: 100 })
    insertPointTxn(uid, 60, `${PREFIX.IDEM}PA_61_a`)
    insertPointTxn(uid, 40, `${PREFIX.IDEM}PA_61_b`)
    runAudit()
    expect(countOperationLogs('points.balanceMismatch', uid)).toBe(0)
  })

  test('6.2 正向差：balance 比 SUM 多 100 → 告警', () => {
    const uid = upsertClient('PA_62', { customerType: '会员客', pointsBalance: 200 })
    insertPointTxn(uid, 60, `${PREFIX.IDEM}PA_62_a`)
    insertPointTxn(uid, 40, `${PREFIX.IDEM}PA_62_b`)
    runAudit()
    expect(countOperationLogs('points.balanceMismatch', uid)).toBeGreaterThanOrEqual(1)
  })

  test('6.3 负向差：balance 比 SUM 少 50 → 告警', () => {
    const uid = upsertClient('PA_63', { customerType: '会员客', pointsBalance: 50 })
    insertPointTxn(uid, 60, `${PREFIX.IDEM}PA_63_a`)
    insertPointTxn(uid, 40, `${PREFIX.IDEM}PA_63_b`)
    runAudit()
    expect(countOperationLogs('points.balanceMismatch', uid)).toBeGreaterThanOrEqual(1)
  })

  test('6.4 只读：重跑后 balance 仍是错的（不修复）', () => {
    const uid = `${PREFIX.CLIENT}PA_62`
    const before = getPointsBalance(uid)
    runAudit()
    expect(getPointsBalance(uid)).toBe(before)
  })

  test('cleanup', () => {
    cleanupCronE2E()
    expect(Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}PA_%'`))).toBe(0)
  })
})
