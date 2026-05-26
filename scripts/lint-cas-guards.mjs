#!/usr/bin/env node
// scripts/lint-cas-guards.mjs
// 状态机 UPDATE 必须携带 AND status = / IN / ANY 守卫；
// 仅写资金/PII 列的 UPDATE 用 `// CAS-EXEMPT: <reason>` 注释豁免。
// 详见 notes/tickets/archives/2026-05-17-state-machine-cas-guard.md §5.2
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const TABLES = [
  'sale_orders',
  'appointments',
  'service_orders',
  'store_unbind_requests',
  'sale_order_payments',
]

// 用 git ls-files 列文件，避免依赖 glob 包
function listFiles() {
  const out = execSync(
    `git ls-files -- 'fengyu-admin/src/**/*.ts' 'fengyu-admin/src/**/*.tsx' 'fengyu-admin/src/**/*.js' 'fengyu-staff/cloudfunctions/**/*.js' 'fengyu-client/cloudfunctions/**/*.js'`,
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
    .filter((l) => !l.includes('/__tests__/'))
    .filter((l) => !l.includes('/node_modules/'))
    .filter((l) => !/\.test\.[jt]sx?$/.test(l))
    .filter((l) => !/\.spec\.[jt]sx?$/.test(l))
}

const updateRe = new RegExp(
  `UPDATE\\s+(${TABLES.join('|')})[\\s\\S]{0,400}?SET[\\s\\S]{0,400}?status`,
  'g'
)
// 已带前置态守卫：WHERE/AND ... status (= / IN / = ANY)
const guardRe = /(AND|WHERE)[\s\S]{0,200}status\s*(=|IN|=\s*ANY)/

let failed = 0
const files = listFiles()
for (const rel of files) {
  let src
  try {
    src = readFileSync(resolve(ROOT, rel), 'utf8')
  } catch {
    continue
  }
  for (const m of src.matchAll(updateRe)) {
    const start = Math.max(0, m.index - 200)
    const end = Math.min(src.length, m.index + 600)
    const ctx = src.slice(start, end)
    if (ctx.includes('CAS-EXEMPT')) continue
    const fullStmt = src.slice(m.index, end)
    if (!guardRe.test(fullStmt)) {
      const line = src.slice(0, m.index).split('\n').length
      console.error(`MISS-CAS-GUARD: ${rel}:${line}`)
      failed++
    }
  }
}
if (failed) {
  console.error(`\n✘ ${failed} 处状态机 UPDATE 缺少 CAS 守卫或 CAS-EXEMPT 注释`)
  process.exit(1)
}
console.log('✔ 全部状态机 UPDATE 已携带 CAS 守卫或 CAS-EXEMPT 注释')
