/**
 * 拉卡拉 HTTPS 请求封装（带加签 + 验签）
 *
 * 接入路径（聚合主扫为唯一支付下单通道）：
 *   - 聚合主扫：POST /v3/labs/trans/preorder         （成功码 BBS00000，微信小程序 trans_type=71 返回 wx.requestPayment 参数；支付宝 trans_type=41 返回二维码 URL）
 *   - 支付宝吱口令：POST /v3/labs/trans/share_code   （成功码 BBS00000，返回 share_token 给客户端「复制到支付宝」流程）
 *   - 交易查询：POST /v3/labs/query/tradequery      （成功码 BBS00000，trade_state=SUCCESS 才算实际到账）
 *
 * 注意：
 *   - 收银台 (/v3/ccss/counter/*) 接口已弃用（2026-05-29 全量切聚合主扫）。
 *   - 异步回调（payNotify）字段是聚合主扫规范：out_trade_no / trade_no / trade_state / account_type / acc_trade_no / payer_amount。
 *
 * 与 fengyu-client/cloudfunctions/payNotify/utils/lakala-client.js（仅用了 verify 部分）
 *    fengyu-staff/cloudfunctions/staffApi/utils/lakala-client.js
 *    fengyu-admin/src/lib/lakala-client.ts
 * 四份独立副本，跨端一致性靠 snapshot 测试守护。
 */

'use strict'

const https = require('https')
const http = require('http')
const { URL } = require('url')
const { readConfig, assertReady } = require('./lakala-config')
const sign = require('./lakala-sign')

const DEFAULT_TIMEOUT_MS = 30000

/**
 * 推断 endpoint 路径对应的成功码。
 *   /ccss/  → '000000'   (已废弃，仅保留兼容遗留代码)
 *   /rfd/   → '000000'   (admin 退款用)
 *   /labs/  → 'BBS00000' (聚合主扫 + 吱口令 + 查询)
 */
