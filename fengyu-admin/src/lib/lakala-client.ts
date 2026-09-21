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

// TODO Phase 3F: switch to '@/lib/lakala-redact' once Phase 1A merged.
// 临时占位：本地 identity 函数，等 Phase 1A 的 lakala-redact.ts 合入后，
// 替换为 `import { redact } from '@/lib/lakala-redact'`。
const redact = (x: unknown): unknown => x

const ALGORITHM_LABEL = 'LKLAPI-SHA256withRSA'
const DEFAULT_TIMEOUT_MS = 30000

interface LakalaEnv {
  apiBase: string
  appid: string
  serialNo: string
  privateKeyPem: string
  platformCertPem: string
  notifyUrl: string
}

/**
 * PEM 换行归一化：部分部署/加载链路（dotenv 未展开、cloudbaserc 单行写法等）会把换行存成
 * 字面量 "\n"，Node crypto 只认真实换行，否则报 `DECODER routines::unsupported` 导致加签/验签失败。
 * 与三端云函数 lakala-config.js 的 normalizePem 同义（幂等：真实换行不受影响）。
 */
function normalizePem(s: string): string {
  return (s || '').replace(/\\n/g, '\n')
}

function readEnv(): LakalaEnv {
  return {
    apiBase: (process.env.LAKALA_API_BASE || '').replace(/\/+$/, ''),
    appid: process.env.LAKALA_APPID || '',
    serialNo: process.env.LAKALA_SERIAL_NO || '',
    privateKeyPem: normalizePem(process.env.LAKALA_PRIVATE_KEY_PEM || ''),
    platformCertPem: normalizePem(process.env.LAKALA_PLATFORM_CERT_PEM || ''),
    notifyUrl: process.env.LAKALA_NOTIFY_URL || '',
  }
}

/**
 * 加签 env 就绪检查。
 *
 * 含义 = "加签私钥/平台证书/appid/序列号/基地址" 五项齐全；
 * 不再检查 defaultMerchantNo/defaultTermNo（一店一商户原则，商户号/终端号从 stores 表查，
 * env 不留默认；2026-05-29 PR-6 清理）。
 *
 * 用法：admin 退款 (refunds.ts:refundViaLakalaIfEnabled) 调一次决定是否走拉卡拉退款通道。
 */
export function isReady(): boolean {
  const env = readEnv()
  return !!(
    env.apiBase &&
    env.appid &&
    env.serialNo &&
    env.privateKeyPem &&
    env.platformCertPem
  )
}

/**
 * 入网相关方法所需的最小 env 校验（与 isReady 内容一致；保留独立函数仅为语义清晰）。
 *
 * **PEM 配置 fail-fast 改懒加载**：仅在 `request()` 首次被调用时执行；
 * 模块 import 期不抛错，避免 admin docker build 阶段缺 LAKALA_PRIVATE_KEY_PEM
 * 导致 next build 中断（参考 [admin-build-jwt-secret-placeholder] 同款坑）。
 */
