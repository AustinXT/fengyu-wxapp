/**
 * 拉卡拉 HTTPS 客户端（admin TypeScript 副本）
 *
 * 与 fengyu-client/cloudfunctions/clientApi/utils/lakala-client.js 字面量等价；
 * admin 用 Node 内置 crypto + https + URL，无需额外依赖。
 *
 * 当前接入路径：
 *   - 退款：POST /api/v3/rfd/refund_front/refund        （成功码 '000000'，异步 trade_state）
 *   - 退款查询：POST /api/v3/rfd/refund_front/refund_query
 *
 * **注意**：本期仅提供 helper；将其挂接到 refunds.ts approveRefund 是独立 follow-up，
 * 需要同步处理拉卡拉响应的异步 trade_state (SUCCESS/PROCESSING/FAIL) → sale_order_payments.status 状态机。
 *
 * 加签算法详见 sources/documents/拉卡拉接口规范-补充.md「安全统一接入规范」。
 */

import * as crypto from 'node:crypto'
import * as https from 'node:https'
import { URL } from 'node:url'

const ALGORITHM_LABEL = 'LKLAPI-SHA256withRSA'
const DEFAULT_TIMEOUT_MS = 30000

interface LakalaEnv {
  apiBase: string
  appid: string
  serialNo: string
  privateKeyPem: string
  platformCertPem: string
  defaultMerchantNo: string
  defaultTermNo: string
  notifyUrl: string
}

function readEnv(): LakalaEnv {
  return {
    apiBase: (process.env.LAKALA_API_BASE || '').replace(/\/+$/, ''),
    appid: process.env.LAKALA_APPID || '',
    serialNo: process.env.LAKALA_SERIAL_NO || '',
    privateKeyPem: process.env.LAKALA_PRIVATE_KEY_PEM || '',
    platformCertPem: process.env.LAKALA_PLATFORM_CERT_PEM || '',
    defaultMerchantNo: process.env.LAKALA_DEFAULT_MERCHANT_NO || '',
    defaultTermNo: process.env.LAKALA_DEFAULT_TERM_NO || '',
    notifyUrl: process.env.LAKALA_NOTIFY_URL || '',
  }
}

export function isReady(): boolean {
  const env = readEnv()
  return !!(
    env.apiBase &&
    env.appid &&
    env.serialNo &&
    env.privateKeyPem &&
    env.platformCertPem &&
    env.defaultMerchantNo &&
    env.defaultTermNo
  )
}

function randomNonce(length = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const buf = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length]
  return out
}

