#!/usr/bin/env node
// pack-delivery.mjs — 把 prod 分支文件树加固后打包成交付 zip。
//
// 全部加固在 delivery-staging/ 副本上进行，绝不改动源码树。
// 约束：不混淆代码（不做标识符重命名 / minify 标识符）。
//
// 加固项：
//   1. 复制 prod 树到 staging（排除 node_modules/.git/.next/.claude/.agents/知识目录/锁文件等）
//      ※ 部署 admin 必需资产(.claude/skills/remote-deploy skill / fengyu-admin/bun.lock / db lockfile)走白名单放行；
//        envs/ 下只保留 *.example，排除真值与密钥(防部署 worktree 的 envs/prod.env 泄露)
//   2. 删架构泄露资产（DEPLOY.md / db 修复脚本 / typings / drizzle snapshot / 测试）
//   3. 关小程序 sourcemap 上传（uploadWithSourceMap=false）
//   4. 泛化 package.json（description 置空、移除 repository/bugs/homepage 源码仓 URL）
//   5. 安全正则剥离 WXML/WXSS/SQL/SH 注释（注释语法无歧义）
//   6. 扫描 JS/TS 残留注释（仅报告，见下）+ 凭据扫描兜底（命中即中止）
//   7. 打包 zip
//
// ⚠ JS/TS 注释剥离需 AST 解析器（正则无法安全处理字符串/正则字面量，会破坏代码）。
//   prod 源码已由提交 71cfc7f4 的 AST 过程剥净注释。本脚本对 JS/TS 仅扫描报告残留：
//   若 `git merge main` 把原始注释带回来，脚本会列出这些文件并提示用 AST 工具重剥，
//   再重新打包。绝不在无解析器时用正则盲剥 JS/TS。

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.cwd()  // 须在 prod 根运行（位置无关；原 __dirname/.. 在 scripts/ 移到 skill 后失效）
if (!fs.existsSync(path.join(ROOT, 'fengyu-client'))) {
  console.error('✗ pack-delivery.mjs 须在 prod 根运行（找不到 fengyu-client/）'); process.exit(1)
}
const STAGING = path.join(ROOT, 'delivery-staging');

// ---------- 配置 ----------
const EXCLUDE_TOP = new Set([
  'node_modules', '.git', '.next', '.tree', 'coverage',
  'delivery', 'delivery-staging', 'reports',
  '.claude', '.agents', '.42cog', 'docs', 'notes', 'scripts',
]);

const EXCLUDE_FILES = new Set([
  'bun.lock', 'package-lock.json', 'yarn.lock',
  'DEPLOY.md', 'CLAUDE.md', '.gitleaks.toml',
])

// 部署 admin 必需、但被上面 EXCLUDE 规则挡住的文件/目录（allowed() 白名单放行）：
//   - .claude/skills/remote-deploy/：部署 skill(deploy-admin.sh + SKILL.md)，.claude 被 EXCLUDE_TOP 排除
//   - fengyu-admin/bun.lock：Dockerfile `bun install --frozen-lockfile` 必需
//   - db/{bun.lock,package-lock.json}：deploy-admin.sh 迁移预检 `cd db && npm run db:migrate` 依赖
const DEPLOY_REQUIRED_FILES = new Set([
  'fengyu-admin/bun.lock',
  'db/bun.lock',
  'db/package-lock.json',
])
const DEPLOY_REQUIRED_DIRS = ['.claude/skills/remote-deploy']

// 复制后从 staging 删除的架构泄露脚本（保留 bootstrap-from-zero.sh 供首建库）
const DELETE_REL = [
  'db/scripts/sync-workfine.js',
  'db/scripts/reset-drizzle-journal.js',
  'db/scripts/verify-db.sh',
]

// 删除的目录名（出现在任意层级）
const DELETE_DIR_NAMES = new Set(['typings', '__tests__', 'e2e', 'mock'])

// 已知真实凭据/端点模式 —— 命中即中止打包（防 merge 把真值带回）。
// 注意：CloudBase envId / CDN 域名是小程序客户端 SDK init 必需的公开常量（编译产物里就有），
// 不作为秘密扫描；此处只扫真正的口令/密钥/商户终端号等。
const CREDENTIAL_PATTERNS = [
  /fengyu123/i,
  /Se[14]Qimoh/,
  /47\.96\.87\.33/,
  /47\.113\.202\.7/,
  /822290059430BFA/,
  /D9261078/,
  /uIj6CPg1GZAY10dXFfsEAQ/,
  /OP00000003/,
  /00dfba8194c41b84cf/,
]

const JS_TS_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

// ---------- 工具 ----------
function walkFiles(dir, cb) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, cb)
    else if (e.isFile()) cb(full)
  }
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }

