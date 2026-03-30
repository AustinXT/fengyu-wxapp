#!/usr/bin/env node

/**
 * 交付构建脚本 — 混淆代码 + 剥离 AI 上下文
 *
 * 用法: node scripts/build-delivery.js
 * 产出: delivery/ 目录
 */

const path = require('path')
const fs = require('fs-extra')
const { execSync } = require('child_process')
const webpack = require('webpack')
const JavaScriptObfuscator = require('javascript-obfuscator')

// ── 路径常量 ──────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..')
const DELIVERY = path.join(ROOT, 'delivery')

const CLOUD_FUNCTIONS = [
  {
    name: 'clientApi',
    src: path.join(ROOT, 'fengyu-client/cloudfunctions/clientApi'),
    dest: path.join(DELIVERY, 'fengyu-client/cloudfunctions/clientApi'),
    externals: ['pg', 'wx-server-sdk'],
  },
  {
    name: 'staffApi',
    src: path.join(ROOT, 'fengyu-staff/cloudfunctions/staffApi'),
    dest: path.join(DELIVERY, 'fengyu-staff/cloudfunctions/staffApi'),
    externals: ['pg', 'mssql', 'wx-server-sdk'],
  },
]

const MINI_PROGRAMS = [
  {
    name: 'fengyu-client',
    // 小程序源码目录
    mpSrc: path.join(ROOT, 'fengyu-client/miniprogram'),
    mpDest: path.join(DELIVERY, 'fengyu-client/miniprogram'),
    // 额外需要复制的文件（相对于子项目根目录）
    extraFiles: [
      { src: path.join(ROOT, 'fengyu-client/project.config.json'), dest: path.join(DELIVERY, 'fengyu-client/project.config.json') },
      { src: path.join(ROOT, 'fengyu-client/sitemap.json'), dest: path.join(DELIVERY, 'fengyu-client/sitemap.json') },
    ],
  },
  {
    name: 'fengyu-staff',
    mpSrc: path.join(ROOT, 'fengyu-staff/miniprogram'),
    mpDest: path.join(DELIVERY, 'fengyu-staff/miniprogram'),
    // staff 的 project.config.json 在 miniprogram/ 内，会被整体复制
    extraFiles: [],
  },
]

// ── 混淆配置 ──────────────────────────────────────────────

/** 云函数 — 重度混淆 */
const OBFUSCATE_HEAVY = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  target: 'node',
  // 不启用 debugProtection（云函数无 DevTools，白耗资源）
  debugProtection: false,
  // 不启用 splitStrings（AI 可拼回，收益低）
  splitStrings: false,
  // 保留 console（云函数日志需要）
  disableConsoleOutput: false,
}

/** 小程序 — 轻量混淆（受包体积限制） */
const OBFUSCATE_LIGHT = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  target: 'browser-no-eval',
  debugProtection: false,
  splitStrings: false,
  disableConsoleOutput: false,
  reservedNames: [
    'Page', 'Component', 'App', 'getApp', 'getCurrentPages',
    'wx', 'require', 'module', 'exports', 'Behavior',
  ],
}

// ── 全局排除列表（复制时跳过） ─────────────────────────────

const GLOBAL_EXCLUDE_DIRS = new Set([
  'node_modules', '__tests__', 'e2e', 'mock', 'coverage',
  '.claude', '.42cog', 'docs', 'notes', '.git',
  'playwright-report', 'test-results',
])

const GLOBAL_EXCLUDE_FILES = new Set([
  'CLAUDE.md', 'README.md', '.gitignore', '.claudeignore',
  'vitest.config.js', 'vitest.config.ts',
  'playwright.config.ts', 'jest.config.js',
  '.env', '.env.local', '.env.example',
  'test_cases.json',
])

// ── 工具函数 ──────────────────────────────────────────────

function shouldExclude(name, isDir) {
  if (isDir) return GLOBAL_EXCLUDE_DIRS.has(name)
  if (GLOBAL_EXCLUDE_FILES.has(name)) return true
  if (name.endsWith('.test.ts') || name.endsWith('.test.js')) return true
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.js')) return true
  return false
}

