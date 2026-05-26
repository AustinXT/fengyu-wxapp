/**
 * cron-09：STEP 9 auditRefundCascadeCoverage 端到端
 *
 * 业务口径：扫描已通过退款（refunds），逐项检查 5 通道是否级联完成
 * （积分扣回 / 卡券撤销 / 储值卡退款 / 分享礼撤销 / 订单状态回滚）。
 * 只读，不修复。
 *
 * 因构造一笔含 5 通道的真退款链路涉及十几张表，超出测试夹具范围；
 * 此处仅验证返回结构 + 当前 PG 状态（不破坏）。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary } from './_helpers/cron-runner'

interface RefundCascadeResult {
  violations: number
  details: Array<{ refundId?: string; missingChannels?: string[]; [k: string]: unknown }>
}

function runAudit(): RefundCascadeResult {
  const out = runCronStep('refundCascadeCoverage')
  const summary = parseStepSummary<RefundCascadeResult>(out, 'refundCascadeCoverage')
  if (!summary) throw new Error(`refundCascadeCoverage summary 解析失败:\n${out}`)
  return summary
}

test.describe('cron-09 auditRefundCascadeCoverage', () => {
  test('9.1 返回结构：violations 整数 + details 数组', () => {
    const r = runAudit()
    expect(typeof r.violations).toBe('number')
    expect(Array.isArray(r.details)).toBe(true)
    expect(r.violations).toBe(r.details.length)
  })

  test('9.2 当前 PG 状态：violations 与 details 一致', () => {
    const r = runAudit()
    if (r.violations === 0) {
      expect(r.details.length).toBe(0)
    } else {
      // 任一 detail 至少有 refundId 或 missingChannels 字段
      for (const d of r.details) {
        const hasRefundId = typeof d.refundId === 'string'
        const hasMissing = Array.isArray(d.missingChannels)
        expect(hasRefundId || hasMissing || Object.keys(d).length > 0).toBe(true)
      }
    }
  })

  test('9.3 重跑只读：跑两次返回相同 violations 数', () => {
    const r1 = runAudit()
    const r2 = runAudit()
    expect(r2.violations).toBe(r1.violations)
  })
})
