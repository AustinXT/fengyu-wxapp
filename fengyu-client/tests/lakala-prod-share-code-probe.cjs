/**
 * 拉卡拉【生产环境】支付宝吱口令真实联调探测（手动跑，非 CI，会打真实 prod 网关 s2.lakala.com）
 *
 * 目标：对「南昌县凤仪韵美容美体馆」(merchant_no=82242107230052R) 串调
 *   preorder(ALIPAY/41 NATIVE) → share_code，金额 0.1 元（10 分），看 prod 网关真实返回。
 *
 * 复用 client 生产同款 utils（加签 + 验签 + PEM 归一化），跑通即证明部署态可用。
 *
 * 用法：
 *   node fengyu-client/tests/lakala-prod-share-code-probe.cjs
 * 可选覆盖：
 *   LAKALA_SMOKE_MERCHANT  默认 82242107230052R（凤仪韵）
 *   LAKALA_SMOKE_TERM      默认空（凤仪韵 DB 无终端号；空则不送 term_no 让网关裁决）
 *   LAKALA_PROBE_AMOUNT    默认 10（分）= 0.1 元
 *
 * 已知阻塞点（按出现顺序）：
 *   1) IP 白名单：本机出口 IP 须在拉卡拉 prod 请求白名单，否则 GW0004（与签名无关）
 *   2) term_no  ：凤仪韵 DB 无终端号，preorder 通常要求 term_no
 *   3) 支付宝入网：凤仪韵 alipay_sub_mchid 空 + 实名未提交，吱口令走支付宝通道可能被拒
 */
'use strict'
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '../..') // fengyu-wxapp 根

// ── 加载 prod.env（单行 KEY=VALUE；多行 PEM 块随后用独立文件覆盖）──
function loadEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return false
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    if (!line || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("(.*)"|(.*))$/)
    if (!m) continue
    const [, key, , quoted, bare] = m
    const val = quoted !== undefined ? quoted : bare
    if (!(key in process.env)) process.env[key] = val
  }
  return true
}

const prodEnv = path.join(ROOT, 'envs/prod.env')
if (!loadEnvFile(prodEnv)) {
  console.error(`✗ 缺少 ${prodEnv}`)
  process.exit(2)
}
// prod 私钥/证书从独立 PEM 文件读（多行块，覆盖 env 里被截断的值）
const pemPath = path.join(ROOT, 'envs/api_private_key.pem')
const certPath = path.join(ROOT, 'envs/平台公钥生产.cer')
if (fs.existsSync(pemPath)) process.env.LAKALA_PRIVATE_KEY_PEM = fs.readFileSync(pemPath, 'utf8')
if (fs.existsSync(certPath)) process.env.LAKALA_PLATFORM_CERT_PEM = fs.readFileSync(certPath, 'utf8')

const CLIENT = path.resolve(__dirname, '../cloudfunctions/clientApi/utils')
const lakalaClient = require(path.join(CLIENT, 'lakala-client'))
const lakalaConfig = require(path.join(CLIENT, 'lakala-config'))