function assertLakalaReady(): void {
  const env = readEnv()
  if (!env.apiBase || !env.appid || !env.serialNo || !env.privateKeyPem || !env.platformCertPem) {
    throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED')
  }
  // 强制提前解析 PEM 头/尾，若 env 里写的是字面量 "\n" 未展开 → 立刻失败
  if (!/-----BEGIN[\s\S]+?-----/.test(env.privateKeyPem)) {
    throw new Error('INVALID_STATE: LAKALA_PRIVATE_KEY_PEM_FORMAT')
  }
  if (!/-----BEGIN[\s\S]+?-----/.test(env.platformCertPem)) {
    throw new Error('INVALID_STATE: LAKALA_PLATFORM_CERT_PEM_FORMAT')
  }
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

/**
 * 验证拉卡拉响应/回调签名。
 *
 * **Phase 1C 改动**：从 internal 改为 export，让 admin 的回调 Route Handler
 * （`/api/lakala/callback/*`）复用同一份验签实现，避免散落两份验签代码。
 *
 * Header 约定（小写后）：
 *   lklapi-appid / lklapi-serial / lklapi-timestamp / lklapi-nonce / lklapi-signature
 *
 * 签名串：`${appid}\n${serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`
 */
export function verifyResponseSignature(headers: Record<string, string | string[] | undefined>, body: string, platformCertPem: string): boolean {
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

export async function request({
  path,
  reqData,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RequestOpts): Promise<RequestResponse> {
  // PEM 配置 fail-fast 改懒加载（首次 request 才校验）。
  assertLakalaReady()
  const env = readEnv()

  const envelope = {
    req_time: formatReqTime(),
    version: '3.0',
    req_data: reqData,
  }
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

  let parsedRaw: Record<string, unknown>
  try {
    parsedRaw = JSON.parse(rawBody)
  } catch (err: any) {
    throw new Error(`INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: ${err.message}`)
  }

  // v3 响应：{ code, msg, resp_time, resp_data }；网关层异常（如 GW0004 / GW0001）也走 { code, message } 顶层结构。
  const code = String(parsedRaw.code ?? '')
  const msg = String(parsedRaw.msg ?? parsedRaw.message ?? '')
  const respTime = String(parsedRaw.resp_time ?? '')
  const respData = (parsedRaw.resp_data as Record<string, unknown>) || {}

  const expectedCode = expectedSuccessCode(path)
  // 出口经 redact（Phase 1A 合入后切真实 mask；当前为 identity 占位）。
  const safeRespData = redact(respData) as Record<string, unknown>

  return {
    code,
    msg,
    resp_time: respTime,
    resp_data: safeRespData,
    expectedCode,
    ok: code === expectedCode,
  }
}

/**
 * 交易查询：POST /v3/labs/query/tradequery
 *
 * trade_state 官方取值：INIT / CREATE / SUCCESS / FAIL / DEAL / UNKNOWN / CLOSE /
 * PART_REFUND / REFUND / REVOKED。只有 SUCCESS 才算实际到账。
 *
 * 与 clientApi/payNotify 的 utils/lakala-client.js 同源副本，改一端须同步其余端。
 */
export async function queryTrade(opts: {
  merchantNo: string
  termNo: string
  outTradeNo?: string
  tradeNo?: string
  timeoutMs?: number
}): Promise<{ ok: boolean; code: string; msg: string; tradeState: string; tradeNo: string; totalAmountFen: number }> {
  if (!opts.merchantNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_MERCHANT_NO_REQUIRED')
  if (!opts.termNo) throw new Error('INVALID_PARAMS: LAKALA_QUERY_TERM_NO_REQUIRED')
  if (!opts.outTradeNo && !opts.tradeNo) {
    throw new Error('INVALID_PARAMS: LAKALA_QUERY_OUT_TRADE_NO_OR_TRADE_NO_REQUIRED')
  }

  const reqData: Record<string, unknown> = { merchant_no: opts.merchantNo, term_no: opts.termNo }
  if (opts.tradeNo) reqData.trade_no = opts.tradeNo
  else reqData.out_trade_no = opts.outTradeNo

  const resp = await request({ path: '/v3/labs/query/tradequery', reqData, timeoutMs: opts.timeoutMs })
  const data = resp.resp_data || {}
  return {
    ok: resp.ok,
    code: resp.code,
    msg: resp.msg,
    tradeState: String(data.trade_state ?? ''),
    tradeNo: String(data.trade_no ?? ''),
    totalAmountFen: Number(data.total_amount ?? 0),
  }
}

/**
 * 关单：POST /v3/labs/relation/close
 *
 * 把渠道侧尚未支付的单置为终态，使其此后不可再被支付——这是「未付款可立即关闭订单」
 * 的前提：不关单就本地关闭，顾客残留的支付面板仍可付款，payNotify 会因「非当前意图」
 * 拒绝入账 → 钱收了订单不动。
 *
 * ⚠️ 本接口返回成功**不等于**渠道已终态，调用方必须再 queryTrade 复核（见 orders.ts
 * 的 voidActiveOnlinePaymentIntent）。因此即使字段规范有出入导致请求失败，也只会退回
 * 「关不掉、请稍后重试」的现状，不会制造资金窟窿。
 *
 * 字段按 relation 类接口的「原交易标识三选一」规则（与 requestRefund 同族）。
 */
export async function closeTrade(opts: {
  merchantNo: string
  termNo: string
  outTradeNo?: string
  tradeNo?: string
  timeoutMs?: number
}): Promise<{ ok: boolean; code: string; msg: string; tradeState: string }> {
  if (!opts.merchantNo) throw new Error('INVALID_PARAMS: LAKALA_CLOSE_MERCHANT_NO_REQUIRED')
  if (!opts.termNo) throw new Error('INVALID_PARAMS: LAKALA_CLOSE_TERM_NO_REQUIRED')
  if (!opts.outTradeNo && !opts.tradeNo) {
    throw new Error('INVALID_PARAMS: LAKALA_CLOSE_OUT_TRADE_NO_OR_TRADE_NO_REQUIRED')
  }

  const reqData: Record<string, unknown> = { merchant_no: opts.merchantNo, term_no: opts.termNo }
  if (opts.tradeNo) reqData.origin_trade_no = opts.tradeNo
  else reqData.origin_out_trade_no = opts.outTradeNo

  const resp = await request({ path: '/v3/labs/relation/close', reqData, timeoutMs: opts.timeoutMs })
  const data = resp.resp_data || {}
  return {
    ok: resp.ok,
    code: resp.code,
    msg: resp.msg,
    tradeState: String(data.trade_state ?? ''),
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
