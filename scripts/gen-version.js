#!/usr/bin/env node

/**
 * 版本号生成脚本 — 把最新 git tag 写入两端小程序的 utils/version.ts
 *
 * 小程序运行时拿不到 git，所以版本号必须在构建期固化进源码。
 * 用法: node scripts/gen-version.js
 * 触发时机: 发版打 tag 后手动跑一次，或由 build-delivery.js 自动调用。
 */

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
    // 无 tag（浅克隆 / 全新仓库）时退化为 dev
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