function buildAuthorization(body: string, env: LakalaEnv): string {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = randomNonce(12)
  const target = `${env.appid}\n${env.serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(target, 'utf8')
  signer.end()
  const signature = signer.sign(env.privateKeyPem, 'base64')
  return `${ALGORITHM_LABEL} appid="${env.appid}",serial_no="${env.serialNo}",timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`
}

function verifyResponseSignature(headers: Record<string, string | string[] | undefined>, body: string, platformCertPem: string): boolean {
  if (!platformCertPem) return false
  const h: Record<string, string> = {}
  for (const k of Object.keys(headers || {})) {
    const v = headers[k]
    h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v || ''
  }
  const appid = h['lklapi-appid'] || ''
  const serialNo = h['lklapi-serial'] || ''
  const timestamp = h['lklapi-timestamp'] || ''
  const nonceStr = h['lklapi-nonce'] || ''
  const signature = h['lklapi-signature'] || ''
  if (!signature) return false
  const target = `${appid}\n${serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`
  try {
    const verifier = crypto.createVerify('RSA-SHA256')
    verifier.update(target, 'utf8')
    verifier.end()
    return verifier.verify(platformCertPem, signature, 'base64')
  } catch {
    return false
  }
}

function formatReqTime(date = new Date()): string {
  const ms = date.getTime() + 8 * 3600 * 1000
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

function expectedSuccessCode(path: string): string {
  if (/^\/?v\d+\/labs\//.test(path)) return 'BBS00000'
  return '000000'
}

interface RequestOpts {
  path: string
  reqData: Record<string, unknown>
  outOrgCode?: string
  timeoutMs?: number
}

interface RequestResponse {
  code: string
  msg: string
  resp_time: string
  resp_data: Record<string, unknown>
  expectedCode: string
  ok: boolean
}

export async function request({ path, reqData, outOrgCode, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOpts): Promise<RequestResponse> {
  const env = readEnv()
  if (!isReady()) {
    throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED')
  }
  const envelope: Record<string, unknown> = {
    req_time: formatReqTime(),
    version: '3.0',
    req_data: reqData,
  }
  if (outOrgCode) envelope.out_org_code = outOrgCode
  const bodyStr = JSON.stringify(envelope)
  const authorization = buildAuthorization(bodyStr, env)

  const url = new URL(env.apiBase + path)
  const options: https.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + (url.search || ''),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
    },
  }

  const { rawBody, headers } = await new Promise<{ rawBody: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ rawBody: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
      })
    })
    req.on('error', (err) => reject(new Error(`INVALID_STATE: LAKALA_REQUEST_FAILED: ${err.message}`)))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`INVALID_STATE: LAKALA_TIMEOUT_${timeoutMs}ms`))
    })
    req.write(bodyStr)
    req.end()
  })

  const hasAnyLklHeader = Object.keys(headers || {}).some((k) => k.toLowerCase().startsWith('lklapi-'))
  if (hasAnyLklHeader) {
    const verified = verifyResponseSignature(headers, rawBody, env.platformCertPem)
    if (!verified) throw new Error('INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH')
  }

  let parsed: { code: string; msg: string; resp_time: string; resp_data?: Record<string, unknown> }
  try {
    parsed = JSON.parse(rawBody)
  } catch (err: any) {
    throw new Error(`INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: ${err.message}`)
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
 * 统一退货：POST /api/v3/rfd/refund_front/refund
 * 详见 sources/documents/拉卡拉接口规范-补充.md「退货（统一退货，推荐用）」一节。
 *
 * 返回 trade_state：SUCCESS（同步成功）/ PROCESSING / DEAL / TIMEOUT / INIT（异步，需查询确认）/ FAIL / EXCEPTION
 */
export async function requestRefund(opts: {
  merchantNo: string
  termNo: string
  outTradeNo: string                 // 商户退款流水号（唯一）
  refundAmountFen: number            // 分
  refundReason?: string
  originTradeNo?: string             // 原拉卡拉交易流水（优先）
  originOutTradeNo?: string          // 原商户流水
  originLogNo?: string               // 原对账单流水号
  requestIp: string                  // admin 操作人 IP（风控必送）
  location?: string                  // 经纬度（门店经纬度兜底）
}): Promise<{ tradeState: string; tradeNo: string; logNo: string; payerAmountFen: number; channelRetDesc: string; raw: Record<string, unknown> }> {
  if (!opts.originTradeNo && !opts.originOutTradeNo && !opts.originLogNo) {
    throw new Error('INVALID_PARAMS: REFUND_NEEDS_ORIGIN_REFERENCE')
  }
  const env = readEnv()
  const reqData: Record<string, unknown> = {
    merchant_no: opts.merchantNo,
    term_no: opts.termNo,
    out_trade_no: opts.outTradeNo,
    refund_amount: String(opts.refundAmountFen),
    refund_acc_mode: '00',
    refund_amt_sts: '00',
    notify_url: env.notifyUrl,
    location_info: {
      request_ip: opts.requestIp,
      location: opts.location || '',
    },
  }
  if (opts.refundReason) reqData.refund_reason = opts.refundReason
  if (opts.originTradeNo) reqData.origin_trade_no = opts.originTradeNo
  if (opts.originOutTradeNo) reqData.origin_out_trade_no = opts.originOutTradeNo
  if (opts.originLogNo) reqData.origin_log_no = opts.originLogNo

  const resp = await request({
    path: '/v3/rfd/refund_front/refund',
    reqData,
  })
  if (!resp.ok) {
    throw new Error(`INVALID_STATE: LAKALA_REFUND_FAILED: ${resp.code} ${resp.msg || ''}`)
  }
  const data = resp.resp_data as Record<string, string>
  return {
    tradeState: data.trade_state,
    tradeNo: data.trade_no,
    logNo: data.log_no,
    payerAmountFen: Number(data.payer_amount || 0),
    channelRetDesc: data.channel_ret_desc || '',
    raw: data,
  }
}

/**
 * 统一退货查询：POST /api/v3/rfd/refund_front/refund_query
 * 用于 cron 推进 PROCESSING/TIMEOUT 状态的退款；约束：超时未知 → 30s 后再查。
 */
export async function queryRefund(opts: {
  merchantNo: string
  termNo: string
  outTradeNo?: string
  tradeNo?: string
}): Promise<{ tradeState: string; channelRetDesc: string; payerAmountFen: number; raw: Record<string, unknown> }> {
  if (!opts.outTradeNo && !opts.tradeNo) {
    throw new Error('INVALID_PARAMS: REFUND_QUERY_NEEDS_KEY')
  }
  const reqData: Record<string, unknown> = {
    merchant_no: opts.merchantNo,
    term_no: opts.termNo,
  }
  if (opts.outTradeNo) reqData.out_trade_no = opts.outTradeNo
  if (opts.tradeNo) reqData.trade_no = opts.tradeNo

  const resp = await request({
    path: '/v3/rfd/refund_front/refund_query',
    reqData,
  })
  if (!resp.ok) {
    throw new Error(`INVALID_STATE: LAKALA_REFUND_QUERY_FAILED: ${resp.code} ${resp.msg || ''}`)
  }
  const data = resp.resp_data as Record<string, string>
  return {
    tradeState: data.trade_state,
    channelRetDesc: data.channel_ret_desc || '',
    payerAmountFen: Number(data.payer_amount || 0),
    raw: data,
  }
}
