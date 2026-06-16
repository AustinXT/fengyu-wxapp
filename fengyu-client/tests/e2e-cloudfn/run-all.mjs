#!/usr/bin/env bun
/**
 * 跑全部 client L2 spec
 *
 * 用法：
 *   bun fengyu-client/tests/e2e-cloudfn/run-all.mjs                    # 全部
 *   bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --module order     # 仅 order/
 *   bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --module auth,card # 多个模块
 *   bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --bail             # 第一个 fail 即停
 *
 * 每个 spec 子进程隔离跑（spawn bun），失败不污染后续；汇总 PASS/FAIL/SKIP。
 */
import { readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const moduleFilter = (() => {
  const i = args.indexOf('--module')
  if (i === -1) return null
  return new Set(args[i + 1].split(',').map(s => s.trim()))
})()
const bail = args.includes('--bail')

// 模块跑序：依赖关系从轻到重（timezone 纯 parser 守护，无库依赖；config/staff 无依赖；order/appointment 依赖商品+顾客+卡）
const MODULE_ORDER = [
  'timezone',
  'config', 'staff', 'store', 'product',
  'auth', 'card', 'coupon', 'points', 'message', 'service',
  'order', 'appointment',
]

async function findSpecs(moduleDir) {
  const full = path.join(__dirname, moduleDir)
  try {
    const entries = await readdir(full)
    const specs = []
    for (const e of entries) {
      if (e.endsWith('.spec.mjs')) specs.push(path.join(full, e))
    }
    return specs.sort()
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

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
      resolve({
        specPath, code, durationMs: Date.now() - start, out, err,
      })
    })
  })
}

const summary = { total: 0, pass: 0, fail: 0, skip: 0, failures: [] }

console.log(`[run-all] start | ${new Date().toISOString()}`)
if (moduleFilter) console.log(`  filter: ${[...moduleFilter].join(', ')}`)

outer:
for (const mod of MODULE_ORDER) {
  if (moduleFilter && !moduleFilter.has(mod)) {
    continue
  }
  const specs = await findSpecs(mod)
  if (specs.length === 0) {
    console.log(`\n[${mod}] (no spec) — SKIP`)
    summary.skip++
    continue
  }
  console.log(`\n[${mod}] ${specs.length} spec(s)`)
  for (const spec of specs) {
    summary.total++
    const rel = path.relative(__dirname, spec)
    process.stdout.write(`  · ${rel} ... `)
    const { code, durationMs, out, err } = await runSpec(spec)
    if (code === 0) {
      // 抓取最后一行 "X passed / Y failed" 总结
      const last = out.trim().split('\n').slice(-2).join(' | ')
      console.log(`PASS (${durationMs}ms) ${last.includes('passed') ? `[${last.match(/(\d+) passed/)?.[1] ?? '?'} cases]` : ''}`)
      summary.pass++
    } else {
      console.log(`FAIL (${durationMs}ms, exit=${code})`)
      summary.fail++
      summary.failures.push({ rel, code, out: out.trim().split('\n').slice(-8).join('\n'), err: err.trim().slice(-300) })
      if (bail) break outer
    }
  }
}

console.log(`\n[run-all] end | ${summary.pass}/${summary.total} pass | ${summary.fail} fail | ${summary.skip} module skip`)
if (summary.fail > 0) {
  console.log(`\n=== Failures ===`)
  for (const f of summary.failures) {
    console.log(`\n--- ${f.rel} (exit ${f.code}) ---`)
    console.log(f.out)
    if (f.err) console.log(`stderr:\n${f.err}`)
  }
}
process.exit(summary.fail ? 1 : 0)
