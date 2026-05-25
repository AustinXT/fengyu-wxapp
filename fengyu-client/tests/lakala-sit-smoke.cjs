/**
 * 拉卡拉 SIT/联调 smoke（手动跑，非 CI）—— 用真实环境变量对拉卡拉网关打一发收银台下单，
 * 验证：加签链路 / envelope / 字段类型 / 成功码 / counter_url / 响应验签 一次性全通。
 *
 * 用法（先把 LAKALA_* 注入环境，例如从 envs/dev.env 导出）：
 *   set -a; . envs/dev.env; set +a
 *   node fengyu-client/tests/lakala-sit-smoke.cjs
 * 可选覆盖：LAKALA_SMOKE_MERCHANT / LAKALA_SMOKE_TERM（默认取 LAKALA_DEFAULT_*）
 *
 * 复用生产同款 utils（含 PEM \n 归一化 + 响应验签），因此跑通即证明部署态可用。
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
  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT || cfg.defaultMerchantNo
  const termNo = process.env.LAKALA_SMOKE_TERM || cfg.defaultTermNo
  console.log(`>>> ${cfg.apiBase}  merchant=${merchantNo} term=${termNo}`)

  const reqData = {
    out_order_no: `SMOKE${Date.now()}`,
    merchant_no: merchantNo,
    term_no: termNo,
    total_amount: 100, // 数字（对齐 SDK V3CcssCounterOrderSpecialCreateRequest.totalAmount=Long）
    order_efficient_time: lakalaClient.formatReqTime(new Date(Date.now() + 10 * 60 * 1000)),
    notify_url: cfg.notifyUrl || 'https://run.mocky.io/v3/b02c9448-20a2-4ff6-a678-38ecab30161d',
    order_info: '凤御 SIT smoke',
    support_refund: 1,
    support_repeat_pay: 1,
    support_cancel: 0,
    counter_param: JSON.stringify({ pay_mode: 'WECHAT' }),
  }
  const resp = await lakalaClient.request({ path: '/v3/ccss/counter/order/special_create', reqData })
  console.log(`<<< code=${resp.code} msg=${resp.msg} ok=${resp.ok}`)
  if (resp.ok && resp.resp_data && resp.resp_data.counter_url) {
    console.log('<<< counter_url =', resp.resp_data.counter_url)
    console.log('<<< pay_order_no =', resp.resp_data.pay_order_no)
    console.log('\n✓ PASS —— 加签/envelope/字段类型/成功码/counter_url/响应验签 全通')
    process.exit(0)
  }
  console.error('\n✗ FAIL —— 下单未成功，见上方 code/msg')
  process.exit(1)
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
