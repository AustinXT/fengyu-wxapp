#!/usr/bin/env bun
/**
 * 串行跑 scope-isolation 套件全部 scope-*.mjs，汇总结果。
 *
 * 用法：
 *   bun fengyu-staff/tests/scope-isolation/run-all.mjs
 *   bun fengyu-staff/tests/scope-isolation/run-all.mjs --filter s1
 *
 * 与 e2e-cloudfn/run-all.mjs 同模式（自动发现 + 失败保存 log + 整体 exit code）。
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
  ? args[filterIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : []

const allScripts = fs.readdirSync(__dirname)
  .filter((f) => /^scope-.*\.mjs$/.test(f))
  .sort()

const scripts = filters.length === 0
  ? allScripts
  : allScripts.filter((s) => filters.some((f) => s.includes(f)))

if (scripts.length === 0) {
  console.error(`[scope-isolation/run-all] 无匹配 scope-*.mjs。filters=${JSON.stringify(filters)}`)
  process.exit(1)
}

const resultsDir = path.join(__dirname, 'test-results')
fs.mkdirSync(resultsDir, { recursive: true })

function run(script) {
  return new Promise((resolve) => {
    const start = Date.now()
    const buf = []
    const child = spawn(process.execPath, [path.join(__dirname, script)], { env: process.env })
    child.stdout.on('data', (d) => { process.stdout.write(d); buf.push(d.toString()) })
    child.stderr.on('data', (d) => { process.stderr.write(d); buf.push(d.toString()) })
    child.on('exit', (code) => {
      const ms = Date.now() - start
      const out = buf.join('')
      let logPath = null
      if (code !== 0) {
        const tail = out.split('\n').slice(-50).join('\n')
        logPath = path.join(resultsDir, script.replace(/\.mjs$/, '.log'))
        fs.writeFileSync(logPath, tail)
      }
      resolve({ script, code, ms, logPath })
    })
  })
}

const summary = []
let overallFail = 0
for (const s of scripts) {
  console.log(`\n────────── ${s} ──────────`)
  const r = await run(s)
  summary.push(r)
  if (r.code !== 0) overallFail += 1
}

console.log('\n────────── SUMMARY ──────────')
for (const r of summary) {
  const flag = r.code === 0 ? '✅ PASS' : '❌ FAIL'
  console.log(`  ${flag}  ${r.script.padEnd(45)} ${r.ms}ms` + (r.logPath ? `  log=${r.logPath}` : ''))
}
console.log(`\nTotal: ${summary.length}, Fail: ${overallFail}\n`)
process.exit(overallFail > 0 ? 1 : 0)
