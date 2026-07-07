#!/usr/bin/env node



const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

const TARGETS = [
  path.join(ROOT, 'fengyu-client/miniprogram/utils/version.ts'),
  path.join(ROOT, 'fengyu-staff/miniprogram/utils/version.ts'),
]

function resolveVersion() {
  try {
    return execSync('git describe --tags --abbrev=0', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    
    return 'dev'
  }
}

function render(version) {
  return `// utils/version.ts — 自动生成，请勿手改
// 来源：最新 git tag（scripts/gen-version.js）
export const APP_VERSION = '${version}';
`
}

function main() {
  const version = resolveVersion()
  const content = render(version)
  for (const target of TARGETS) {
    fs.writeFileSync(target, content)
    console.log(`✏️  ${path.relative(ROOT, target)} → ${version}`)
  }
}

main()
