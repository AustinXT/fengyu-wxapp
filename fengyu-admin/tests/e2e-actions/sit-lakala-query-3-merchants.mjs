#!/usr/bin/env bun
/**
 * 拉卡拉 3 个真实商户开户状态反查 smoke
 *
 * 目标：对凤御已入网的 3 个商户（U/S/R），调用 queryWxConfig（微信 + 支付宝两次）
 * 拉取「开户状态」字段，看真实响应结构，为 admin 后台「从拉卡拉刷新」按钮的字段映射定锚。
 *
 * 环境切换：
 *   默认走 .env.local（SIT），LAKALA_ENV=prod 切到 envs/prod.env + envs/api_private_key.pem
 *
 * IP 白名单已知阻塞：
 *   - SIT 网关：本地开发出口 IP 不在白名单 → 一定返 GW0004（arch/009 已记录）
 *   - prod 网关：admin 服务器 47.113.202.7 出口 IP 是否在白名单待业务方确认
 *   GW0004 不代表代码或签名错，纯网关层 IP 拦截。
 *
 * 仅只读，不动 DB、不修改 DEV/PROD 拉卡拉侧数据。
 *
 * 用法：
 *   bun fengyu-admin/tests/e2e-actions/sit-lakala-query-3-merchants.mjs
 *   LAKALA_ENV=prod bun fengyu-admin/tests/e2e-actions/sit-lakala-query-3-merchants.mjs
 */
import path from 'node:path'
import fs from 'node:fs'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ENV_MODE = process.env.LAKALA_ENV === 'prod' ? 'prod' : 'sit'

// ── 加载 env ──────────────────────────────────────────────
function loadEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return false
  const text = fs.readFileSync(envFile, 'utf8')
  for (const line of text.split('\n')) {
    if (!line || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("(.*)"|(.*))$/)
    if (!m) continue
    const [, key, , quoted, bare] = m
    const val = quoted !== undefined ? quoted : bare
    if (!(key in process.env)) process.env[key] = val
  }
  return true
}

if (ENV_MODE === 'prod') {
  const prodEnv = path.join(PROJECT_ROOT, 'envs/prod.env')
  if (!loadEnvFile(prodEnv)) {
    console.error(`❌ envs/prod.env 不存在；prod 模式需要 ${prodEnv}`)
    process.exit(1)
  }
  // prod 私钥从 envs/api_private_key.pem 读（PEM 多行需直接 cat）
  const pemPath = path.join(PROJECT_ROOT, 'envs/api_private_key.pem')
  if (fs.existsSync(pemPath) && !process.env.LAKALA_PRIVATE_KEY_PEM) {
    process.env.LAKALA_PRIVATE_KEY_PEM = fs.readFileSync(pemPath, 'utf8')
  }
  const certPath = path.join(PROJECT_ROOT, 'envs/平台公钥生产.cer')
  if (fs.existsSync(certPath) && !process.env.LAKALA_PLATFORM_CERT_PEM) {
    process.env.LAKALA_PLATFORM_CERT_PEM = fs.readFileSync(certPath, 'utf8')
  }
} else {
  const localEnv = path.join(PROJECT_ROOT, 'fengyu-admin/.env.local')
  loadEnvFile(localEnv)
}
process.env.NODE_ENV = process.env.NODE_ENV || (ENV_MODE === 'prod' ? 'production' : 'development')

const client = await import('../../src/lib/lakala-client.ts')

// ── 3 个真实商户（截图手抄） ───────────────────────────────
const MERCHANTS = [
  {
    merCupNo: '82242107230052U',
    merInnerNo: '4002026052532607913',
    name: '南昌县象湖燕美御生活美容馆',
  },
  {
    merCupNo: '82242107230052S',
    merInnerNo: '4002026052582608078',
    name: '南昌县蓝茉美容院',
  },
  {
    merCupNo: '82242107230052R',
    merInnerNo: '4002026052552607045',
    name: '南昌县凤仪韵美容美体馆',
  },
]

const TRADE_MODES = ['WECHAT', 'ALIPAY']
const results = []

