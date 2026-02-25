/**
 * 清理 node_modules 中不需要的大体积依赖
 *
 * tedious（SQL Server 驱动）会拖入 @azure/identity、@azure/keyvault-keys
 * 等 Azure SDK 包（共约 50MB），但我们只使用 SQL Server 认证，不需要 Azure AD。
 *
 * 此脚本:
 * 1. 删除这些包的实际代码
 * 2. 创建空 stub 防止 require() 报错
 * 3. 删除其他不需要的大体积传递依赖
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const NODE_MODULES = path.join(__dirname, '..', 'node_modules')

// 需要替换为空 stub 的包（tedious 会 require 它们，但运行时不会调用）
const STUB_PACKAGES = [
  '@azure/identity',
  '@azure/keyvault-keys'
]

// 需要完整删除的目录（不被 require，或已被 stub 覆盖后多余）
const DELETE_DIRS = [
  '@azure',
  '@azure-rest',
  '@typespec',
  '@types'
]

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function getDirSize(dir) {
  try {
    return execSync(`du -sh "${dir}"`, { encoding: 'utf8' }).trim().split('\t')[0]
  } catch {
    return '?'
  }
}

// Step 1: 删除大体积目录
for (const dir of DELETE_DIRS) {
  const fullPath = path.join(NODE_MODULES, dir)
  if (fs.existsSync(fullPath)) {
    const sizeBefore = getDirSize(fullPath)
    rmrf(fullPath)
    console.log(`  deleted ${dir} (${sizeBefore})`)
  }
}

// Step 2: 创建空 stub（tedious 顶层 require 了这些包，不 stub 会 crash）
for (const pkg of STUB_PACKAGES) {
  const pkgDir = path.join(NODE_MODULES, pkg)
  mkdirp(pkgDir)

  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkg, version: '0.0.0-stub', main: 'index.js' })
  )

  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    '// Stub: Azure AD auth not used in this project\nmodule.exports = {};\n'
  )

  console.log(`  stubbed ${pkg}`)
}

console.log('prune-deps: done')
