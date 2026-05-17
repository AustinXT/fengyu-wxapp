#!/usr/bin/env bun
/**
 * 顺序运行所有 smoke 脚本，汇总结果。
 * 任一 smoke FAIL 整体 exit code = 1。
 *
 * 用法：bun tests/e2e-cloudfn/run-all.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const scripts = [
  'smoke-confirm-offline.mjs',
  'smoke-paynotify.mjs',
  'smoke-record-payment.mjs',
]

function run(script) {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => {
      resolve({ script, code: code ?? 1, elapsedMs: Date.now() - start })
    })
  })
}

const results = []
for (const s of scripts) {
  console.log(`\n=== ${s} ===`)
  const r = await run(s)
  results.push(r)
}

console.log('\n=== summary ===')
let failed = 0
for (const r of results) {
  const tag = r.code === 0 ? 'PASS' : 'FAIL'
  console.log(`  ${tag.padEnd(4)}  ${r.script.padEnd(30)} ${(r.elapsedMs / 1000).toFixed(2)}s`)
  if (r.code !== 0) failed++
}
console.log(`\n${failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILED`} | ${results.length} scripts | total ${(results.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`)
process.exit(failed === 0 ? 0 : 1)
