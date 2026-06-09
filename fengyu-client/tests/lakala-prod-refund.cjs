/**
 * 拉卡拉【生产】退款（手动跑，会真实退款到付款人支付宝）——
 * 对原交易 origin_out_trade_no 发起统一退货 /v3/rfd/refund_front/refund（成功码 000000），
 * 退款后自动 refund_query 确认终态。
 *
 * 用法（默认退本次联调的 PROBE 单全额 0.1 元）：
 *   node fengyu-client/tests/lakala-prod-refund.cjs
 * 可选覆盖：
 *   LAKALA_REFUND_ORIGIN_OUT_TRADE_NO  原商户流水（默认 PROBE1780991758194）
 *   LAKALA_REFUND_ORIGIN_TRADE_NO      原拉卡拉交易流水（默认 20260609110113230266224454909356）
 *   LAKALA_REFUND_ORIGIN_LOG_NO        原对账单流水号（默认 66224454909356）
 *   LAKALA_REFUND_AMOUNT               退款金额（分，默认 10）
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
const lakalaConfig = require(path.join(CLIENT, 'lakala-config'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const cfg = lakalaConfig.readConfig()
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || '82242107230052R'
  const termNo = process.env.LAKALA_SMOKE_TERM || 'M7086091'
  const originOutTradeNo = process.env.LAKALA_REFUND_ORIGIN_OUT_TRADE_NO || 'PROBE1780991758194'
  const originTradeNo = process.env.LAKALA_REFUND_ORIGIN_TRADE_NO || '20260609110113230266224454909356'
  const originLogNo = process.env.LAKALA_REFUND_ORIGIN_LOG_NO || '66224454909356'
  const refundAmountFen = parseInt(process.env.LAKALA_REFUND_AMOUNT || '10', 10)
  const refundOutTradeNo = `REFUND${Date.now()}`

  console.log('============================================')
  console.log('  拉卡拉【生产】退款（真实退款到付款人）')
  console.log('============================================')
  console.log(`  merchant_no           = ${merchantNo}（凤仪韵）`)
  console.log(`  term_no               = ${termNo}`)
  console.log(`  退款流水 out_trade_no = ${refundOutTradeNo}`)
  console.log(`  退款金额              = ${refundAmountFen} 分 = ${(refundAmountFen / 100).toFixed(2)} 元`)
  console.log(`  原 origin_trade_no    = ${originTradeNo}`)
  console.log(`  原 origin_out_trade_no= ${originOutTradeNo}`)
  console.log(`  原 origin_log_no      = ${originLogNo}`)
  console.log('')

  // 发起退款
  console.log(`>>> POST ${cfg.apiBase}/v3/rfd/refund_front/refund`)
  const reqData = {
    merchant_no: merchantNo,
    term_no: termNo,
    out_trade_no: refundOutTradeNo,
    refund_amount: String(refundAmountFen),
    refund_acc_mode: '00',
    refund_amt_sts: '00',
    notify_url: cfg.notifyUrl || '',
    refund_reason: '凤御 prod 吱口令联调退款',
    origin_trade_no: originTradeNo,
    origin_out_trade_no: originOutTradeNo,
    origin_log_no: originLogNo,
    location_info: { request_ip: '0.0.0.0', location: '' },
  }
  let tradeState = ''
  try {
    const resp = await lakalaClient.request({ path: '/v3/rfd/refund_front/refund', reqData })
    console.log(`<<< code=${resp.code}  msg=${resp.msg}  ok=${resp.ok}`)
    console.log('<<< resp_data =', JSON.stringify(resp.resp_data))
    if (!resp.ok) {
      console.error(`\n✗ 退款被拒（code=${resp.code}）`)
      process.exit(1)
    }
    tradeState = resp.resp_data.trade_state || ''
    console.log(`<<< trade_state = ${tradeState}（${resp.resp_data.trade_state_desc || ''}）`)
  } catch (err) {
    console.error(`\n✗ 退款请求异常：${err.message}`)
    process.exit(1)
  }

  // 非同步成功则查询确认（异步退款）
  if (tradeState !== 'SUCCESS') {
    console.log('\n... 退款非同步成功，5s 后查询退款终态 ...')
    await sleep(5000)
    console.log(`>>> POST ${cfg.apiBase}/v3/rfd/refund_front/refund_query`)
    const qResp = await lakalaClient.request({
      path: '/v3/rfd/refund_front/refund_query',
      reqData: { merchant_no: merchantNo, term_no: termNo, out_trade_no: refundOutTradeNo },
    })
    console.log(`<<< code=${qResp.code}  msg=${qResp.msg}  ok=${qResp.ok}`)
    console.log('<<< resp_data =', JSON.stringify(qResp.resp_data))
    tradeState = qResp.resp_data.trade_state || tradeState
    console.log(`<<< trade_state = ${tradeState}`)
  }

  const ok = tradeState === 'SUCCESS'
  console.log(`\n${ok ? '✓ 退款成功 —— 0.1 元已原路退回付款人支付宝' : '⚠ 退款状态=' + tradeState + '（可能异步处理中，稍后复查）'}`)
  console.log(`退款流水号（复查用）：${refundOutTradeNo}`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
