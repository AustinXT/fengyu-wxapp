#!/usr/bin/env bun
/**
 * 跑全部 cross-end (TE2X) spec
 *
 * 用法：
 *   bun fengyu-client/tests/e2e-cross-end/run-all.mjs
 *   bun fengyu-client/tests/e2e-cross-end/run-all.mjs --bail
 *
 * 子进程隔离，单 spec 失败不影响后续；汇总 PASS/FAIL。
 *
 * 跑序按依赖关系从轻到重：
 *   1. hmac-bridge       — 纯 clientApi HTTP 入口，最轻
 *   2. coupon-admin-issue — admin 端用 pgQuery 模拟写入，client 端真调
 *   3. legacy-orders-visibility — pgQuery 模拟历史订单导入
 *   4. scan-pay-real     — staff+client 跨端最完整链路
 *   5. smoke-paynotify   — payNotify 守卫态验证
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const bail = args.includes('--bail')

const SPECS = [
  'hmac-bridge.spec.mjs',
  'coupon-admin-issue.spec.mjs',
  'legacy-orders-visibility.spec.mjs',
  'scan-pay-real.spec.mjs',
  'smoke-paynotify.spec.mjs',
]

function runSpec(specPath) {
  return new Promise((resolve) => {
    const start = Date.now()
    const proc = spawn('bun', [specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d.toString() })
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('close', (code) => {
      resolve({ specPath, code, durationMs: Date.now() - start, out, err })
    })
  })
}

const summary = { total: 0, pass: 0, fail: 0, failures: [] }
console.log(`[cross-end/run-all] start | ${new Date().toISOString()}`)

for (const spec of SPECS) {
  summary.total++
  const full = path.join(__dirname, spec)
  process.stdout.write(`  · ${spec} ... `)
  const { code, durationMs, out, err } = await runSpec(full)
  if (code === 0) {
    const last = out.trim().split('\n').slice(-2).join(' | ')
    const cases = last.match(/(\d+) passed/)?.[1]
    console.log(`PASS (${durationMs}ms)${cases ? ` [${cases} cases]` : ''}`)
    summary.pass++
  } else {
    console.log(`FAIL (${durationMs}ms, exit=${code})`)
    summary.fail++
    summary.failures.push({
      spec, code,
      out: out.trim().split('\n').slice(-12).join('\n'),
      err: err.trim().slice(-300),
    })
    if (bail) break
  }
}

console.log(`\n[cross-end/run-all] end | ${summary.pass}/${summary.total} pass | ${summary.fail} fail`)
if (summary.fail > 0) {
  console.log(`\n=== Failures ===`)
  for (const f of summary.failures) {
    console.log(`\n--- ${f.spec} (exit ${f.code}) ---`)
    console.log(f.out)
    if (f.err) console.log(`stderr:\n${f.err}`)
  }
}
process.exit(summary.fail ? 1 : 0)