function readVersion() {
  try {
    const ts = fs.readFileSync(path.join(ROOT, 'fengyu-client/miniprogram/utils/version.ts'), 'utf8')
    const m = ts.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
    if (m) return m[1]
  } catch {}
  try { return execSync('git describe --tags --abbrev=0', { cwd: ROOT }).toString().trim() } catch {}
  return 'snapshot'
}

// ---------- 加固函数 ----------
function allowed(rel, base, isDir) {
  const parts = rel.split(path.sep)
  // 部署 admin 必需文件/目录白名单（覆盖下方 EXCLUDE_TOP .claude / EXCLUDE_FILES lockfile）
  //   目录若是白名单祖先(.claude / .claude/skills)也放行进入遍历，内部再由本规则精确过滤；
  //   release-all 等同目录其他 skill 不被命中 → 仍被 EXCLUDE_TOP '.claude' 排除
  if (DEPLOY_REQUIRED_DIRS.some((d) => rel === d || rel.startsWith(d + '/') || (isDir && d.startsWith(rel + '/')))) return true
  if (!isDir && DEPLOY_REQUIRED_FILES.has(rel)) return true
  // envs/ 下只放行 *.example：排除真值(prod.env/dev.env/.active)与密钥(*.pem/*.cer)
  if (parts[0] === 'envs' && !isDir && !base.endsWith('.example')) return false
  if (EXCLUDE_TOP.has(parts[0])) return false
  if (EXCLUDE_FILES.has(base)) return false
  if (!isDir && /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(base)) return false
  if (parts.some((p) => DELETE_DIR_NAMES.has(p))) return false
  if (!isDir && (base === '.DS_Store' || base.endsWith('.log'))) return false
  if (!isDir && /^fengyu-delivery-.*\.zip$/.test(base)) return false
  return true
}

function copyTree() {
  rm(STAGING)
  fs.mkdirSync(STAGING, { recursive: true })
  const copyDir = (srcDir) => {
    let entries
    try { entries = fs.readdirSync(srcDir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const src = path.join(srcDir, e.name)
      const rel = path.relative(ROOT, src)
      const base = e.name
      if (!allowed(rel, base, e.isDirectory())) continue
      if (e.isDirectory()) copyDir(src)
      else if (e.isFile()) {
        const dest = path.join(STAGING, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
    }
  }
  copyDir(ROOT)
}

function deleteAssets() {
  for (const rel of DELETE_REL) rm(path.join(STAGING, rel))
  // drizzle snapshot（保留 _journal.json）
  const metaDir = path.join(STAGING, 'db/migrations/meta')
  if (fs.existsSync(metaDir)) {
    for (const f of fs.readdirSync(metaDir)) {
      if (f.endsWith('_snapshot.json')) rm(path.join(metaDir, f))
    }
  }
  // 任意层级 typings / __tests__ / e2e / mock 目录
  walkFiles(STAGING, () => {})
  const stack = [STAGING]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory() && DELETE_DIR_NAMES.has(e.name)) rm(path.join(d, e.name))
      else if (e.isDirectory()) stack.push(path.join(d, e.name))
    }
  }
}

function disableSourcemap() {
  for (const mp of ['fengyu-client/miniprogram', 'fengyu-staff/miniprogram']) {
    const p = path.join(STAGING, mp, 'project.config.json')
    if (!fs.existsSync(p)) continue
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (j.setting) j.setting.uploadWithSourceMap = false
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  }
}

function cleanPackageJson(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  if ('description' in j) j.description = ''
  delete j.repository
  delete j.bugs
  delete j.homepage
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
}

function generalizePackages() {
  walkFiles(STAGING, (full) => {
    if (path.basename(full) === 'package.json') cleanPackageJson(full)
  })
  // project.config.json 的 description 也置空
  for (const mp of ['fengyu-client/miniprogram', 'fengyu-staff/miniprogram']) {
    const p = path.join(STAGING, mp, 'project.config.json')
    if (!fs.existsSync(p)) continue
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if ('description' in j) j.description = ''
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  }
}

// 安全正则剥离（注释语法无歧义的文件类型）
function stripLineComments(src, prefix) {
  const out = []
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(prefix)) {
      // 保留 shebang / eslint-disable / statement-breakpoint / ts 指令
      if (/eslint-disable|statement-breakpoint|@ts-ignore|@ts-expect-error|@ts-nocheck/.test(line)) out.push(line)
      else out.push('') // 抹掉注释内容，保留行号
    } else out.push(line)
  }
  return out.join('\n')
}

