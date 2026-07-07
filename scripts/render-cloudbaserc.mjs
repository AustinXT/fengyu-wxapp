#!/usr/bin/env node






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


function parseDotenv(content) {
  const vars = {}
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    
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
    
    if (val.startsWith('"') && !isClosedQuote(val)) {
      let buf = val.slice(1)
      i++
      while (i < lines.length && !lines[i].endsWith('"')) {
        buf += '\n' + lines[i]
        i++
      }
      if (i < lines.length) {
        buf += '\n' + lines[i].slice(0, -1)  
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
  
  if (!s.startsWith('"')) return true
  return s.length >= 2 && s.endsWith('"')
}


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


function render(side, vars) {
  const tplPath = path.join(ROOT, `fengyu-${side}`, 'cloudbaserc.example.json')
  const outPath = path.join(ROOT, `fengyu-${side}`, 'cloudbaserc.json')

  
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
        if (k === '_comment') continue  
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


const raw = parseDotenv(fs.readFileSync(envPath, 'utf8'))
const vars = resolveRefs(raw)


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
