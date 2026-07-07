

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const NODE_MODULES = path.join(__dirname, '..', 'node_modules')


const STUB_PACKAGES = [
  '@azure/identity',
  '@azure/keyvault-keys'
]


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


for (const dir of DELETE_DIRS) {
  const fullPath = path.join(NODE_MODULES, dir)
  if (fs.existsSync(fullPath)) {
    const sizeBefore = getDirSize(fullPath)
    rmrf(fullPath)
    console.log(`  deleted ${dir} (${sizeBefore})`)
  }
}


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
