/**
 * cross-end-sql-snapshot 反模式守护（admin 端）
 *
 * 与 staff 侧
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * 的反模式守护块对称（test-colocation feedback：admin CI 必须自查自家 SQL 文件）。
 *
 * 背景（PR #74 meta）：既有 snapshot 仅做四端字面比对，若四端同时被引入同一同形 bug
 * （如 `SUM(amount)::int` 截断 bigint / rollup `ELSE NULL::allocation_status` 覆盖旧值），
 * 字面量仍一致 → snapshot PASS，测试夹具形同虚设。
 * 本文件对 admin 端关键 SQL 做 not-to-contain 特征守护，任一已知反模式回退立即失败。
 *
 * 已知反模式（PR #74 已修复，防回退）：
 *   1. granted SQL 用 ::int 截断 SUM(amount)（应 ::bigint）— g03
 *   2. 营业额分配 rollup 用 ELSE NULL::allocation_status 覆盖订单旧值
 *      （应 ELSE allocation_status 保留旧值）— g05
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

  // 反模式 2：订单 rollup 不得用 ELSE NULL 覆盖 allocation_status（应保留旧值，防 g05 回退）
  test('订单 rollup 不得用 ELSE NULL::allocation_status 覆盖旧值（应 ELSE allocation_status）', () => {
    expect(allocRollupSql, 'rollup 用 ELSE NULL::allocation_status 覆盖订单 allocation_status，应改 ELSE allocation_status').not.toContain(
      'ELSE NULL::allocation_status',
    )
    expect(allocRollupSql, 'rollup 缺少保留旧值分支 ELSE allocation_status END').toMatch(
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
})