console.log('============================================')
console.log('  拉卡拉 3 商户开户状态反查 smoke')
console.log('============================================')
console.log(`  ENV_MODE = ${ENV_MODE}`)
console.log(`  API_BASE = ${process.env.LAKALA_API_BASE}`)
console.log(`  APPID    = ${process.env.LAKALA_APPID}`)
console.log(`  isReady  = ${client.isReady()}`)
if (!client.isReady()) {
  console.error('❌ LAKALA_NOT_READY：加签 env 缺失，请检查 APPID/SERIAL_NO/PRIVATE_KEY_PEM/PLATFORM_CERT_PEM/API_BASE')
  process.exit(1)
}

for (const m of MERCHANTS) {
  for (const tradeMode of TRADE_MODES) {
    const label = `${m.name} / ${tradeMode}`
    console.log(`\n──[${label}]`)
    console.log(`  merchantNo    = ${m.merCupNo}`)
    console.log(`  subMerchantId = ${m.merInnerNo}`)
    try {
      const t0 = Date.now()
      const resp = await client.queryWxConfig({
        tradeMode,
        merchantNo: m.merCupNo,
        subMerchantId: m.merInnerNo,
      })
      const elapsed = Date.now() - t0
      const code = resp?.code
      const msg = resp?.msg
      console.log(`  耗时 ${elapsed}ms  code=${code}  msg=${msg}`)

      const data = resp?.resp_data
      if (data && typeof data === 'object' && Object.keys(data).length) {
        const keys = Object.keys(data)
        console.log(`  resp_data (${keys.length} 个字段):`)
        for (const k of keys) {
          const v = JSON.stringify(data[k])
          console.log(`    · ${k} = ${v.length > 100 ? v.slice(0, 100) + '...' : v}`)
        }
      } else {
        console.log(`  resp_data: (空)`)
      }

      const ok = code === '000000' || code === 'BBS00000' || code === 'SUCCESS'
      results.push({
        label, code, msg,
        status: ok ? 'OK' : (code === 'GW0004' ? 'IP_WHITELIST_BLOCKED' : 'BUSINESS_REJECT'),
        respKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      })
    } catch (e) {
      console.log(`  ❌ 异常: ${e?.message || e}`)
      results.push({ label, status: 'ERROR', error: String(e?.message || e) })
    }
  }
}

// ── 汇总 ──────────────────────────────────────────────────
console.log('\n============================================')
console.log('              汇总报告')
console.log('============================================')
const byStatus = { OK: 0, BUSINESS_REJECT: 0, IP_WHITELIST_BLOCKED: 0, ERROR: 0 }
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1

console.log(`成功:                 ${byStatus.OK} 次`)
console.log(`业务拒绝（链路通畅）: ${byStatus.BUSINESS_REJECT} 次`)
console.log(`IP 白名单拒（GW0004）: ${byStatus.IP_WHITELIST_BLOCKED} 次`)
console.log(`异常:                 ${byStatus.ERROR} 次`)

console.log('\n详细分项:')
for (const r of results) {
  const mark = r.status === 'OK' ? '✅' :
               r.status === 'BUSINESS_REJECT' ? '⚠️' :
               r.status === 'IP_WHITELIST_BLOCKED' ? '🚧' : '❌'
  console.log(`  ${mark} ${r.label}`)
  if (r.code) console.log(`        code=${r.code}  msg=${r.msg ?? ''}`)
  if (r.respKeys?.length) console.log(`        resp_data 字段: ${r.respKeys.join(', ')}`)
  if (r.error) console.log(`        error: ${r.error}`)
}

console.log('\n关键看点（OK 时）:')
console.log('  - resp_data 里"开户状态"字段名（authStatus / status / openStatus / mrchStatus ?）')
console.log('  - 该字段的实际取值（AUTHED / SUCCESS / FAIL / PENDING / ...）')
console.log('  - Phase 2 admin action 的状态映射就靠这里实测结果定锚')

if (byStatus.IP_WHITELIST_BLOCKED > 0) {
  console.log('\n🚧 IP 白名单未通：')
  const ip = '(需自查：curl ifconfig.me)'
  console.log(`  当前出口 IP: ${ip}`)
  console.log('  操作：业务方联系拉卡拉客户经理，把出口 IP 加入对应环境（SIT/prod）白名单')
  console.log('  通了之后重跑本脚本即可看到真实开户状态字段')
}
