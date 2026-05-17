#!/usr/bin/env bun
/**
 * 串行跑全部 client L3 journey
 *
 * IDE 单窗口约束：必须先在 IDE 装载 fengyu-client/miniprogram + 自动化端口开启
 * 跑前自检 → 跑全部 j*.spec.mjs → 汇总
 *
 * 用法：
 *   bun fengyu-client/tests/e2e-miniprogram/run-all.mjs
 *   bun fengyu-client/tests/e2e-miniprogram/run-all.mjs --only j1,j2
 *   bun fengyu-client/tests/e2e-miniprogram/run-all.mjs --bail
 */
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const onlyFilter = (() => {
  const i = args.indexOf('--only')
  if (i === -1) return null
  return new Set(args[i + 1].split(',').map(s => s.trim()))
})()
const bail = args.includes('--bail')

async function listJourneys() {
  const entries = await readdir(__dirname)
  return entries.filter(e => /^j\d+-.*\.spec\.mjs$/.test(e)).sort()
}

function runJourney(name) {
  return new Promise((resolve) => {
    const start = Date.now()
    const full = path.join(__dirname, name)
    const proc = spawn('bun', [full], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => out += d.toString())
    proc.stderr.on('data', d => err += d.toString())
    proc.on('close', code => resolve({ name, code, durationMs: Date.now() - start, out, err }))
  })
}

const journeys = await listJourneys()
const filtered = onlyFilter
  ? journeys.filter(j => onlyFilter.has(j.split('-')[0]))
  : journeys

console.log(`[L3 run-all] start | ${filtered.length} journey(s) | ${new Date().toISOString()}`)

const summary = { total: 0, pass: 0, fail: 0, failures: [] }

for (const j of filtered) {
  summary.total++
  process.stdout.write(`  · ${j} ... `)
  const { code, durationMs, out, err } = await runJourney(j)
  if (code === 0) {
    console.log(`PASS (${(durationMs / 1000).toFixed(1)}s)`)
    summary.pass++
  } else {
    console.log(`FAIL (${(durationMs / 1000).toFixed(1)}s, exit=${code})`)
    summary.fail++
    summary.failures.push({ name: j, code, out: out.trim().split('\n').slice(-12).join('\n'), err: err.trim().slice(-300) })
    if (bail) break
  }
}

console.log(`\n[L3 run-all] end | ${summary.pass}/${summary.total} pass | ${summary.fail} fail`)
if (summary.fail > 0) {
  console.log(`\n=== Failures ===`)
  for (const f of summary.failures) {
    console.log(`\n--- ${f.name} (exit ${f.code}) ---`)
    console.log(f.out)
    if (f.err) console.log(`stderr:\n${f.err}`)
  }
}
process.exit(summary.fail ? 1 : 0)