/** 递归复制，排除不需要的文件 */
function copyFiltered(src, dest) {
  fs.copySync(src, dest, {
    filter: (srcPath) => {
      const name = path.basename(srcPath)
      if (srcPath === src) return true // 根目录自身
      const stat = fs.statSync(srcPath)
      return !shouldExclude(name, stat.isDirectory())
    },
  })
}

/** 精简 package.json — 只保留运行时信息 */
function cleanPackageJson(pkgPath) {
  const pkg = fs.readJsonSync(pkgPath)
  const cleaned = {
    name: pkg.name,
    version: pkg.version || '1.0.0',
    main: pkg.main || 'index.js',
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    cleaned.dependencies = pkg.dependencies
  }
  fs.writeJsonSync(pkgPath, cleaned, { spaces: 2 })
}

/** 混淆单个 JS 文件 */
function obfuscateFile(filePath, options) {
  const code = fs.readFileSync(filePath, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(code, options)
  fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8')
}

/** 递归混淆目录下所有 JS 文件 */
function obfuscateDir(dir, options, skipDirs = []) {
  const skipSet = new Set(skipDirs)
  let count = 0

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (!skipSet.has(entry.name)) walk(full)
      } else if (entry.name.endsWith('.js')) {
        obfuscateFile(full, options)
        count++
      }
    }
  }

  walk(dir)
  return count
}

/** 递归删除匹配的文件 */
function removeByExtension(dir, ext) {
  let count = 0
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(ext)) {
        fs.removeSync(full)
        count++
      }
    }
  }
  walk(dir)
  return count
}

/** 获取目录大小（MB） */
function getDirSize(dir) {
  let total = 0
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += fs.statSync(full).size
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return (total / 1024 / 1024).toFixed(2)
}

/** 统计文件数 */
function countFiles(dir) {
  let count = 0
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else count++
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return count
}

// ── Phase 1: 云函数 ──────────────────────────────────────

function buildCloudFunction(cfg) {
  return new Promise((resolve, reject) => {
    console.log(`\n📦 [${cfg.name}] Webpack 打包...`)

    const webpackConfig = {
      mode: 'production',
      target: 'node',
      entry: path.join(cfg.src, 'index.js'),
      output: {
        path: cfg.dest,
        filename: 'index.js',
        libraryTarget: 'commonjs2',
      },
      externals: cfg.externals.reduce((acc, mod) => {
        acc[mod] = `commonjs ${mod}`
        return acc
      }, {}),
      // 关闭代码分割，确保输出单文件
      optimization: {
        splitChunks: false,
        minimize: false, // 由 javascript-obfuscator 处理
      },
      // 忽略 webpack 对动态 require 的警告
      module: {
        exprContextCritical: false,
      },
    }

    webpack(webpackConfig, (err, stats) => {
      if (err) return reject(err)
      if (stats.hasErrors()) {
        const info = stats.toJson()
        return reject(new Error(info.errors.map(e => e.message).join('\n')))
      }
      console.log(`  ✓ 打包完成`)

      // 混淆
      console.log(`  🔒 混淆中...`)
      obfuscateFile(path.join(cfg.dest, 'index.js'), OBFUSCATE_HEAVY)
      console.log(`  ✓ 混淆完成`)

      // 生成精简 package.json
      const srcPkg = fs.readJsonSync(path.join(cfg.src, 'package.json'))
      const destPkg = {
        name: srcPkg.name,
        version: srcPkg.version || '1.0.0',
        main: 'index.js',
        dependencies: {},
      }
      for (const mod of cfg.externals) {
        if (srcPkg.dependencies && srcPkg.dependencies[mod]) {
          destPkg.dependencies[mod] = srcPkg.dependencies[mod]
        }
      }
      fs.writeJsonSync(path.join(cfg.dest, 'package.json'), destPkg, { spaces: 2 })
      console.log(`  ✓ package.json 已精简`)

      resolve()
    })
  })
}

// ── Phase 2: 小程序前端 ─────────────────────────────────

