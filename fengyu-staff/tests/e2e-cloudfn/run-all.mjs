#!/usr/bin/env bun
/**
 * 顺序运行全部 smoke 脚本，汇总结果。
 *
 * 用法：
 *   bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs
 *   bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter order        # 仅 smoke-order-*
 *   bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter alloc,service # 多个关键字 OR
 *
 * 任一 smoke FAIL 整体 exit code = 1。
 * 失败时把最后 50 行 stdout 缓存到 test-results/<smoke>.log，summary 末尾打印路径。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const args = process.argv.slice(2)
const filterIdx = args.indexOf('--filter')
const filters = filterIdx >= 0 && args[filterIdx + 1]
  ? args[filterIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : []

// 自动发现 smoke-*.mjs（排除 .impl. 这种内部 wrapper 文件）
const allSmokes = fs.readdirSync(__dirname)
  .filter(f => /^smoke-.*\.mjs$/.test(f) && !f.includes('.impl.'))
  .sort()

const scripts = filters.length === 0
  ? allSmokes
  : allSmokes.filter(s => filters.some(f => s.includes(f)))

if (scripts.length === 0) {
  console.error(`[run-all] 无匹配 smoke。filters=${JSON.stringify(filters)}`)
  process.exit(1)
}

const resultsDir = path.join(__dirname, 'test-results')
fs.mkdirSync(resultsDir, { recursive: true })

function run(script) {
  return new Promise((resolve) => {
    const start = Date.now()
    const buf = []
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      env: process.env,
    })
    child.stdout.on('data', d => { process.stdout.write(d); buf.push(d.toString()) })
    child.stderr.on('data', d => { process.stderr.write(d); buf.push(d.toString()) })
    child.on('exit', (code) => {
      const out = buf.join('')
      let logPath = null
      if (code !== 0) {
        const tail = out.split('\n').slice(-50).join('\n')
        logPath = path.join(resultsDir, script.replace(/\.mjs$/, '.log'))
        fs.writeFileSync(logPath, tail)
      }
      resolve({ script, code: code ?? 1, elapsedMs: Date.now() - start, logPath })
    })
  })
}

const results = []
for (let i = 0; i < scripts.length; i++) {
  const s = scripts[i]
  console.log(`\n=== ${s} ===`)
  const r = await run(s)
  results.push(r)
  // 间隔 1500ms 让 PG 连接池完全释放，避免快速 spawn 下偶发的 auth 状态竞态
  if (i < scripts.length - 1) await new Promise(r => setTimeout(r, 1500))
}

console.log('\n=== summary ===')
let passed = 0, failed = 0
for (const r of results) {
  const tag = r.code === 0 ? 'PASS' : 'FAIL'
  console.log(`  ${tag.padEnd(4)}  ${r.script.padEnd(38)} ${(r.elapsedMs / 1000).toFixed(2)}s`)
  if (r.code === 0) passed++; else failed++
}
console.log(
  `\n${failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILED`} | ${passed} pass / ${results.length} total | ` +
  `${(results.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`
)

if (failed > 0) {
  console.log(`\n失败日志（末尾 50 行）：`)
  for (const r of results.filter(r => r.code !== 0)) {
    console.log(`  ${r.script} → ${r.logPath}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
