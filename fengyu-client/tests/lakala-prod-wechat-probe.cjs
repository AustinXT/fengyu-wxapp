/**
 * 拉卡拉【生产】微信支付真实联调探测（手动跑，打真实 prod 网关）
 *
 * 支持两种 trans_type：
 *   41 NATIVE（默认）：扫码支付，返回 weixin:// 二维码 URL，不需要 openid/sub_appid
 *   71 微信小程序    ：返回 wx.requestPayment 5 字段，需 sub_appid + openid(user_id)
 *
 * 对「南昌县凤仪韵美容美体馆」(merchant_no=82242107230052R)，金额 0.1 元（10 分）。
 *
 * 用法：
 *   node fengyu-client/tests/lakala-prod-wechat-probe.cjs                       # 41 NATIVE
 *   LAKALA_TRANS_TYPE=71 LAKALA_SMOKE_OPENID=oXXXX node ...wechat-probe.cjs     # 71 小程序
 * 可选：LAKALA_SMOKE_MERCHANT / LAKALA_SMOKE_TERM / LAKALA_PROBE_AMOUNT(分) / LAKALA_SUB_APPID
 *
 * 凤仪韵：merchant_no=82242107230052R  term_no=M7086091  wx_sub_mchid=894487362
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

async function main() {
  const cfg = lakalaConfig.readConfig()
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || '82242107230052R'
  const termNo = process.env.LAKALA_SMOKE_TERM || 'M7086091'
  const transType = process.env.LAKALA_TRANS_TYPE || '41'
  const amountFen = parseInt(process.env.LAKALA_PROBE_AMOUNT || '10', 10)
  const subAppid = process.env.LAKALA_SUB_APPID || cfg.subAppid
  const openid = process.env.LAKALA_SMOKE_OPENID || ''
  const outTradeNo = `WXPROBE${Date.now()}`

  console.log('============================================')
  console.log(`  拉卡拉【生产】微信支付探测 trans_type=${transType}（${transType === '41' ? 'NATIVE扫码' : transType === '51' ? 'JSAPI公众号' : '小程序'}）`)
  console.log('============================================')
  console.log(`  API_BASE     = ${cfg.apiBase}`)
  console.log(`  merchant_no  = ${merchantNo}`)
  console.log(`  term_no      = ${termNo}`)
  console.log(`  金额         = ${amountFen} 分 = ${(amountFen / 100).toFixed(2)} 元`)
  console.log(`  out_trade_no = ${outTradeNo}`)
  const needsSubAppid = transType === '71' || transType === '51'
  if (needsSubAppid) {
    console.log(`  sub_appid    = ${subAppid}`)
    console.log(`  openid       = ${openid ? openid.slice(0, 8) + '...' + openid.slice(-4) : '(缺! 71/51必填)'}`)
  }
  console.log('')

  if (needsSubAppid && !openid) {
    console.error(`✗ trans_type=${transType} 必须传 LAKALA_SMOKE_OPENID`)
    process.exit(2)
  }

  const accBusi = { timeout_express: '10' }
  if (needsSubAppid) {
    accBusi.sub_appid = subAppid
    accBusi.user_id = openid
  }
  if (transType === '51') accBusi.device_info = 'WEB'  // JSAPI 文档建议设备号传 WEB
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

  console.log(`>>> POST ${cfg.apiBase}/v3/labs/trans/preorder (WECHAT/${transType})`)
  try {
    const resp = await lakalaClient.request({ path: '/v3/labs/trans/preorder', reqData })
    console.log(`<<< code=${resp.code}  msg=${resp.msg}  ok=${resp.ok}`)
    console.log('<<< resp_data =', JSON.stringify(resp.resp_data))
    if (!resp.ok) {
      console.error(`\n✗ preorder 未成功（code=${resp.code}）。详见 msg/resp_data。`)
      process.exit(1)
    }
    const accResp = (resp.resp_data && resp.resp_data.acc_resp_fields) || {}
    console.log(`\n<<< trade_no = ${resp.resp_data.trade_no}`)
    console.log(`<<< log_no   = ${resp.resp_data.log_no}`)
    if (needsSubAppid) {
      console.log('<<< 支付参数（wx.requestPayment / JSAPI）：')
      console.log(`      app_id    = ${accResp.app_id}`)
      console.log(`      timeStamp = ${accResp.time_stamp}`)
      console.log(`      nonceStr  = ${accResp.nonce_str}`)
      console.log(`      package   = ${accResp.package}`)
      console.log(`      signType  = ${accResp.sign_type}`)
      console.log(`      paySign   = ${accResp.pay_sign ? String(accResp.pay_sign).slice(0, 30) + '...' : ''}`)
      console.log('\n✓ preorder 成功 —— 微信小程序产品权限已通；支付参数齐全（真支付需小程序内 wx.requestPayment 调起）')
    } else {
      const wxQrUrl = accResp.code || ''
      console.log(`<<< 微信二维码 URL = ${wxQrUrl}`)
      if (!wxQrUrl) { console.error('\n✗ 成功但未返回二维码 URL'); process.exit(1) }
      fs.writeFileSync(path.join(ROOT, '.lakala-wx-qr-url.txt'), wxQrUrl)
      console.log('\n✓ preorder 成功 —— 微信扫码产品权限已通！二维码 URL 已写入 .lakala-wx-qr-url.txt')
    }
    console.log(`  （查到账：LAKALA_QUERY_OUT_TRADE_NO=${outTradeNo} node fengyu-client/tests/lakala-prod-query.cjs）`)
    process.exit(0)
  } catch (err) {
    console.error(`\n✗ preorder 请求异常：${err.message}`)
    process.exit(1)
  }
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
