/**
 * 拉卡拉【生产】交易查询（手动跑）—— 查某笔 out_trade_no 的真实到账状态。
 *
 * 用法：
 *   LAKALA_QUERY_OUT_TRADE_NO=PROBE1780991758194 node fengyu-client/tests/lakala-prod-query.cjs
 * 可选：LAKALA_QUERY_TRADE_NO（用拉卡拉 trade_no 查，与 out_trade_no 二选一）
 *
 * 凤仪韵：merchant_no=82242107230052R  term_no=M7086091
 */
'use strict'
const path = require('path')
const fs = require('fs')

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
const lakalaClient = require(path.join(CLIENT, 'lakala-client'))

async function main() {
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || '82242107230052R'
  const termNo = process.env.LAKALA_SMOKE_TERM || 'M7086091'
  const outTradeNo = process.env.LAKALA_QUERY_OUT_TRADE_NO || ''
  const tradeNo = process.env.LAKALA_QUERY_TRADE_NO || ''
  if (!outTradeNo && !tradeNo) {
    console.error('✗ 需传 LAKALA_QUERY_OUT_TRADE_NO 或 LAKALA_QUERY_TRADE_NO')
    process.exit(2)
  }
  console.log(`>>> 查询 merchant=${merchantNo} term=${termNo} out_trade_no=${outTradeNo || '(用trade_no)'} trade_no=${tradeNo || ''}`)
  const resp = await lakalaClient.queryTrade({ merchantNo, termNo, outTradeNo: outTradeNo || undefined, tradeNo: tradeNo || undefined })
  console.log(`<<< ok=${resp.ok} code=${resp.code} msg=${resp.msg}`)
  console.log(`<<< trade_state = ${resp.tradeState}`)
  console.log(`<<< trade_no    = ${resp.tradeNo}`)
  console.log(`<<< acc_trade_no= ${resp.accTradeNo}`)
  console.log(`<<< pay_mode    = ${resp.payMode}`)
  console.log(`<<< 订单金额    = ${resp.totalAmountFen} 分`)
  console.log(`<<< 实付金额    = ${resp.payerAmountFen} 分`)
  console.log(`<<< raw = ${JSON.stringify(resp.raw)}`)
  const map = { SUCCESS: '✓ 已支付到账', INIT: '未支付', CREATE: '已下单未支付', DEAL: '支付处理中', FAIL: '支付失败', CLOSE: '已关单', REFUND: '已全额退款', PART_REFUND: '部分退款' }
  console.log(`\n状态判定：${map[resp.tradeState] || resp.tradeState || '(未知)'}`)
  process.exit(resp.tradeState === 'SUCCESS' ? 0 : 1)
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
