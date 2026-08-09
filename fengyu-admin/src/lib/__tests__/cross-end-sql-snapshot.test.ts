/**
 * cross-end-sql-snapshot 反模式守护（admin 端）
 *
 * 与 staff 侧
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * 的反模式守护块对称（test-colocation feedback：admin CI 必须自查自家 SQL 文件）。
 *
 * 背景（PR #74 meta）：既有 snapshot 仅做四端字面比对，若四端同时被引入同一同形 bug
 * （如 `SUM(amount)::int` 截断 bigint / 全额退款后 rollup 保留旧状态），
 * 字面量仍一致 → snapshot PASS，测试夹具形同虚设。
 * 本文件对 admin 端关键 SQL 做 not-to-contain 特征守护，任一已知反模式回退立即失败。
 *
 * 已知反模式（PR #74 已修复，防回退）：
 *   1. granted SQL 用 ::int 截断 SUM(amount)（应 ::bigint）— g03
 *   2. 全额退款后 rollup 保留订单旧 allocation_status，造成父子状态不一致。
 */

import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const FILES = {
  adminPointsSettleTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/points-settle.ts'),
  adminPaymentAllocatableTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/payment-allocatable.ts'),
  adminPaidSessionsTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/paid-sessions.ts'),
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

/**
 * 跨端归一化 SQL 文本（pg $1 与 Drizzle ${var} 都 → ?，空白压缩）。
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

/**
 * 提取源文件中第一个含 marker 的 backtick 字符串内容（无外层反引号）。
 */
function extractBacktickContaining(src: string, marker: string): string {
  const matches = src.matchAll(/`([^`]+)`/g)
  for (const m of matches) {
    if (m[1].includes(marker)) return m[1]
  }
  throw new Error(`未找到含 "${marker}" 的 backtick 字符串`)
}

describe('cross-end-sql-snapshot 反模式守护（admin 端）', () => {
  let grantedSql: string
  let allocRollupSql: string

  beforeAll(() => {
    grantedSql = normalizeSql(extractBacktickContaining(readFile(FILES.adminPointsSettleTs), 'AS granted'))
    allocRollupSql = normalizeSql(extractBacktickContaining(readFile(FILES.adminPaymentAllocatableTs), 'allocation_status = CASE'))
  })

  // 反模式 1：granted SUM(amount) 不得 ::int 截断（应 ::bigint，防 g03 回退）
  test('granted SQL 不得用 ::int 截断 SUM(amount)（应 ::bigint）', () => {
    expect(grantedSql, 'granted SQL 用 ::int 截断 SUM(amount)，应改 ::bigint').not.toMatch(
      /SUM\(amount\)[\s\S]*::\s*int\b/i,
    )
    expect(grantedSql, 'granted SQL 缺少 ::bigint cast').toMatch(/SUM\(amount\)[\s\S]*::\s*bigint\b/i)
  })

  // 反模式 2：子付款状态全部清空后，父订单也必须清空，不能保留历史状态。
  test('订单 rollup 在无待/已分配子付款时必须归 NULL', () => {
    expect(allocRollupSql, 'rollup 缺少无子付款状态时清空父订单的分支').toMatch(
      /ELSE\s+NULL::allocation_status\s+END/,
    )
    expect(allocRollupSql, 'rollup 不得保留已失效的父订单 allocation_status').not.toMatch(
      /ELSE\s+allocation_status\s+END/,
    )
  })

  // 反模式 3：paid_sessions 公式必须 FLOOR 保守取整（防 round/ceil 虚高剩余次数）
  test('paid_sessions 公式必须用 FLOOR 保守取整（不得 round/ceil）', () => {
    const paidSql = normalizeSql(extractBacktickContaining(readFile(FILES.adminPaidSessionsTs), 'paid_sessions = CASE'))
    expect(paidSql, 'paid_sessions 公式缺少 FLOOR').toMatch(/FLOOR\(/i)
    expect(paidSql, 'paid_sessions 公式不得用 ROUND').not.toMatch(/\bROUND\(/i)
    expect(paidSql, 'paid_sessions 公式不得用 CEIL').not.toMatch(/\bCEIL\(/i)
  })

  test('退款负 receipt 不得参与 Branch A 覆盖判断，且 Branch B 必须执行逐项退款扣减', () => {
    const paidSessionsSource = readFile(FILES.adminPaidSessionsTs)
    const coverageSql = normalizeSql(extractBacktickContaining(paidSessionsSource, 'AS receipt_positive_total'))
    expect(coverageSql).toMatch(/sop\.change_type IN\s*\('首次支付','回款','储值卡抵扣'\)/)
    expect(coverageSql).not.toContain("'退款'")

    const allocationIndex = paidSessionsSource.indexOf('WITH tg AS')
    const refundDeductIndex = paidSessionsSource.indexOf('WITH refund_items AS', allocationIndex)
    const paidRecalcIndex = paidSessionsSource.indexOf('paid_sessions = CASE', refundDeductIndex)
    expect(refundDeductIndex).toBeGreaterThan(allocationIndex)
    expect(paidRecalcIndex).toBeGreaterThan(refundDeductIndex)
    expect(paidSessionsSource.slice(refundDeductIndex - 80, refundDeductIndex)).toMatch(/await tx\.execute\(sql`\s*$/)
  })
})
