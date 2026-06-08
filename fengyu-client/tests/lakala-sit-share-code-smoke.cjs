/**
 * 拉卡拉支付宝吱口令 SIT smoke（手动跑，非 CI）—— 串调 preorder(ALIPAY/41) + share_code，
 * 验证：支付宝 NATIVE 拿二维码 URL → share_code 拿 share_token 完整链路。
 *
 * 用法：
 *   set -a; . envs/dev.env; set +a
 *   node fengyu-client/tests/lakala-sit-share-code-smoke.cjs
 *
 * 前置：env 必须配置 LAKALA_ALIPAY_SHARE_SOURCE（由拉卡拉商务对接确认值）；
 *       未配置时本脚本会跳过 share_code 步骤并 exit 2。
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
  if (!cfg.alipayShareSource) {
    console.error('✗ LAKALA_ALIPAY_SHARE_SOURCE 未配置（拉卡拉商务对接确认后填入 envs/<active>.env）')
    console.error('  alipayPay 现状会自动报 ALIPAY_NOT_AVAILABLE，前端引导用户改用微信')
    process.exit(2)
  }

  const merchantNo = process.env.LAKALA_SMOKE_MERCHANT
  const termNo = process.env.LAKALA_SMOKE_TERM
  if (!merchantNo || !termNo) {
    console.error('✗ 必须显式传 LAKALA_SMOKE_MERCHANT 和 LAKALA_SMOKE_TERM（一店一商户，env 不留默认）')
    process.exit(2)
  }
  console.log(`>>> ${cfg.apiBase}/v3/labs/trans/preorder (ALIPAY/41)`)
  console.log(`    merchant=${merchantNo} term=${termNo}`)
  console.log(`    alipay_share_source=${cfg.alipayShareSource}`)

  const outTradeNo = `SMOKE${Date.now()}`
  try {
    // 步骤 1: preorder(ALIPAY, NATIVE=41) 拿二维码 URL
    const preorderResp = await lakalaClient.requestPreorder({
      merchantNo,
      termNo,
      outTradeNo,
      accountType: 'ALIPAY',
      transType: '41',
      totalAmountFen: 1,
      requestIp: '0.0.0.0',
      subject: '凤御 SIT 吱口令烟测',
      timeoutExpressMin: 10,
    })
    console.log(`<<< preorder: code=${preorderResp.code} tradeNo=${preorderResp.tradeNo}`)
    console.log('<<< alipayQrUrl =', preorderResp.alipayQrUrl)
    if (!preorderResp.alipayQrUrl) {
      console.error('\n✗ FAIL —— preorder 未返回 alipayQrUrl')
      process.exit(1)
    }

    // 步骤 2: share_code 用 alipayQrUrl 作为 biz_link 换取吱口令
    console.log(`\n>>> ${cfg.apiBase}/v3/labs/trans/share_code`)
    const shareResp = await lakalaClient.requestAlipayShareCode({
      merchantNo,
      termNo,
      outTradeNo,  // 同一笔商户流水号
      totalAmountFen: 1,
      requestIp: '0.0.0.0',
      source: cfg.alipayShareSource,
      bizLink: preorderResp.alipayQrUrl,
    })
    console.log(`<<< share_code: tradeNo=${shareResp.tradeNo}`)
    console.log('<<< share_token =', shareResp.shareToken)
    console.log('<<< expire_date =', shareResp.expireDate || '(永久)')
    if (!shareResp.shareToken) {
      console.error('\n✗ FAIL —— share_code 未返回 share_token')
      process.exit(1)
    }
    console.log('\n✓ PASS —— preorder(ALIPAY/41) + share_code 串调全通；前端可把 share_token 给用户复制')
    process.exit(0)
  } catch (err) {
    console.error('\n✗ FAIL：', err.message)
    process.exit(1)
  }
}
main().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1) })