function buildMiniProgram(cfg) {
  console.log(`\n📱 [${cfg.name}] 构建小程序...`)

  // 2a. 复制源文件
  console.log(`  📋 复制文件（排除测试/文档）...`)
  copyFiltered(cfg.mpSrc, cfg.mpDest)

  // 复制额外文件
  for (const f of cfg.extraFiles) {
    if (fs.existsSync(f.src)) {
      fs.copySync(f.src, f.dest)
    }
  }

  // 2b. 确保 node_modules 中有 typescript（用于编译）
  // 使用源目录的 tsc 来编译交付目录的代码
  const tscBin = path.join(cfg.mpSrc, 'node_modules/.bin/tsc')
  const tsconfig = path.join(cfg.mpDest, 'tsconfig.json')

  if (fs.existsSync(tsconfig) && fs.existsSync(tscBin)) {
    console.log(`  🔧 TypeScript 编译...`)

    // 需要临时复制 node_modules 中的类型定义，tsc 才能编译
    // 修改 tsconfig 指向源目录的 node_modules
    const tsconfigContent = fs.readJsonSync(tsconfig)
    const originalTypeRoots = tsconfigContent.compilerOptions.typeRoots
    tsconfigContent.compilerOptions.typeRoots = (originalTypeRoots || []).map(r => {
      // 相对路径转为指向源目录
      if (r.startsWith('./node_modules') || r.startsWith('node_modules')) {
        return path.join(cfg.mpSrc, r.replace(/^\.\//, ''))
      }
      // typings 目录已在 dest 中
      return r
    })
    fs.writeJsonSync(tsconfig, tsconfigContent, { spaces: 2 })

    try {
      execSync(`"${tscBin}" --project "${tsconfig}" --noEmit false --declaration false --outDir "${cfg.mpDest}"`, {
        cwd: cfg.mpDest,
        stdio: 'pipe',
      })
      console.log(`  ✓ 编译完成`)
    } catch (e) {
      // tsc 可能有非致命错误（如类型警告），只要生成了 .js 就继续
      const hasJs = fs.readdirSync(path.join(cfg.mpDest, 'pages')).some(d => {
        const dir = path.join(cfg.mpDest, 'pages', d)
        return fs.statSync(dir).isDirectory() &&
          fs.readdirSync(dir).some(f => f.endsWith('.js'))
      })
      if (hasJs) {
        console.log(`  ⚠ tsc 有警告但已生成 .js，继续`)
      } else {
        console.error(`  ✗ TypeScript 编译失败:`, e.stderr?.toString() || e.message)
        throw e
      }
    }

    // 2c. 删除 TS 源文件和类型文件
    const tsRemoved = removeByExtension(cfg.mpDest, '.ts')
    fs.removeSync(path.join(cfg.mpDest, 'typings'))
    fs.removeSync(path.join(cfg.mpDest, 'tsconfig.json'))
    console.log(`  🗑 删除 ${tsRemoved} 个 .ts 文件 + typings/ + tsconfig.json`)
  } else {
    console.log(`  ⚠ 未找到 tsconfig.json 或 tsc，跳过编译`)
  }

  // 2d. 混淆 JS（跳过 miniprogram_npm）
  console.log(`  🔒 混淆 JS...`)
  const obfuscated = obfuscateDir(cfg.mpDest, OBFUSCATE_LIGHT, ['miniprogram_npm'])
  console.log(`  ✓ 混淆 ${obfuscated} 个文件`)

  // 2e. 精简 package.json
  const pkgPath = path.join(cfg.mpDest, 'package.json')
  if (fs.existsSync(pkgPath)) {
    cleanPackageJson(pkgPath)
    console.log(`  ✓ package.json 已精简`)
  }
}

// ── Phase 3: 管理后台 ───────────────────────────────────

function buildAdmin() {
  const adminSrc = path.join(ROOT, 'fengyu-admin')
  const adminDest = path.join(DELIVERY, 'fengyu-admin')

  console.log(`\n🖥  [fengyu-admin] 构建 Next.js standalone...`)

  // 检查是否已有构建产物
  const standalonePath = path.join(adminSrc, '.next/standalone')
  const staticPath = path.join(adminSrc, '.next/static')

  if (!fs.existsSync(standalonePath)) {
    console.log(`  🔧 执行 bun run build...`)
    try {
      execSync('bun run build', { cwd: adminSrc, stdio: 'inherit' })
    } catch (e) {
      console.error(`  ✗ Next.js 构建失败`)
      throw e
    }
  } else {
    console.log(`  ✓ 使用已有构建产物`)
  }

  // 复制 standalone
  console.log(`  📋 复制 standalone 产物...`)
  fs.copySync(standalonePath, path.join(adminDest, '.next/standalone'))

  // 复制 static
  if (fs.existsSync(staticPath)) {
    fs.copySync(staticPath, path.join(adminDest, '.next/static'))
  }

  // 复制 public
  const publicPath = path.join(adminSrc, 'public')
  if (fs.existsSync(publicPath)) {
    fs.copySync(publicPath, path.join(adminDest, 'public'))
  }

  console.log(`  ✓ 管理后台构建完成（仅包含编译产物，无源码）`)
}

// ── Phase 4: 全局清理 ───────────────────────────────────

function globalCleanup() {
  console.log(`\n🧹 全局清理...`)

  const dangerousFiles = [
    'CLAUDE.md', 'README.md', '.gitignore', '.claudeignore',
    'vitest.config.js', 'vitest.config.ts',
    'playwright.config.ts', 'jest.config.js',
    '.env', '.env.local', '.env.example',
  ]

  const dangerousDirs = [
    '.claude', '.42cog', 'docs', 'notes', 'db',
    '.git', '__tests__', 'e2e', 'mock',
    'coverage', 'playwright-report', 'test-results',
    'scripts', // 不交付构建脚本自身
  ]

  let removedFiles = 0
  let removedDirs = 0

  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (dangerousDirs.includes(entry.name)) {
          fs.removeSync(full)
          removedDirs++
        } else {
          walk(full)
        }
      } else {
        if (dangerousFiles.includes(entry.name)) {
          fs.removeSync(full)
          removedFiles++
        }
      }
    }
  }

  walk(DELIVERY)
  console.log(`  🗑 删除 ${removedFiles} 个文件, ${removedDirs} 个目录`)
}

