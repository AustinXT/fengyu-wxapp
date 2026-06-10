/**
 * 拉卡拉【生产】preorder 全量 dump（手动）—— 打印完整请求 envelope + Authorization + 原始响应 body/headers。
 * 给人肉核对"实际发了什么 / 拉卡拉原样回了什么"用，不做任何结论加工。
 *
 * 用法：
 *   LAKALA_TRANS_TYPE=71 LAKALA_SMOKE_OPENID=oXXXX node fengyu-client/tests/lakala-prod-debug.cjs
 * 默认 trans_type=71，merchant=82242107230052R(凤仪韵) term=M7086091 金额10分。
 */
'use strict'
const path = require('path')
const fs = require('fs')
const https = require('https')
const { URL } = require('url')

const ROOT = path.resolve(__dirname, '../..')
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
loadEnvFile(path.join(ROOT, 'envs/prod.env'))
const pemPath = path.join(ROOT, 'envs/api_private_key.pem')
const certPath = path.join(ROOT, 'envs/平台公钥生产.cer')
if (fs.existsSync(pemPath)) process.env.LAKALA_PRIVATE_KEY_PEM = fs.readFileSync(pemPath, 'utf8')
if (fs.existsSync(certPath)) process.env.LAKALA_PLATFORM_CERT_PEM = fs.readFileSync(certPath, 'utf8')

const CLIENT = path.resolve(__dirname, '../cloudfunctions/clientApi/utils')
const sign = require(path.join(CLIENT, 'lakala-sign'))
const lakalaClient = require(path.join(CLIENT, 'lakala-client'))
const { readConfig } = require(path.join(CLIENT, 'lakala-config'))

const cfg = readConfig()
const transType = process.env.LAKALA_TRANS_TYPE || '71'
const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || '82242107230052R'
const termNo = process.env.LAKALA_SMOKE_TERM || 'M7086091'
const openid = process.env.LAKALA_SMOKE_OPENID || ''
const subAppid = process.env.LAKALA_SUB_APPID || cfg.subAppid
const amountFen = parseInt(process.env.LAKALA_PROBE_AMOUNT || '10', 10)
const outTradeNo = `DBG${Date.now()}`
const pathStr = '/v3/labs/trans/preorder'

const accBusi = { timeout_express: '10' }
if (transType === '71' || transType === '51' || transType === '61') { accBusi.sub_appid = subAppid; accBusi.user_id = openid }
if (transType === '51') accBusi.device_info = 'WEB'

const reqData = {
  merchant_no: merchantNo,
  term_no: termNo,
  out_trade_no: outTradeNo,
  account_type: 'WECHAT',
  trans_type: transType,
  total_amount: String(amountFen),
  notify_url: cfg.notifyUrl || '',
  subject: '凤御 prod 微信支付联调',
  location_info: { request_ip: '0.0.0.0' },
  acc_busi_fields: accBusi,
}
const envelope = { req_time: lakalaClient.formatReqTime(), version: '3.0', req_data: reqData }
const bodyStr = JSON.stringify(envelope)
const { authorization } = sign.buildRequestAuthorization({
  appid: cfg.appid, serialNo: cfg.serialNo, privateKeyPem: cfg.privateKeyPem, body: bodyStr,
})

console.log('================= 请求 REQUEST =================')
console.log('POST', cfg.apiBase + pathStr)
console.log('\n--- 请求 Headers ---')
console.log('Content-Type: application/json')
console.log('Authorization:', authorization)
console.log('\n--- 请求 Body (envelope，完整，原样发送) ---')
console.log(bodyStr)
console.log('\n--- 请求 Body (格式化便于阅读) ---')
console.log(JSON.stringify(envelope, null, 2))

const url = new URL(cfg.apiBase + pathStr)
const options = {
  method: 'POST', hostname: url.hostname, port: 443, path: url.pathname,
  headers: {
    'Content-Type': 'application/json', Accept: 'application/json',
    Authorization: authorization, 'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
  },
}
const req = https.request(options, (res) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8')
    console.log('\n================= 响应 RESPONSE =================')
    console.log('HTTP status:', res.statusCode)
    console.log('\n--- 响应 Headers (完整，含 Lklapi-* 验签头) ---')
    console.log(JSON.stringify(res.headers, null, 2))
    console.log('\n--- 响应 Body (原始，未解析，原样返回) ---')
    console.log(rawBody)
    console.log('\n--- 响应 Body (格式化) ---')
    try { console.log(JSON.stringify(JSON.parse(rawBody), null, 2)) } catch (e) { console.log('(非 JSON)') }
    process.exit(0)
  })
})
req.on('error', (e) => { console.error('请求错误:', e.message); process.exit(1) })
req.write(bodyStr)
req.end()