function stripSafeComments() {
  let n = 0
  walkFiles(STAGING, (full) => {
    const rel = path.relative(STAGING, full)
    // deploy-admin.sh 的注释是部署操作说明（RSA 配置/迁移预检/回滚步骤），有文档价值，保留
    if (rel === '.claude/skills/remote-deploy/deploy-admin.sh') return
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
      // 保留 shebang
      const lines = src.split(/\r?\n/)
      out = lines.map((line, i) => {
        if (i === 0 && line.startsWith('#!')) return line
        if (line.trimStart().startsWith('#')) {
          if (/eslint-disable|statement-breakpoint/.test(line)) return line
          return ''
        }
        return line
      }).join('\n')
    } else return
    if (out !== src) { fs.writeFileSync(full, out); n++ }
  })
  return n
}

// 扫描 JS/TS 残留注释（行首注释为信号，仅报告）
function scanJsTsComments() {
  const hits = []
  walkFiles(STAGING, (full) => {
    if (!JS_TS_EXT.test(full)) return
    const rel = path.relative(STAGING, full)
    if (rel.includes(`${path.sep}scripts${path.sep}`)) return
    let src
    try { src = fs.readFileSync(full, 'utf8') } catch { return }
    const lines = src.split(/\r?\n/)
    let count = 0
    for (const line of lines) {
      const t = line.trimStart()
      if (!(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))) continue
      if (/eslint-disable|statement-breakpoint|@ts-ignore|@ts-expect-error|@ts-nocheck/.test(t)) continue
      count++
    }
    if (count > 0) hits.push({ rel, count })
  })
  return hits
}

function credentialScan() {
  const hits = []
  walkFiles(STAGING, (full) => {
    let src
    try { src = fs.readFileSync(full, 'utf8') } catch { return }
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(src)) { hits.push({ rel: path.relative(STAGING, full), re: re.source }); break }
    }
  })
  return hits
}

function dirStat(dir) {
  let files = 0, bytes = 0
  walkFiles(dir, (f) => { files++; bytes += fs.statSync(f).size })
  return { files, mb: (bytes / 1024 / 1024).toFixed(2) }
}

function makeZip(version) {
  const out = path.join(ROOT, `fengyu-delivery-${version}.zip`)
  rm(out)
  execSync(`zip -r -q "${out}" .`, { cwd: STAGING, stdio: 'inherit' })
  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(2)
  return { out, size }
}

// ---------- 主流程 ----------
const version = readVersion()
console.log(`\n🚀 pack-delivery · version=${version}\n`)

console.log('1/7 复制 prod 树到 staging（排除依赖/知识目录/锁文件）...')
copyTree()

console.log('2/7 删架构泄露资产（DEPLOY.md / db 修复脚本 / typings / drizzle snapshot / 测试）...')
deleteAssets()

console.log('3/7 关小程序 sourcemap 上传 ...')
disableSourcemap()

console.log('4/7 泛化 package.json / project.config.json description + 移除源码仓 URL ...')
generalizePackages()

console.log('5/7 安全剥离 WXML/WXSS/SQL/SH 注释 ...')
const stripped = stripSafeComments()
console.log(`   ✓ 处理 ${stripped} 个文件`)

console.log('6a 扫描 JS/TS 残留注释（仅报告）...')
const jsHits = scanJsTsComments()
if (jsHits.length === 0) {
  console.log('   ✓ JS/TS 无残留注释（71cfc7f4 AST 口径仍干净）')
} else {
  const total = jsHits.reduce((a, b) => a + b.count, 0)
  console.log(`   ⚠ ${jsHits.length} 个 JS/TS 文件含约 ${total} 处疑似注释（可能 merge 带回）：`)
  for (const h of jsHits.slice(0, 20)) console.log(`     - ${h.rel} (${h.count})`)
  console.log('   → 请用 AST 工具（如 npx strip-comments / babel）重剥后再打包；本脚本不盲剥 JS/TS。')
}

console.log('6b 凭据扫描兜底 ...')
const credHits = credentialScan()
if (credHits.length > 0) {
  console.error(`\n❌ 中止：检测到真实凭据/端点残留，请先中和再打包：`)
  for (const h of credHits) console.error(`   - ${h.rel}  匹配 /${h.re}/`)
  console.error('   （这些值通常在 .env.example / db 脚本里；merge main 后需重新中和）')
  process.exit(1)
}
console.log('   ✓ 无已知凭据残留')

console.log('7/7 打包 zip ...')
const { out, size } = makeZip(version)
const stat = dirStat(STAGING)
console.log(`\n${'═'.repeat(56)}`)
console.log(`  ✅ 交付包已生成`)
console.log(`${'═'.repeat(56)}`)
console.log(`  版本      : ${version}`)
console.log(`  文件数    : ${stat.files}`)
console.log(`  解压大小  : ${stat.mb} MB`)
console.log(`  zip       : ${out} (${size} MB)`)
console.log(`  staging   : ${STAGING}（可抽检后删除）`)
console.log(`${'═'.repeat(56)}\n`)
