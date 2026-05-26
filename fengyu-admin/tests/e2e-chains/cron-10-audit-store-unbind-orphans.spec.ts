/**
 * cron-10：STEP 10 auditStoreUnbindOrphans 端到端
 *
 * 业务口径：扫描 store_unbind_requests，按 status × 顾客可见性等多维度归类孤儿请求。
 * 只读 + notifyOps。
 *
 * 实际输出格式：{ totalOrphans, byKind: { [orphanKind]: number } }
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary } from './_helpers/cron-runner'

interface OrphansResult {
  totalOrphans: number
  byKind: Record<string, number>
}

function runAudit(): OrphansResult {
  const out = runCronStep('storeUnbindOrphans')
  const summary = parseStepSummary<OrphansResult>(out, 'storeUnbindOrphans')
  if (!summary) throw new Error(`storeUnbindOrphans summary 解析失败:\n${out}`)
  return summary
}

test.describe('cron-10 auditStoreUnbindOrphans', () => {
  test('10.1 返回结构：totalOrphans 整数 + byKind 对象', () => {
    const r = runAudit()
    expect(typeof r.totalOrphans).toBe('number')
    expect(r.totalOrphans).toBeGreaterThanOrEqual(0)
    expect(typeof r.byKind).toBe('object')
    // totalOrphans = sum(byKind values)
    const sum = Object.values(r.byKind).reduce((s, v) => s + v, 0)
    expect(r.totalOrphans).toBe(sum)
  })

  test('10.2 重跑只读：跑两次返回相同 totalOrphans', () => {
    const r1 = runAudit()
    const r2 = runAudit()
    expect(r2.totalOrphans).toBe(r1.totalOrphans)
    expect(r2.byKind).toEqual(r1.byKind)
  })
})
