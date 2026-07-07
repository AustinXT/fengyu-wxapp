#!/usr/bin/env node



const path = require('path')
const fs = require('fs-extra')
const { execSync } = require('child_process')
const webpack = require('webpack')
const JavaScriptObfuscator = require('javascript-obfuscator')


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
    mpSrc: path.join(ROOT, 'fengyu-client/miniprogram'),
    mpDest: path.join(DELIVERY, 'fengyu-client/miniprogram'),
    
    extraFiles: [],
  },
  {
    name: 'fengyu-staff',
    mpSrc: path.join(ROOT, 'fengyu-staff/miniprogram'),
    mpDest: path.join(DELIVERY, 'fengyu-staff/miniprogram'),
    
    extraFiles: [],
  },
]




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
  
  debugProtection: false,
  
  splitStrings: false,
  
  disableConsoleOutput: false,
}


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



function shouldExclude(name, isDir) {
  if (isDir) return GLOBAL_EXCLUDE_DIRS.has(name)
  if (GLOBAL_EXCLUDE_FILES.has(name)) return true
  if (name.endsWith('.test.ts') || name.endsWith('.test.js')) return true
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.js')) return true
  return false
}


function copyFiltered(src, dest) {
  fs.copySync(src, dest, {
    filter: (srcPath) => {
      const name = path.basename(srcPath)
      if (srcPath === src) return true 
      const stat = fs.statSync(srcPath)
      return !shouldExclude(name, stat.isDirectory())
    },
  })
}


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


function obfuscateFile(filePath, options) {
  const code = fs.readFileSync(filePath, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(code, options)
  fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8')
}


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
      
      optimization: {
        splitChunks: false,
        minimize: false, 
      },
      
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

      
      console.log(`  🔒 混淆中...`)
      obfuscateFile(path.join(cfg.dest, 'index.js'), OBFUSCATE_HEAVY)
      console.log(`  ✓ 混淆完成`)

      
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



function buildMiniProgram(cfg) {
  console.log(`\n📱 [${cfg.name}] 构建小程序...`)

  
  console.log(`  📋 复制文件（排除测试/文档）...`)
  copyFiltered(cfg.mpSrc, cfg.mpDest)

  
  for (const f of cfg.extraFiles) {
    if (fs.existsSync(f.src)) {
      fs.copySync(f.src, f.dest)
    }
  }

  
  
  const tscBin = path.join(cfg.mpSrc, 'node_modules/.bin/tsc')
  const tsconfig = path.join(cfg.mpDest, 'tsconfig.json')

  if (fs.existsSync(tsconfig) && fs.existsSync(tscBin)) {
    console.log(`  🔧 TypeScript 编译...`)

    
    
    const tsconfigContent = fs.readJsonSync(tsconfig)
    const originalTypeRoots = tsconfigContent.compilerOptions.typeRoots
    tsconfigContent.compilerOptions.typeRoots = (originalTypeRoots || []).map(r => {
      
      if (r.startsWith('./node_modules') || r.startsWith('node_modules')) {
        return path.join(cfg.mpSrc, r.replace(/^\.\//, ''))
      }
      
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

    
    const tsRemoved = removeByExtension(cfg.mpDest, '.ts')
    fs.removeSync(path.join(cfg.mpDest, 'typings'))
    fs.removeSync(path.join(cfg.mpDest, 'tsconfig.json'))
    console.log(`  🗑 删除 ${tsRemoved} 个 .ts 文件 + typings/ + tsconfig.json`)
  } else {
    console.log(`  ⚠ 未找到 tsconfig.json 或 tsc，跳过编译`)
  }

  
  console.log(`  🔒 混淆 JS...`)
  const obfuscated = obfuscateDir(cfg.mpDest, OBFUSCATE_LIGHT, ['miniprogram_npm'])
  console.log(`  ✓ 混淆 ${obfuscated} 个文件`)

  
  const pkgPath = path.join(cfg.mpDest, 'package.json')
  if (fs.existsSync(pkgPath)) {
    cleanPackageJson(pkgPath)
    console.log(`  ✓ package.json 已精简`)
  }
}



function buildAdmin() {
  const adminSrc = path.join(ROOT, 'fengyu-admin')
  const adminDest = path.join(DELIVERY, 'fengyu-admin')

  console.log(`\n🖥  [fengyu-admin] 构建 Next.js standalone...`)

  
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

  
  console.log(`  📋 复制 standalone 产物...`)
  fs.copySync(standalonePath, path.join(adminDest, '.next/standalone'))

  
  if (fs.existsSync(staticPath)) {
    fs.copySync(staticPath, path.join(adminDest, '.next/static'))
  }

  
  const publicPath = path.join(adminSrc, 'public')
  if (fs.existsSync(publicPath)) {
    fs.copySync(publicPath, path.join(adminDest, 'public'))
  }

  console.log(`  ✓ 管理后台构建完成（仅包含编译产物，无源码）`)
}



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
    'scripts', 
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



async function main() {
  console.log('🚀 开始交付构建...\n')
  const startTime = Date.now()

  
  console.log('🗑 清空 delivery/ 目录...')
  fs.removeSync(DELIVERY)
  fs.ensureDirSync(DELIVERY)

  
  console.log('🏷  写入版本号...')
  execSync('node ' + path.join(__dirname, 'gen-version.js'), { stdio: 'inherit' })

  
  for (const cfg of CLOUD_FUNCTIONS) {
    fs.ensureDirSync(cfg.dest)
    await buildCloudFunction(cfg)
  }

  
  for (const cfg of MINI_PROGRAMS) {
    buildMiniProgram(cfg)
  }

  
  buildAdmin()

  
  globalCleanup()

  
  printReport()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ 构建完成，耗时 ${elapsed}s`)
}

main().catch((err) => {
  console.error('\n❌ 构建失败:', err.message || err)
  process.exit(1)
})