async function main() {
  const missing = lakalaConfig.missingVars()
  if (missing.length) {
    console.error('✗ 缺少环境变量：', missing.join(', '))
    process.exit(2)
  }
  const cfg = lakalaConfig.readConfig()
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || '82242107230052R'
  const termNo = process.env.LAKALA_SMOKE_TERM || ''
  const amountFen = parseInt(process.env.LAKALA_PROBE_AMOUNT || '10', 10)
  const outTradeNo = `PROBE${Date.now()}`

  console.log('============================================')
  console.log('  拉卡拉【生产】支付宝吱口令真实联调探测')
  console.log('============================================')
  console.log(`  API_BASE            = ${cfg.apiBase}`)
  console.log(`  APPID               = ${cfg.appid}`)
  console.log(`  SERIAL_NO           = ${cfg.serialNo.slice(0, 13)}...`)
  console.log(`  alipay_share_source = ${cfg.alipayShareSource || '(未配置!)'}`)
  console.log(`  merchant_no         = ${merchantNo}（南昌县凤仪韵美容美体馆）`)
  console.log(`  term_no             = ${termNo || '(空, 不送)'}`)
  console.log(`  金额                = ${amountFen} 分 = ${(amountFen / 100).toFixed(2)} 元`)
  console.log(`  out_trade_no        = ${outTradeNo}`)
  console.log('')

  if (!cfg.alipayShareSource) {
    console.error('✗ LAKALA_ALIPAY_SHARE_SOURCE 未配置，share_code 会被拒')
    process.exit(2)
  }

  // ── 步骤 1: preorder(ALIPAY/41 NATIVE) 拿二维码 URL ──
  console.log(`>>> POST ${cfg.apiBase}/v3/labs/trans/preorder  (ALIPAY/41)`)
  const preorderReqData = {
    merchant_no: merchantNo,
    out_trade_no: outTradeNo,
    account_type: 'ALIPAY',
    trans_type: '41',
    total_amount: String(amountFen),
    notify_url: cfg.notifyUrl || '',
    subject: '凤御 prod 吱口令联调',
    location_info: { request_ip: '0.0.0.0' },
    acc_busi_fields: { timeout_express: '10' },
  }
  if (termNo) preorderReqData.term_no = termNo

  let alipayQrUrl = ''
  try {
    const resp = await lakalaClient.request({ path: '/v3/labs/trans/preorder', reqData: preorderReqData })
    console.log(`<<< code=${resp.code}  msg=${resp.msg}  ok=${resp.ok}`)
    console.log('<<< resp_data =', JSON.stringify(resp.resp_data))
    const accResp = (resp.resp_data && resp.resp_data.acc_resp_fields) || {}
    alipayQrUrl = accResp.code || ''
    if (!resp.ok) {
      console.error(`\n✗ preorder 未成功（code=${resp.code}）。详见上方 msg/resp_data。`)
      process.exit(1)
    }
    if (!alipayQrUrl) {
      console.error('\n✗ preorder 成功但未返回 alipayQrUrl（acc_resp_fields.code 为空）')
      process.exit(1)
    }
    console.log('<<< alipayQrUrl =', alipayQrUrl)
  } catch (err) {
    console.error(`\n✗ preorder 请求异常：${err.message}`)
    process.exit(1)
  }

  // ── 步骤 2: share_code 用 alipayQrUrl 作为 biz_link 换吱口令 ──
  console.log(`\n>>> POST ${cfg.apiBase}/v3/labs/trans/share_code`)
  const shareReqData = {
    merchant_no: merchantNo,
    out_trade_no: outTradeNo,
    account_type: 'ALIPAY',
    total_amount: String(amountFen),
    location_info: { request_ip: '0.0.0.0' },
    acc_busi_fields: { source: cfg.alipayShareSource, biz_link: alipayQrUrl },
  }
  if (termNo) shareReqData.term_no = termNo
  try {
    const resp = await lakalaClient.request({ path: '/v3/labs/trans/share_code', reqData: shareReqData })
    console.log(`<<< code=${resp.code}  msg=${resp.msg}  ok=${resp.ok}`)
    console.log('<<< resp_data =', JSON.stringify(resp.resp_data))
    const accResp = (resp.resp_data && resp.resp_data.acc_resp_fields) || {}
    if (resp.ok && accResp.share_token) {
      console.log('\n✓ PASS —— 吱口令生成成功！')
      console.log('<<< share_token =', accResp.share_token)
      console.log('<<< expire_date =', accResp.expire_date || '(永久)')
      process.exit(0)
    }
    console.error(`\n✗ share_code 未拿到 share_token（code=${resp.code}）`)
    process.exit(1)
  } catch (err) {
    console.error(`\n✗ share_code 请求异常：${err.message}`)
    process.exit(1)
  }
}

main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
