#!/usr/bin/env node
// strip-comments.mjs — 剥净 prod 源码树全部注释。
//
//   JS/TS：@babel/parser AST 按注释字符位置删（代码字符零改动，绝不正则盲剥——
//          正则会破坏字符串/正则字面量里的 // 和 /*）
//   WXML/WXSS/CSS/SQL/SH：正则剥（注释语法无歧义，安全）
//
// 白名单保留：shebang / eslint-disable / statement-breakpoint /
//             @ts-ignore / @ts-expect-error / @ts-nocheck
// 豁免：.claude/skills/remote-deploy/deploy-admin.sh（部署操作说明，有文档价值）
//
// 口径与 pack-delivery.mjs 的 stripSafeComments / stripLineComments 完全一致
// （源码清洗 vs 副本兜底不漂移——漂移会让 pack-delivery 的 JS/TS 残留扫描失真）。
//
// 用法：node strip-comments.mjs [prod-root]   （默认 process.cwd()，须在 prod 根运行）

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const scriptDir = path.dirname(new URL(import.meta.url).pathname)
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()

if (!fs.existsSync(path.join(ROOT, 'fengyu-client'))) {
  console.error(`✗ 须在 prod 根运行（找不到 ${path.join(ROOT, 'fengyu-client')}/）。可传参：strip-comments.mjs <prod-root>`)
  process.exit(1)
}

// @babel/parser 自举：缺失则在 skill scripts/ 目录 npm install
const req = createRequire(import.meta.url)
let parse
try {
  parse = req('@babel/parser').parse
} catch {
  console.error('⚠ 未找到 @babel/parser，正在安装到 skill scripts/ ...')
  execSync('npm install', { cwd: scriptDir, stdio: 'inherit' })
  parse = req('@babel/parser').parse
}

// 白名单（与 pack-delivery.mjs 一致）
const KEEP = /eslint-disable|statement-breakpoint|@ts-ignore|@ts-expect-error|@ts-nocheck/
const AST_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

// 任意层级跳过的目录
const EXCLUDE_DIR = new Set([
  'node_modules', '.git', '.next', '.tree', 'dist', '.turbo',
  'delivery', 'delivery-staging', 'reports',
  '.agents', '.42cog', '.codex',
  'docs', 'notes', 'sources',
  '__tests__', 'e2e', 'mock', 'typings',
])
// 仅顶层跳过（pack-delivery.mjs EXCLUDE_TOP 同口径：顶层打包/部署工具与 skill 自身）
const EXCLUDE_TOP = new Set(['scripts', '.claude'])

const REMOTE_DEPLOY_SH = path.join('.claude', 'skills', 'remote-deploy', 'deploy-admin.sh')

let astFiles = 0, astComments = 0, astSkipped = 0
let regexFiles = 0

const relOf = (full) => path.relative(ROOT, full)

// ---------- AST 剥 JS/TS ----------
function stripAst(full) {
  const src = fs.readFileSync(full, 'utf8')
  let ast
  try {
    ast = parse(src, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'objectRestSpread', 'dynamicImport', 'exportDefaultFrom', 'optionalChaining', 'nullishCoalescing', 'asyncGenerators', 'importMeta', 'topLevelAwait'],
      errorRecovery: true,
    })
  } catch (e) {
    astSkipped++
    console.error(`  skip(unparseable): ${relOf(full)} — ${String(e.message).split('\n')[0]}`)
    return
  }
  const comments = ast.comments || []
  if (comments.length === 0) return
  const ranges = []
  for (const c of comments) {
    if (KEEP.test(c.value)) continue
    ranges.push([c.start, c.end])
  }
  if (ranges.length === 0) return
  ranges.sort((a, b) => b[0] - a[0]) // 倒序删（避免位置偏移）
  let out = src
  for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(e)
  if (out !== src) {
    fs.writeFileSync(full, out)
    astFiles++
    astComments += ranges.length
  }
}

// ---------- 正则剥（移植 pack-delivery.mjs stripLineComments）----------
function stripLineComments(src, prefix) {
  const out = []
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(prefix)) {
      if (/eslint-disable|statement-breakpoint|@ts-ignore|@ts-expect-error|@ts-nocheck/.test(line)) out.push(line)
      else out.push('') // 抹掉注释内容，保留行号
    } else out.push(line)
  }
  return out.join('\n')
}

function stripRegex(full) {
  const rel = relOf(full)
  // 豁免 deploy-admin.sh（部署操作说明：RSA 配置/迁移预检/回滚步骤，有文档价值）
  if (rel === REMOTE_DEPLOY_SH) return
  const ext = path.extname(full)
  let src
  try { src = fs.readFileSync(full, 'utf8') } catch { return }
  let out = src
  if (ext === '.wxml') {
    out = src.replace(/<!--[\s\S]*?-->/g, '')
  } else if (ext === '.wxss' || ext === '.css') {
    out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  } else if (ext === '.sql') {
    out = stripLineComments(src, '--')
  } else if (ext === '.sh') {
    out = src.split(/\r?\n/).map((line, i) => {
      if (i === 0 && line.startsWith('#!')) return line // 保留 shebang
      if (line.trimStart().startsWith('#')) {
        if (/eslint-disable|statement-breakpoint/.test(line)) return line
        return ''
      }
      return line
    }).join('\n')
  } else return
  if (out !== src) { fs.writeFileSync(full, out); regexFiles++ }
}

// ---------- walk ----------
function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  const isTop = dir === ROOT
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name)) continue
      if (isTop && EXCLUDE_TOP.has(e.name)) continue
      walk(path.join(dir, e.name))
    } else if (e.isFile()) {
      const base = e.name
      if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(base)) continue
      const full = path.join(dir, base)
      if (AST_EXT.test(base)) stripAst(full)
      else stripRegex(full)
    }
  }
}

console.log(`\n🧹 strip-comments · ROOT=${ROOT}\n`)
walk(ROOT)
console.log(`  ✓ AST 剥除 ${astFiles} 个 JS/TS 文件 / ${astComments} 处注释${astSkipped ? `（跳过 ${astSkipped} 个无法解析）` : ''}`)
console.log(`  ✓ 正则剥除 ${regexFiles} 个 WXML/WXSS/CSS/SQL/SH 文件`)
console.log(`\n  下一步：git diff --stat 抽检改动范围，node --check 关键文件，确认无误后 /smart-commit。\n`)
