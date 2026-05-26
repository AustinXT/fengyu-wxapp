#!/usr/bin/env node
// 渲染 fengyu-{client,staff}/cloudbaserc.json
// 输入：envs/<env>.env + fengyu-X/cloudbaserc.example.json
// 输出：fengyu-X/cloudbaserc.json (gitignored)
//
// Usage: node scripts/render-cloudbaserc.mjs <env>   # env = dev | prod

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const env = process.argv[2]
if (!env || !['dev', 'prod'].includes(env)) {
  console.error('Usage: node render-cloudbaserc.mjs <dev|prod>')
  process.exit(1)
}

const envPath = path.join(ROOT, 'envs', `${env}.env`)
if (!fs.existsSync(envPath)) {
  console.error(`ERROR: ${envPath} not found. Copy from envs/${env}.env.example and fill.`)
  process.exit(1)
}

// --- dotenv 解析（支持引号包多行 PEM）---
function parseDotenv(content) {
  const vars = {}
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 跳过注释和空行
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) {
      i++
      continue
    }
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1)
    // 引号包裹的多行（开始引号在当前行，结束引号在后续行）
    if (val.startsWith('"') && !isClosedQuote(val)) {
      let buf = val.slice(1)
      i++
      while (i < lines.length && !lines[i].endsWith('"')) {
        buf += '\n' + lines[i]
        i++
      }
      if (i < lines.length) {
        buf += '\n' + lines[i].slice(0, -1)  // 去掉结束引号
      }
      val = buf
    } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1)
    }
    vars[key] = val
    i++
  }
  return vars
}

function isClosedQuote(s) {
  // 简化：检测 "...." 闭合（不考虑转义）
  if (!s.startsWith('"')) return true
  return s.length >= 2 && s.endsWith('"')
}

// --- 第二轮：解析 ${VAR} 引用（如 LAKALA_NOTIFY_URL=${CLIENT_SERVICE_URL}/lakala/notify）---
function resolveRefs(vars) {
  const resolved = { ...vars }
  let changed = true
  let safety = 10
  while (changed && safety-- > 0) {
    changed = false
    for (const [k, v] of Object.entries(resolved)) {
      const next = v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
        if (resolved[name] !== undefined) {
          changed = true
          return resolved[name]
        }
        return `\${${name}}`
      })
      if (next !== v) resolved[k] = next
    }
  }
  return resolved
}

// --- 渲染：read cloudbaserc.example.json，遍历替换 ${VAR}，写 cloudbaserc.json ---
function render(side, vars) {
  const tplPath = path.join(ROOT, `fengyu-${side}`, 'cloudbaserc.example.json')
  const outPath = path.join(ROOT, `fengyu-${side}`, 'cloudbaserc.json')

  // 读 JSON → 解析为 object → 递归遍历 → 写回
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'))

  const missing = new Set()
  function walk(node) {
    if (typeof node === 'string') {
      return node.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
        if (vars[name] === undefined) {
          missing.add(name)
          return ''
        }
        return vars[name]
      })
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const k of Object.keys(node)) {
        if (k === '_comment') continue  // 渲染产物不保留 _comment
        out[k] = walk(node[k])
      }
      return out
    }
    return node
  }

  const out = walk(tpl)

  if (missing.size > 0) {
    console.error(`ERROR: rendering fengyu-${side}/cloudbaserc.json — missing vars in envs/${env}.env:`)
    for (const m of [...missing].sort()) console.error(`  - ${m}`)
    process.exit(1)
  }

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`  ✓ fengyu-${side}/cloudbaserc.json`)
}

// --- main ---
const raw = parseDotenv(fs.readFileSync(envPath, 'utf8'))
const vars = resolveRefs(raw)

// 必检字段（缺一项 abort）
const required = ['ENV_PROFILE', 'PG_CONNECTION_STRING', 'CLIENT_ENV_ID', 'STAFF_ENV_ID']
const missing = required.filter((k) => !vars[k])
if (missing.length > 0) {
  console.error(`ERROR: envs/${env}.env missing required vars: ${missing.join(', ')}`)
  process.exit(1)
}

if (vars.ENV_PROFILE !== env) {
  console.error(`ERROR: envs/${env}.env has ENV_PROFILE=${vars.ENV_PROFILE}, expected ${env}`)
  process.exit(1)
}

console.log(`Rendering cloudbaserc.json from envs/${env}.env...`)
render('client', vars)
render('staff', vars)
console.log(`  ✓ done`)
