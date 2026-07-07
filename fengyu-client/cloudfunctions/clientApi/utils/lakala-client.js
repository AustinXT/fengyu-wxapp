

'use strict'

const https = require('https')
const http = require('http')
const { URL } = require('url')
const { readConfig, assertReady } = require('./lakala-config')
const sign = require('./lakala-sign')

const DEFAULT_TIMEOUT_MS = 30000


function expectedSuccessCode(path) {
  if (/^\/?v\d+\/labs\//.test(path)) return 'BBS00000'
  return '000000'
}


function formatReqTime(date = new Date()) {
  
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


async function requestPreorder({
  merchantNo, termNo, outTradeNo,
  accountType, transType,
  totalAmountFen, requestIp,
  subject, attach,
  notifyUrl,
  subAppid, openid,
  timeoutExpressMin = 10,
}) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_TERM_NO_REQUIRED')  
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
    total_amount: String(totalAmountFen),  
    notify_url: notifyUrl || cfg.notifyUrl || '',
    subject: subject || `凤御美容订单 ${outTradeNo}`,
    location_info: { request_ip: requestIp || '0.0.0.0' },
  }

  
  const accBusi = {}
  if (accountType === 'WECHAT' && transType === '71') {
    
    if (!subAppid) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_SUB_APPID_REQUIRED')
    if (!openid) throw new Error('INVALID_PARAMS: LAKALA_PREORDER_OPENID_REQUIRED')
    accBusi.sub_appid = subAppid
    accBusi.user_id = openid
    accBusi.timeout_express = String(timeoutExpressMin)
    if (attach) accBusi.attach = String(attach).slice(0, 128)
  } else if (accountType === 'ALIPAY' && transType === '41') {
    
    accBusi.timeout_express = String(timeoutExpressMin)
  }
  if (Object.keys(accBusi).length > 0) {
    reqData.acc_busi_fields = accBusi
  }

  const resp = await request({ path: '/v3/labs/trans/preorder', reqData })
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
    
    result.alipayQrUrl = accResp.code || ''
  }

  return result
}


async function requestAlipayShareCode({
  merchantNo, termNo, outTradeNo,
  totalAmountFen, requestIp,
  source, bizLink, sellerId, codeValidPeriodSec,
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
      await new Promise((r) => setTimeout(r, 1000))  
    }
    try {
      const resp = await request({ path: '/v3/labs/trans/share_code', reqData })
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


async function queryTrade({ merchantNo, termNo, outTradeNo, tradeNo }) {
  if (!merchantNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_MERCHANT_NO_REQUIRED')
  if (!termNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_TERM_NO_REQUIRED')
  if (!outTradeNo && !tradeNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_OUT_TRADE_NO_OR_TRADE_NO_REQUIRED')

  const reqData = { merchant_no: merchantNo, term_no: termNo }
  if (tradeNo) reqData.trade_no = tradeNo
  else reqData.out_trade_no = outTradeNo

  const resp = await request({ path: '/v3/labs/query/tradequery', reqData })
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

module.exports = {
  request,
  formatReqTime,
  expectedSuccessCode,
  requestPreorder,
  requestAlipayShareCode,
  queryTrade,
}