function expectedSuccessCode(path) {
  if (/^\/?v\d+\/labs\//.test(path)) return 'BBS00000'
  return '000000'
}

/**
 * yyyyMMddHHmmss 格式化（GMT+8）
 */
function formatReqTime(date = new Date()) {
  // 转 GMT+8
  const ms = date.getTime() + 8 * 3600 * 1000
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const M = String(d.getUTCMonth() + 1).padStart(2, '0')
  const D = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}${M}${D}${h}${m}${s}`
}

/**
 * 调拉卡拉接口（底层通用 POST）。
 */
async function request({ path, reqData, skipVerify = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertReady()
  const cfg = readConfig()

  const reqTime = formatReqTime()
  const envelope = {
    req_time: reqTime,
    version: '3.0',
    req_data: reqData || {},
  }

  const bodyStr = JSON.stringify(envelope)
  const { authorization } = sign.buildRequestAuthorization({
    appid: cfg.appid,
    serialNo: cfg.serialNo,
    privateKeyPem: cfg.privateKeyPem,
    body: bodyStr,
  })

  const url = new URL(cfg.apiBase + path)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
    },
  }

  const { rawBody, headers } = await new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ rawBody: buf.toString('utf8'), headers: res.headers, statusCode: res.statusCode })
      })
    })
    req.on('error', (err) => reject(new Error(`INVALID_STATE: LAKALA_REQUEST_FAILED: ${err.message}`)))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`INVALID_STATE: LAKALA_TIMEOUT_${timeoutMs}ms`))
    })
    req.write(bodyStr)
    req.end()
  })

  // 响应验签（同步 5 行格式）
  if (!skipVerify) {
    const verified = sign.verifyResponseSignature({
      headers,
      body: rawBody,
      platformCertPem: cfg.platformCertPem,
    })
    if (!verified) {
      const hasAnyLklHeader = Object.keys(headers || {}).some((k) => k.toLowerCase().startsWith('lklapi-'))
      if (hasAnyLklHeader) {
        throw new Error('INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH')
      }
      console.warn('[lakala] 响应无签名 Header，跳过验签：', path, rawBody.slice(0, 200))
    }
  }

  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    throw new Error(`INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: ${err.message}; body=${rawBody.slice(0, 200)}`)
  }

  const expectedCode = expectedSuccessCode(path)
  return {
    code: parsed.code,
    msg: parsed.msg,
    resp_time: parsed.resp_time,
    resp_data: parsed.resp_data || {},
    expectedCode,
    ok: parsed.code === expectedCode,
  }
}

/**
 * 聚合主扫预下单 /v3/labs/trans/preorder
 *
 * @param {object} opts
 * @param {string} opts.merchantNo    拉卡拉商户号（必填）
 * @param {string} opts.termNo        终端号（聚合主扫必填 M，调用方应做兜底）
 * @param {string} opts.outTradeNo    商户交易流水号（≤32 字符，唯一；项目用 `${saleOrderId}_${unixSec}` 30 字符规则）
 * @param {string} opts.accountType   钱包类型：WECHAT / ALIPAY / UQRCODEPAY ...
 * @param {string} opts.transType     接入方式：71 微信小程序 / 51 JSAPI / 41 NATIVE / 61 APP
 * @param {number} opts.totalAmountFen 金额（分，整数）
 * @param {string} opts.requestIp     客户端 IP（风控必送，拿不到送 '0.0.0.0'）
 * @param {string} opts.subject       订单标题（微信支付必送，≤42 字符）
 * @param {string} [opts.attach]      附加域（≤128 字符，回调原样回传，可放 saleOrderId）
 * @param {string} [opts.notifyUrl]   异步通知 URL（不传则用 env LAKALA_NOTIFY_URL）
 * @param {string} [opts.subAppid]    子商户公众账号 ID（微信小程序 71 必填，传 client 小程序 appid）
 * @param {string} [opts.openid]      用户 openid（微信小程序 71 必填，sub_openid）
 * @param {number} [opts.timeoutExpressMin=10] 预下单订单有效期（分钟，建议 ≤15）
 *
 * @returns {Promise<{
 *   ok: boolean, code: string, msg: string,
 *   tradeNo: string,           // 拉卡拉交易流水号
 *   logNo: string,             // 拉卡拉对账单流水号
 *   paymentParams?: object,    // 微信小程序：wx.requestPayment 5 字段（timeStamp/nonceStr/package/signType/paySign），不含 appId
 *   lakalaAppId?: string,      // 微信小程序：拉卡拉返回的 app_id（云函数侧校验等于 subAppid）
 *   alipayQrUrl?: string,      // 支付宝 NATIVE：二维码 URL（acc_resp_fields.code），喂给 share_code biz_link
 *   raw: object                // 原始 acc_resp_fields，便于联调日志
 * }>}
 */
async function requestPreorder({
  merchantNo, termNo, outTradeNo,
  accountType, transType,
  totalAmountFen, requestIp,
  subject, attach,
  notifyUrl,
  subAppid, openid,
  timeoutExpressMin = 10,
  timeoutMs,
}) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_TERM_NO_REQUIRED')  // 聚合主扫 term_no 必填
  if (!outTradeNo) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_OUT_TRADE_NO_REQUIRED')
  if (String(outTradeNo).length > 32) throw new Error('INVALID_PARAMS: LAKALA_OUT_TRADE_NO_TOO_LONG')
  if (!accountType || !transType) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_ACCOUNT_TRANS_TYPE_REQUIRED')
  if (!Number.isInteger(totalAmountFen) || totalAmountFen <= 0) {
    throw new Error('INVALID_PARAMS: LAKALA_PREORDER_TOTAL_AMOUNT_INVALID')
  }

  const cfg = readConfig()
  const reqData = {
    merchant_no: merchantNo,
    term_no: termNo,
    out_trade_no: outTradeNo,
    account_type: accountType,
    trans_type: transType,
    total_amount: String(totalAmountFen),  // 文档要求 String(12)
    notify_url: notifyUrl || cfg.notifyUrl || '',
    subject: subject || `凤御美容订单 ${outTradeNo}`,
    location_info: { request_ip: requestIp || '0.0.0.0' },
  }

  // acc_busi_fields 按场景拼装
  const accBusi = {}
  if (accountType === 'WECHAT' && transType === '71') {
    // 微信小程序必填 sub_appid + user_id
    if (!subAppid) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_SUB_APPID_REQUIRED')
    if (!openid) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_OPENID_REQUIRED')
    accBusi.sub_appid = subAppid
    accBusi.user_id = openid
    accBusi.timeout_express = String(timeoutExpressMin)
    if (attach) accBusi.attach = String(attach).slice(0, 128)
  } else if (accountType === 'ALIPAY' && transType === '41') {
    // 支付宝 NATIVE：可选 timeout_express
    accBusi.timeout_express = String(timeoutExpressMin)
  }
  if (Object.keys(accBusi).length > 0) {
    reqData.acc_busi_fields = accBusi
  }

  const resp = await request({ path: '/v3/labs/trans/preorder', reqData, timeoutMs })
  if (!resp.ok) {
    throw new Error(`INVALID_STATE: LAKALA_PREORDER_FAILED: ${resp.code} ${resp.msg || ''}`)
  }
  const accResp = resp.resp_data.acc_resp_fields || {}
  const result = {
    ok: true,
    code: resp.code,
    msg: resp.msg,
    tradeNo: resp.resp_data.trade_no,
    logNo: resp.resp_data.log_no,
    raw: accResp,
  }

  if (accountType === 'WECHAT' && transType === '71') {
    // 微信 wx.requestPayment 入参 5 字段（不含 appId，由小程序 context 决定）
    // 拉卡拉返回的字段是下划线（time_stamp/nonce_str/sign_type/pay_sign），需要转驼峰
    // package 防御性兜底：拉卡拉文档明确 package 已是 'prepay_id=xxx' 格式 String(128)；如果只返回 prepay_id 也兜底拼一次
    const packageStr = accResp.package
      ? String(accResp.package)
      : (accResp.prepay_id ? `prepay_id=${accResp.prepay_id}` : '')
    result.paymentParams = {
      timeStamp: String(accResp.time_stamp || ''),
      nonceStr: String(accResp.nonce_str || ''),
      package: packageStr,
      signType: String(accResp.sign_type || 'RSA'),
      paySign: String(accResp.pay_sign || ''),
    }
    result.lakalaAppId = accResp.app_id || ''
  } else if (accountType === 'ALIPAY' && transType === '41') {
    // 支付宝 NATIVE：返回二维码 URL（acc_resp_fields.code）
    result.alipayQrUrl = accResp.code || ''
  }

  return result
}

/**
 * 申请支付宝吱口令 /v3/labs/trans/share_code
 *
 * 用法：先调 requestPreorder({ accountType: 'ALIPAY', transType: '41' }) 拿 alipayQrUrl，
 * 再调本接口（同一 outTradeNo + 同金额），把 alipayQrUrl 作为 biz_link 喂入，拿到 shareToken。
 *
 * 失败重试：第一次失败延迟 1s 重试 1 次，二次失败抛 LAKALA_SHARE_CODE_FAILED。
 *
 * @param {object} opts
 * @param {string} opts.merchantNo
 * @param {string} opts.termNo
 * @param {string} opts.outTradeNo
 * @param {number} opts.totalAmountFen
 * @param {string} opts.requestIp
 * @param {string} opts.source         业务来源（ISV 公司名缩写，由 env LAKALA_ALIPAY_SHARE_SOURCE 提供，未配置时调用方应阻断）
 * @param {string} opts.bizLink        支付页面 URL（来自 preorder 的 alipayQrUrl）
 * @param {string} [opts.sellerId]     卖家支付宝 ID（可选）
 * @param {number} [opts.codeValidPeriodSec]  码有效期（秒，不传则永久）
 *
 * @returns {Promise<{ tradeNo: string, shareToken: string, expireDate: string }>}
 */
async function requestAlipayShareCode({
  merchantNo, termNo, outTradeNo,
  totalAmountFen, requestIp,
  source, bizLink, sellerId, codeValidPeriodSec,
  timeoutMs,
}) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_SHARE_CODE_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_SHARE_CODE_TERM_NO_REQUIRED')
  if (!outTradeNo) throw new Error('INVALID_PARAMS: LAKALA_SHARE_CODE_OUT_TRADE_NO_REQUIRED')
  if (!source) throw new Error('INVALID_PARAMS: LAKALA_SHARE_CODE_SOURCE_REQUIRED')
  if (!bizLink) throw new Error('INVALID_PARAMS: LAKALA_SHARE_CODE_BIZ_LINK_REQUIRED')

  const reqData = {
    merchant_no: merchantNo,
    term_no: termNo,
    out_trade_no: outTradeNo,
    account_type: 'ALIPAY',
    total_amount: String(totalAmountFen),
    location_info: { request_ip: requestIp || '0.0.0.0' },
    acc_busi_fields: {
      source,
      biz_link: bizLink,
    },
  }
  if (sellerId) reqData.acc_busi_fields.seller_id = sellerId
  if (codeValidPeriodSec) reqData.code_valid_period = String(codeValidPeriodSec)

  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000))  // 1s 退避
    }
    try {
      const resp = await request({ path: '/v3/labs/trans/share_code', reqData, timeoutMs })
      if (!resp.ok) {
        lastErr = new Error(`INVALID_STATE: LAKALA_SHARE_CODE_FAILED: ${resp.code} ${resp.msg || ''}`)
        continue
      }
      const accResp = resp.resp_data.acc_resp_fields || {}
      return {
        tradeNo: resp.resp_data.trade_no,
        shareToken: accResp.share_token || '',
        expireDate: accResp.expire_date || '',
      }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * 交易查询 /v3/labs/query/tradequery
 *
 * 仅 trade_state='SUCCESS' 表示真实到账；code='BBS00000' 只说明查到了交易。
 *
 * @returns {Promise<{
 *   ok: boolean, code: string, msg: string,
 *   tradeState: string,        // INIT/CREATE/SUCCESS/FAIL/DEAL/UNKNOWN/CLOSE/PART_REFUND/REFUND
 *   tradeNo: string, accTradeNo: string, payMode: string,
 *   totalAmountFen: number, payerAmountFen: number,
 *   raw: object
 * }>}
 */
async function queryTrade({ merchantNo, termNo, outTradeNo, tradeNo, timeoutMs }) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_TERM_NO_REQUIRED')
  if (!outTradeNo && !tradeNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_OUT_TRADE_NO_OR_TRADE_NO_REQUIRED')

  const reqData = { merchant_no: merchantNo, term_no: termNo }
  if (tradeNo) reqData.trade_no = tradeNo
  else reqData.out_trade_no = outTradeNo

  const resp = await request({ path: '/v3/labs/query/tradequery', reqData, timeoutMs })
  const data = resp.resp_data || {}
  const accResp = data.acc_resp_fields || {}
  return {
    ok: resp.ok,
    code: resp.code,
    msg: resp.msg,
    tradeState: data.trade_state || '',
    tradeNo: data.trade_no || '',
    accTradeNo: data.acc_trade_no || '',
    payMode: data.pay_mode || data.account_type || '',
    totalAmountFen: Number(data.total_amount || 0),
    payerAmountFen: Number(data.payer_amount || 0),
    raw: { ...data, acc_resp_fields: accResp },
  }
}

/**
 * 关单 /v3/labs/relation/close
 *
 * 把渠道侧尚未支付的单置为终态（trade_state=CLOSE），使其此后不可再被支付。
 * 这是「顾客未付款可立即取消」的前提：不关单就本地关闭订单，顾客手机上残留的
 * 支付面板仍可付款，payNotify 会因「非当前拉卡拉意图」拒绝入账 → 钱收了订单不动。
 *
 * ⚠️ 本接口**不返回**可信终态的保证：调用方必须在关单后再 queryTrade 复核为
 * 可释放终态，复核不过一律不释放本地意图（fail-closed）。因此即使拉卡拉后续调整
 * 字段规范导致本请求失败，也只会退回「关不掉、请稍后重试」的现状，不会制造资金窟窿。
 *
 * 字段按 relation 类接口的「原交易标识三选一」规则（与 /v3/labs/relation/refund 同族）：
 * origin_trade_no > origin_out_trade_no，传其一即可。
 */
async function closeTrade({ merchantNo, termNo, outTradeNo, tradeNo, timeoutMs }) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_CLOSE_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_CLOSE_TERM_NO_REQUIRED')
  if (!outTradeNo && !tradeNo) throw new Error('INVALID_PARAMS: LAKALA_CLOSE_OUT_TRADE_NO_OR_TRADE_NO_REQUIRED')

  const reqData = { merchant_no: merchantNo, term_no: termNo }
  if (tradeNo) reqData.origin_trade_no = tradeNo
  else reqData.origin_out_trade_no = outTradeNo

  const resp = await request({ path: '/v3/labs/relation/close', reqData, timeoutMs })
  const data = resp.resp_data || {}
  return {
    ok: resp.ok,
    code: resp.code,
    msg: resp.msg,
    tradeState: data.trade_state || '',
    raw: data,
  }
}

module.exports = {
  request,
  formatReqTime,
  expectedSuccessCode,
  requestPreorder,
  requestAlipayShareCode,
  queryTrade,
  closeTrade,
}
