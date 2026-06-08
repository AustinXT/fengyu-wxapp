/**
 * 拉卡拉 SIT/联调 smoke（手动跑，非 CI）—— 用真实环境变量对拉卡拉网关打一发聚合主扫 preorder，
 * 验证：加签链路 / envelope / 字段类型 / 成功码 BBS00000 / wx.requestPayment 5 字段 / 响应验签 一次性全通。
 *
 * 用法（先把 LAKALA_* 注入环境，例如从 envs/dev.env 导出）：
 *   set -a; . envs/dev.env; set +a
 *   node fengyu-client/tests/lakala-sit-smoke.cjs
 * 可选覆盖：LAKALA_SMOKE_MERCHANT / LAKALA_SMOKE_TERM（默认取 LAKALA_DEFAULT_*）/ LAKALA_SMOKE_OPENID（默认 mock）
 *
 * 复用生产同款 utils（含 PEM \n 归一化 + 响应验签），因此跑通即证明部署态可用。
 *
 * 注：SIT 沙箱微信支付预期下单成功后，wx.requestPayment 调起会因 "sub mch id 与 sub appid 不匹配" 报错（文档明示）；
 *     smoke 只验证 preorder 下单 + acc_resp_fields 字段完整，不验证实际支付到账。
 */
'use strict'
const path = require('path')
const CLIENT = path.resolve(__dirname, '../cloudfunctions/clientApi/utils')
const lakalaClient = require(path.join(CLIENT, 'lakala-client'))
const lakalaConfig = require(path.join(CLIENT, 'lakala-config'))

async function main() {
  const missing = lakalaConfig.missingVars()
  if (missing.length) {
    console.error('✗ 缺少环境变量：', missing.join(', '))
    console.error('  先注入：set -a; . envs/dev.env; set +a')
    process.exit(2)
  }
  const cfg = lakalaConfig.readConfig()
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT
  const termNo = process.env.LAKALA_SMOKE_TERM
  if (!merchantNo || !termNo) {
    console.error('✗ 必须显式传 LAKALA_SMOKE_MERCHANT 和 LAKALA_SMOKE_TERM（一店一商户，env 不留默认）')
    console.error('  例：LAKALA_SMOKE_MERCHANT=822290059430BCY LAKALA_SMOKE_TERM=D9285650 node fengyu-client/tests/lakala-sit-smoke.cjs')
    process.exit(2)
  }
  const openid = process.env.LAKALA_SMOKE_OPENID || 'oMock00000000000000000000-smoke'
  const subAppid = cfg.subAppid
  console.log(`>>> ${cfg.apiBase}/v3/labs/trans/preorder`)
  console.log(`    merchant=${merchantNo} term=${termNo}`)
  console.log(`    sub_appid=${subAppid} openid=${openid}`)

  const outTradeNo = `SMOKE${Date.now()}`
  try {
    const resp = await lakalaClient.requestPreorder({
      merchantNo,
      termNo,
      outTradeNo,
      accountType: 'WECHAT',
      transType: '71',
      totalAmountFen: 1,  // 1 分（最小金额）
      requestIp: '0.0.0.0',
      subject: '凤御 SIT 烟测',
      attach: outTradeNo,
      subAppid,
      openid,
      timeoutExpressMin: 10,
    })
    console.log(`<<< code=${resp.code} msg=${resp.msg} ok=${resp.ok}`)
    console.log('<<< tradeNo =', resp.tradeNo)
    console.log('<<< logNo =', resp.logNo)
    console.log('<<< lakala_app_id =', resp.lakalaAppId, '(校验等于 sub_appid)')
    console.log('<<< paymentParams = {')
    for (const [k, v] of Object.entries(resp.paymentParams || {})) {
      console.log(`      ${k}: ${v && String(v).slice(0, 60)}${String(v).length > 60 ? '...' : ''}`)
    }
    console.log('    }')
    const pp = resp.paymentParams || {}
    const missingPp = ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign'].filter((k) => !pp[k])
    if (missingPp.length) {
      console.error('\n✗ FAIL —— wx.requestPayment 缺字段：', missingPp.join(','))
      process.exit(1)
    }
    if (resp.lakalaAppId && resp.lakalaAppId !== subAppid) {
      console.error(`\n✗ FAIL —— lakalaAppId=${resp.lakalaAppId} != sub_appid=${subAppid}`)
      process.exit(1)
    }
    console.log('\n✓ PASS —— preorder 下单 / BBS00000 成功码 / wx.requestPayment 5 字段 / app_id 一致校验 全通')
    process.exit(0)
  } catch (err) {
    console.error('\n✗ FAIL：', err.message)
    process.exit(1)
  }
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