// ── Phase 5: 报告 ────────────────────────────────────────

function printReport() {
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  交付构建报告`)
  console.log(`${'═'.repeat(50)}`)

  const projects = [
    { name: 'fengyu-client/cloudfunctions/clientApi', dir: path.join(DELIVERY, 'fengyu-client/cloudfunctions/clientApi') },
    { name: 'fengyu-staff/cloudfunctions/staffApi', dir: path.join(DELIVERY, 'fengyu-staff/cloudfunctions/staffApi') },
    { name: 'fengyu-client/miniprogram', dir: path.join(DELIVERY, 'fengyu-client/miniprogram') },
    { name: 'fengyu-staff/miniprogram', dir: path.join(DELIVERY, 'fengyu-staff/miniprogram') },
    { name: 'fengyu-admin', dir: path.join(DELIVERY, 'fengyu-admin') },
  ]

  let totalSize = 0
  let totalFiles = 0

  for (const p of projects) {
    const size = getDirSize(p.dir)
    const files = countFiles(p.dir)
    totalSize += parseFloat(size)
    totalFiles += files
    console.log(`  ${p.name.padEnd(42)} ${String(files).padStart(5)} 文件  ${size.padStart(8)} MB`)
  }

  console.log(`${'─'.repeat(50)}`)
  console.log(`  ${'总计'.padEnd(41)} ${String(totalFiles).padStart(5)} 文件  ${totalSize.toFixed(2).padStart(8)} MB`)
  console.log(`\n  📁 输出目录: ${DELIVERY}`)
  console.log(`${'═'.repeat(50)}\n`)
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log('🚀 开始交付构建...\n')
  const startTime = Date.now()

  // Phase 0: 清空
  console.log('🗑 清空 delivery/ 目录...')
  fs.removeSync(DELIVERY)
  fs.ensureDirSync(DELIVERY)

  // Phase 1: 云函数
  for (const cfg of CLOUD_FUNCTIONS) {
    fs.ensureDirSync(cfg.dest)
    await buildCloudFunction(cfg)
  }

  // Phase 2: 小程序
  for (const cfg of MINI_PROGRAMS) {
    buildMiniProgram(cfg)
  }

  // Phase 3: 管理后台
  buildAdmin()

  // Phase 4: 全局清理
  globalCleanup()

  // Phase 5: 报告
  printReport()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ 构建完成，耗时 ${elapsed}s`)
}

main().catch((err) => {
  console.error('\n❌ 构建失败:', err.message || err)
  process.exit(1)
})
