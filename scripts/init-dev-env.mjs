#!/usr/bin/env node
// 一次性脚本：从现有 fengyu-{client,staff}/cloudbaserc.json + .env 提取 dev 实值
// 生成 envs/dev.env（gitignored）。
//
// 已存在 envs/dev.env 时拒绝覆盖，需先手工删除或重命名。
//
// Usage: node scripts/init-dev-env.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const outPath = path.join(ROOT, 'envs', 'dev.env')
if (fs.existsSync(outPath)) {
  console.error(`ERROR: ${outPath} already exists. Remove or rename it first.`)
  process.exit(1)
}

const client = JSON.parse(fs.readFileSync(path.join(ROOT, 'fengyu-client', 'cloudbaserc.json'), 'utf8'))
const staff = JSON.parse(fs.readFileSync(path.join(ROOT, 'fengyu-staff', 'cloudbaserc.json'), 'utf8'))

const clientFn = client.functions.find((f) => f.name === 'clientApi').envVariables
const payNotifyFn = client.functions.find((f) => f.name === 'payNotify').envVariables
const staffFn = staff.functions.find((f) => f.name === 'staffApi').envVariables

// 从 LAKALA_NOTIFY_URL 反推 CLIENT_SERVICE_URL
const clientServiceUrl = clientFn.LAKALA_NOTIFY_URL.replace(/\/lakala\/notify$/, '')

// 转义多行字符串为带引号的单行（保留 \n 字面）
function q(v) {
  if (v == null) return ''
  if (typeof v !== 'string') return v
  if (v.includes('\n')) return `"${v.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  if (v.includes(' ') || v.includes('"')) return `"${v.replace(/"/g, '\\"')}"`
  return v
}

const lines = [
  '# envs/dev.env — 从 cloudbaserc.json 自动收集（一次性生成）',
  `# Generated: ${new Date().toISOString()}`,
  '',
  '# === 标识 ===',
  'ENV_PROFILE=dev',
  '',
  '# === PG ===',
  `PG_CONNECTION_STRING=${clientFn.PG_CONNECTION_STRING}`,
  `ADMIN_DATABASE_URL=${clientFn.PG_CONNECTION_STRING}`,
  '',
  '# === CloudBase envId ===',
  `CLIENT_ENV_ID=${client.envId}`,
  `STAFF_ENV_ID=${staff.envId}`,
  '',
  '# === CloudBase HTTP service URL ===',
  `CLIENT_SERVICE_URL=${clientServiceUrl}`,
  `LAKALA_NOTIFY_URL=${clientFn.LAKALA_NOTIFY_URL}`,
  `CLIENT_API_HTTP_URL=${staffFn.CLIENT_API_HTTP_URL || clientServiceUrl + '/cloudfunctions/clientApi'}`,
  '',
  '# === 内部 RPC ===',
  `CLIENT_SECRET=${staffFn.CLIENT_SECRET}`,
  '',
  '# === 小程序版本 + 测试通道 ===',
  `WXACODE_ENV_VERSION=${staffFn.WXACODE_ENV_VERSION || 'develop'}`,
  `ALLOW_TEST_OPENID=${clientFn.ALLOW_TEST_OPENID || 'true'}`,
  '',
  '# === 拉卡拉 sit ===',
  `LAKALA_API_BASE=${clientFn.LAKALA_API_BASE}`,
  `LAKALA_APPID=${clientFn.LAKALA_APPID}`,
  `LAKALA_SERIAL_NO=${clientFn.LAKALA_SERIAL_NO}`,
  `LAKALA_DEFAULT_MERCHANT_NO=${clientFn.LAKALA_DEFAULT_MERCHANT_NO}`,
  `LAKALA_DEFAULT_TERM_NO=${clientFn.LAKALA_DEFAULT_TERM_NO}`,
  `LAKALA_SM4_KEY=${clientFn.LAKALA_SM4_KEY}`,
  `LAKALA_CALLBACK_IP_WHITELIST=${clientFn.LAKALA_CALLBACK_IP_WHITELIST}`,
  `LAKALA_ENV=${clientFn.LAKALA_ENV}`,
  `LAKALA_PRIVATE_KEY_PEM=${q(clientFn.LAKALA_PRIVATE_KEY_PEM)}`,
  `LAKALA_PLATFORM_CERT_PEM=${q(clientFn.LAKALA_PLATFORM_CERT_PEM)}`,
  '',
  '# === 第三方 ===',
  `TMAP_KEY=${clientFn.TMAP_KEY}`,
  `TMAP_SECRET=${clientFn.TMAP_SECRET}`,
  `MSSQL_CONNECTION_STRING=${q(clientFn.MSSQL_CONNECTION_STRING)}`,
  '',
  '# === payNotify ===',
  `PAYNOTIFY_ENABLED=${payNotifyFn.PAYNOTIFY_ENABLED || 'true'}`,
  '',
  '# === admin（开发用，prod 需独立生成）===',
  `ADMIN_JWT_SECRET=dev-jwt-secret-replace-in-prod`,
  '',
]

fs.writeFileSync(outPath, lines.join('\n'))
console.log(`✓ Wrote ${outPath}`)
console.log(`  Now: scripts/use-env.sh dev   # 验证渲染`)
