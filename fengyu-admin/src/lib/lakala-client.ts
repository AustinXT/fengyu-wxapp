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
function assertOnboardingReady(): void {
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
  outOrgCode?: string
  timeoutMs?: number
  /**
   * 包络格式：
   *   - 'v3'（默认）：`{ req_time, version: '3.0', req_data }` 响应 `{ code, msg, resp_time, resp_data }`
   *     用于支付/退款（v3）以及拉卡拉电子合同三接口（apply/q_status/download，path 走 v3 前缀）。
   *   - 'v2'：`{ ver: '1.0.0', timestamp, reqId, reqData }` 响应 `{ retCode, retMsg, respData }`
   *     用于附件上传 / 商户进件 / 进件查询 / 复议 / 报备查询 / 信息变更 / 微信支付宝实名 等
   *     所有 `/api/v2/mms/...` 入网接口。
   *
   * 见 docs/lakala-onboarding-endpoints.md 「文档元信息」表与公共参数节。
   */
  envelope?: 'v2' | 'v3'
  /**
   * reqId 幂等提示：
   *   入网接口 v2 envelope 强制需要 `reqId` 字段；server action（Phase 2D）
   *   持久化每个 endpoint 的上次未确认成功 reqId 到 `lakala_merchants.last_req_ids[endpoint]`，
   *   重试时通过此参数传入复用，保证拉卡拉端幂等（不会产生两笔进件）。
   *   留空则随机生成 32 位串（仅适用于首次提交）。
   *
   * client 内部不直接读 DB；由调用方（Phase 2D actions）查表并注入。
   */
  reqIdHint?: string
}

interface RequestResponse {
  code: string
  msg: string
  resp_time: string
  resp_data: Record<string, unknown>
  expectedCode: string
  ok: boolean
  /** v2/v3 实际使用的 reqId（仅 v2 envelope 有值，调用方写回 DB 用于幂等复用） */
  reqId?: string
}

/**
 * 生成 v2 envelope 用的 32 位 reqId（数字+字母）。
 */
function makeReqId(): string {
  return crypto.randomBytes(16).toString('hex') // 32 hex chars
}

export async function request({
  path,
  reqData,
  outOrgCode,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  envelope: envType = 'v3',
  reqIdHint,
}: RequestOpts): Promise<RequestResponse> {
  // PEM 配置 fail-fast 改懒加载（首次 request 才校验）。
  assertOnboardingReady()
  const env = readEnv()

  let envelope: Record<string, unknown>
  let reqId: string | undefined
  if (envType === 'v3') {
    envelope = {
      req_time: formatReqTime(),
      version: '3.0',
      req_data: reqData,
    }
    if (outOrgCode) envelope.out_org_code = outOrgCode
  } else {
    // v2 入网接口
    reqId = reqIdHint || makeReqId()
    envelope = {
      reqData,
      ver: '1.0.0',
      timestamp: String(Date.now()),
      reqId,
    }
    if (outOrgCode) envelope.out_org_code = outOrgCode
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

  // v3: { code, msg, resp_time, resp_data }
  // v2: { retCode, retMsg, respData }
  // 网关层异常（如 GW0004 / GW0001）不论 envType 都返回 v3 风格的 { code, message } 顶层结构，
  // v2 解析若仅看 retCode 会把 SIT/网关错误吃成空字符串，掩盖真错误。所以 v2 解析时也对
  // `code` / `message` 兜底，让网关层错误能透出。
  let code: string
  let msg: string
  let respData: Record<string, unknown>
  let respTime: string
  if (envType === 'v3') {
    code = String(parsedRaw.code ?? '')
    msg = String(parsedRaw.msg ?? parsedRaw.message ?? '')
    respTime = String(parsedRaw.resp_time ?? '')
    respData = (parsedRaw.resp_data as Record<string, unknown>) || {}
  } else {
    code = String(parsedRaw.retCode ?? parsedRaw.code ?? '')
    msg = String(parsedRaw.retMsg ?? parsedRaw.msg ?? parsedRaw.message ?? '')
    respTime = ''
    respData = (parsedRaw.respData as Record<string, unknown>) || {}
  }

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
    reqId,
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

// ===========================================================================
// 入网 (Onboarding) API
// ===========================================================================
// 16 个方法对应 docs/lakala-onboarding-endpoints.md §2-§16 + 商户信息变更。
//
// 端点分两类：
//   v3 电子合同（apply / q_status / download）：
//     path 前缀 `/api/v3/mms/open_api/ec/...`，envelope='v3'，成功码 '000000'。
//   v2 入网（附件/进件/查询/复议/报备/微信支付宝实名/信息变更）：
//     path 前缀 `/api/v2/mms/...`，envelope='v2'，成功码 '000000'。
//
// **费率信息**（feeData）只在 submitMerchant / updateLakalaMerchantInfo 出现，
// 由调用方（server action）通过 `loadRateConfig()` 注入 reqData.feeData，
// **不**在方法 TS 签名上暴露（plan §0★ 费率全 admin 不可见），强制 server 内部链路。
//
// reqId 幂等：v2 envelope 自动管理；调用方传 `reqIdHint` 复用历史 reqId
// （见 `lakala_merchants.last_req_ids[endpoint]`，由 Phase 2D actions 写入）。
// ===========================================================================

export interface OnboardingCommonOpts {
  /** reqId 幂等提示，由 server action 从 lakala_merchants.last_req_ids 读取 */
  reqIdHint?: string
}

// ---- §2 电子合同申请 ------------------------------------------------------

export interface ApplyContractInput extends OnboardingCommonOpts {
  orderNo: string
  orgId: number
  ecTypeCode: string // EC015 / EC010 等
  certType: string // RESIDENT_ID / PASSPORT / HK_MACAO_PASS / TAIWAN_PASS
  certName: string
  certNo: string
  mobile: string
  businessLicenseNo?: string
  businessLicenseName?: string
  openningBankCode: string
  openningBankName: string
  acctTypeCode: string // 57 / 58
  acctNo: string
  acctName: string
  /** JSON 字符串，按 ecTypeCode 不同传不同集合 */
  ecContentParameters: string
  agentTag?: 0 | 1
  agentName?: string
  agentCertType?: string
  agentCertNo?: string
  agentFileName?: string
  agentFilePath?: string
  remark?: string
  retUrl?: string
}

export async function applyContract(input: ApplyContractInput): Promise<RequestResponse> {
  const reqData: Record<string, unknown> = {
    order_no: input.orderNo,
    org_id: input.orgId,
    ec_type_code: input.ecTypeCode,
    cert_type: input.certType,
    cert_name: input.certName,
    cert_no: input.certNo,
    mobile: input.mobile,
    openning_bank_code: input.openningBankCode,
    openning_bank_name: input.openningBankName,
    acct_type_code: input.acctTypeCode,
    acct_no: input.acctNo,
    acct_name: input.acctName,
    ec_content_parameters: input.ecContentParameters,
  }
  if (input.businessLicenseNo) reqData.business_license_no = input.businessLicenseNo
  if (input.businessLicenseName) reqData.business_license_name = input.businessLicenseName
  if (input.agentTag !== undefined) reqData.agent_tag = input.agentTag
  if (input.agentName) reqData.agent_name = input.agentName
  if (input.agentCertType) reqData.agent_cert_type = input.agentCertType
  if (input.agentCertNo) reqData.agent_cert_no = input.agentCertNo
  if (input.agentFileName) reqData.agent_file_name = input.agentFileName
  if (input.agentFilePath) reqData.agent_file_path = input.agentFilePath
  if (input.remark) reqData.remark = input.remark
  if (input.retUrl) reqData.ret_url = input.retUrl
  return request({
    path: '/api/v3/mms/open_api/ec/apply',
    reqData,
    envelope: 'v3',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §3 电子合同查询 ------------------------------------------------------

export interface QueryContractInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: number | string
  ecApplyId: number | string
}

export async function queryContract(input: QueryContractInput): Promise<RequestResponse> {
  return request({
    path: '/api/v3/mms/open_api/ec/q_status',
    reqData: {
      version: '1.0',
      order_no: input.orderNo,
      org_code: input.orgCode,
      ec_apply_id: input.ecApplyId,
    },
    envelope: 'v3',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §4 电子合同下载 ------------------------------------------------------

export interface DownloadContractInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: number | string
  ecApplyId: number | string
}

export async function downloadContract(input: DownloadContractInput): Promise<RequestResponse> {
  return request({
    path: '/api/v3/mms/open_api/ec/download',
    reqData: {
      version: '1.0',
      order_no: input.orderNo,
      org_code: input.orgCode,
      ec_apply_id: input.ecApplyId,
    },
    envelope: 'v3',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §5 附件上传 ----------------------------------------------------------

export interface UploadAttachmentInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  attType: string // 见 lakala-dicts ATTACHMENT_TYPES
  attExtName: string // jpg / png / pdf
  /** 文件内容 base64（spring `Base64Utils.encodeToString`，非 URL Safe） */
  attContext: string
}

export async function uploadAttachment(input: UploadAttachmentInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/uploadFile',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      attType: input.attType,
      attExtName: input.attExtName,
      attContext: input.attContext,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §6 新增商户进件 ------------------------------------------------------

/**
 * 进件请求字段。
 *
 * **`feeData` 由 server action 内部通过 `loadRateConfig()` 注入**（plan §0★）。
 * 此处不在签名上暴露 feeData 字段类型，强制 server-only 注入路径。
 *
 * 调用方必须用 spread + 类型 assert 注入：`submitMerchant({ ...input, feeData } as any)`；
 * 在 `Record<string, unknown>` reqData 里它会被透传，但 TS 类型不暴露给 client component。
 */
export interface SubmitMerchantInput extends OnboardingCommonOpts {
  orderNo: string
  posType: string
  orgCode: string
  merRegName: string
  merBizName?: string
  merRegDistCode: string
  merRegAddr: string
  mccCode: string
  merBlisName?: string
  merBlis?: string
  merBlisStDt?: string
  merBlisExpDt?: string
  merBusiContent: string
  larName: string
  larIdType: string
  larIdcard: string
  larIdcardStDt: string
  larIdcardExpDt: string
  merContactMobile: string
  merContactName: string
  shopName?: string
  shopDistCode?: string
  shopAddr?: string
  shopContactName?: string
  shopContactMobile?: string
  openningBankCode: string
  openningBankName: string
  clearingBankCode: string
  acctNo: string
  acctName: string
  acctTypeCode: string
  settlePeriod: string
  clearDt?: string
  acctIdType?: string
  acctIdcard?: string
  acctIdDt?: string
  devSerialNo?: string
  devTypeName?: string
  termVer?: string
  salesStaff?: string
  termNum?: string
  retUrl: string
  fileData?: Array<{ attFileId: string; attType: string }>
  contractNo?: string
  feeAssumeType?: string
  amountOfMonth?: string
  serviceFee?: string
}

/**
 * Internal payload type for the wire body — includes feeData. NOT exported,
 * NOT in the public method signature. Server action injects feeData via a
 * shallow spread before calling.
 */
type _SubmitMerchantWire = SubmitMerchantInput & {
  feeData?: unknown // 费率集合，server-only 注入
}

export async function submitMerchant(input: SubmitMerchantInput): Promise<RequestResponse> {
  // server action 通过 `(input as any).feeData` 注入；此处直接 spread。
  const wire = input as _SubmitMerchantWire
  const reqData: Record<string, unknown> = {
    version: '1.0',
    orderNo: wire.orderNo,
    posType: wire.posType,
    orgCode: wire.orgCode,
    merRegName: wire.merRegName,
    merRegDistCode: wire.merRegDistCode,
    merRegAddr: wire.merRegAddr,
    mccCode: wire.mccCode,
    merBusiContent: wire.merBusiContent,
    larName: wire.larName,
    larIdType: wire.larIdType,
    larIdcard: wire.larIdcard,
    larIdcardStDt: wire.larIdcardStDt,
    larIdcardExpDt: wire.larIdcardExpDt,
    merContactMobile: wire.merContactMobile,
    merContactName: wire.merContactName,
    openningBankCode: wire.openningBankCode,
    openningBankName: wire.openningBankName,
    clearingBankCode: wire.clearingBankCode,
    acctNo: wire.acctNo,
    acctName: wire.acctName,
    acctTypeCode: wire.acctTypeCode,
    settlePeriod: wire.settlePeriod,
    retUrl: wire.retUrl,
    feeData: wire.feeData, // ← server-only 注入；UI 完全看不见
  }
  if (wire.merBizName) reqData.merBizName = wire.merBizName
  if (wire.merBlisName) reqData.merBlisName = wire.merBlisName
  if (wire.merBlis) reqData.merBlis = wire.merBlis
  if (wire.merBlisStDt) reqData.merBlisStDt = wire.merBlisStDt
  if (wire.merBlisExpDt) reqData.merBlisExpDt = wire.merBlisExpDt
  if (wire.shopName) reqData.shopName = wire.shopName
  if (wire.shopDistCode) reqData.shopDistCode = wire.shopDistCode
  if (wire.shopAddr) reqData.shopAddr = wire.shopAddr
  if (wire.shopContactName) reqData.shopContactName = wire.shopContactName
  if (wire.shopContactMobile) reqData.shopContactMobile = wire.shopContactMobile
  if (wire.clearDt) reqData.clearDt = wire.clearDt
  if (wire.acctIdType) reqData.acctIdType = wire.acctIdType
  if (wire.acctIdcard) reqData.acctIdcard = wire.acctIdcard
  if (wire.acctIdDt) reqData.acctIdDt = wire.acctIdDt
  if (wire.devSerialNo) reqData.devSerialNo = wire.devSerialNo
  if (wire.devTypeName) reqData.devTypeName = wire.devTypeName
  if (wire.termVer) reqData.termVer = wire.termVer
  if (wire.salesStaff) reqData.salesStaff = wire.salesStaff
  if (wire.termNum) reqData.termNum = wire.termNum
  if (wire.fileData) reqData.fileData = wire.fileData
  if (wire.contractNo) reqData.contractNo = wire.contractNo
  if (wire.feeAssumeType) reqData.feeAssumeType = wire.feeAssumeType
  if (wire.amountOfMonth) reqData.amountOfMonth = wire.amountOfMonth
  if (wire.serviceFee) reqData.serviceFee = wire.serviceFee
  return request({
    path: '/api/v2/mms/openApi/addMer',
    reqData,
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §7 进件信息查询 ------------------------------------------------------

export interface QueryMerchantInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  contractId: string
}

export async function queryMerchant(input: QueryMerchantInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/queryContract',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      contractId: input.contractId,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §9 进件复议提交 ------------------------------------------------------

export interface SubmitAppealInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  contractId: string
}

export async function submitAppeal(input: SubmitAppealInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/reconsiderSubmit',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      contractId: input.contractId,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §10 商户报备结果查询 ------------------------------------------------

export interface QuerySubMerchantIdInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo?: string
  merCupNo?: string
  registerChannel?: string
  registerType?: string
  registerStatus?: 'SUCCESS' | 'FAIL'
  subMchId?: string
}

export async function querySubMerchantId(input: QuerySubMerchantIdInput): Promise<RequestResponse> {
  const reqData: Record<string, unknown> = {
    version: '1.0',
    orderNo: input.orderNo,
    orgCode: input.orgCode,
  }
  if (input.merInnerNo) reqData.merInnerNo = input.merInnerNo
  if (input.merCupNo) reqData.merCupNo = input.merCupNo
  if (input.registerChannel) reqData.registerChannel = input.registerChannel
  if (input.registerType) reqData.registerType = input.registerType
  if (input.registerStatus) reqData.registerStatus = input.registerStatus
  if (input.subMchId) reqData.subMchId = input.subMchId
  return request({
    path: '/api/v2/mms/openApi/querySubMerInfo',
    reqData,
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §13 微信实名认证结果查询 --------------------------------------------

export interface QueryWxRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  subMchId?: string
  channelId?: string
}

export async function queryWxRealname(input: QueryWxRealnameInput): Promise<RequestResponse> {
  const reqData: Record<string, unknown> = {
    version: '1.0',
    orderNo: input.orderNo,
    orgCode: input.orgCode,
    merInnerNo: input.merInnerNo,
  }
  if (input.subMchId) reqData.subMchId = input.subMchId
  if (input.channelId) reqData.channelId = input.channelId
  return request({
    path: '/api/v2/mms/openApi/wechatRealNameQuery',
    reqData,
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §14 微信实名提交（首次，按 modifyCommit 接口实现，applymentId 留空） ----

export interface SubmitWxRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  receOrgNo: string
  subMchId: string
  channelId: string
}

export async function submitWxRealname(input: SubmitWxRealnameInput): Promise<RequestResponse> {
  // modifyCommit 当 applymentId 缺省时按"新增实名"处理（见 endpoints §14 备注）。
  return request({
    path: '/api/v2/mms/openApi/wechatRealName/modifyCommit',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      merInnerNo: input.merInnerNo,
      receOrgNo: input.receOrgNo,
      subMchId: input.subMchId,
      channelId: input.channelId,
      // applymentId 留空 = 新增
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §14 微信实名修改提交 ------------------------------------------------

export interface ModifyWxRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  receOrgNo: string
  subMchId: string
  channelId: string
  applymentId: string
}

export async function modifyWxRealname(input: ModifyWxRealnameInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/wechatRealName/modifyCommit',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      merInnerNo: input.merInnerNo,
      receOrgNo: input.receOrgNo,
      subMchId: input.subMchId,
      channelId: input.channelId,
      applymentId: input.applymentId,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §15 支付宝实名认证信息查询 ------------------------------------------

export interface QueryAlipayRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  subMchId: string
  channelId?: string
  realNameType?: string
}

export async function queryAlipayRealname(input: QueryAlipayRealnameInput): Promise<RequestResponse> {
  const reqData: Record<string, unknown> = {
    version: '1.0',
    orderNo: input.orderNo,
    orgCode: input.orgCode,
    merInnerNo: input.merInnerNo,
    subMchId: input.subMchId,
  }
  if (input.channelId) reqData.channelId = input.channelId
  if (input.realNameType) reqData.realNameType = input.realNameType
  return request({
    path: '/api/v2/mms/openApi/alipayRealNameQuery',
    reqData,
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §16' 支付宝实名提交（首次，按 modifyCommit 实现，applymentId 留空） ----

export interface SubmitAlipayRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  receOrgNo: string
  subMchId: string
  channelId: string
}

export async function submitAlipayRealname(input: SubmitAlipayRealnameInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/alipayRealName/modifyCommit',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      merInnerNo: input.merInnerNo,
      receOrgNo: input.receOrgNo,
      subMchId: input.subMchId,
      channelId: input.channelId,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §16 支付宝修改提交 --------------------------------------------------

export interface ModifyAlipayRealnameInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  receOrgNo: string
  subMchId: string
  channelId: string
  applymentId: string
}

export async function modifyAlipayRealname(input: ModifyAlipayRealnameInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/openApi/alipayRealName/modifyCommit',
    reqData: {
      version: '1.0',
      orderNo: input.orderNo,
      orgCode: input.orgCode,
      merInnerNo: input.merInnerNo,
      receOrgNo: input.receOrgNo,
      subMchId: input.subMchId,
      channelId: input.channelId,
      applymentId: input.applymentId,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §12 支付宝/微信开户状态查询 -----------------------------------------

export interface QueryWxConfigInput extends OnboardingCommonOpts {
  tradeMode: 'WECHAT' | 'ALIPAY'
  subMerchantId: string
  merchantNo: string
}

export async function queryWxConfig(input: QueryWxConfigInput): Promise<RequestResponse> {
  return request({
    path: '/api/v2/mms/sme/mrchAuthStateQuery',
    reqData: {
      tradeMode: input.tradeMode,
      subMerchantId: input.subMerchantId,
      merchantNo: input.merchantNo,
    },
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}

// ---- §11 商户信息变更 ----------------------------------------------------

/**
 * 商户信息变更。
 *
 * **`feeData` 由 server action 内部通过 `loadRateConfig()` 注入**（plan §0★）。
 * 此处不在签名上暴露 feeData 字段类型，强制 server-only 注入路径。
 */
export interface UpdateLakalaMerchantInfoInput extends OnboardingCommonOpts {
  orderNo: string
  orgCode: string
  merInnerNo: string
  merCupNo: string
  merRegName?: string
  merBizName?: string
  merRegDistCode?: string
  merRegAddr?: string
  mccCode?: string
  merBlisName?: string
  merBlis?: string
  merBlisStDt?: string
  merBlisExpDt?: string
  merBusiContent?: string
  larName?: string
  larIdcard?: string
  larIdType?: string
  larIdcardStDt?: string
  larIdcardExpDt?: string
  merContactMobile?: string
  merContactName?: string
  fileData?: Array<{ attFileId: string; attType: string }>
  termNo?: string
  shopName?: string
  shopDistCode?: string
  shopAddr?: string
  shopContactName?: string
  shopContactMobile?: string
  openningBankCode?: string
  openningBankName?: string
  clearingBankCode?: string
  acctNo?: string
  acctName?: string
  acctTypeCode?: string
  settlePeriod?: string
  clearDt?: string
  acctIdType?: string
  acctIdcard?: string
  acctIdDt?: string
  retUrl: string
}

type _UpdateLakalaMerchantInfoWire = UpdateLakalaMerchantInfoInput & {
  feeData?: unknown // server-only 注入
}

export async function updateLakalaMerchantInfo(input: UpdateLakalaMerchantInfoInput): Promise<RequestResponse> {
  const wire = input as _UpdateLakalaMerchantInfoWire
  const reqData: Record<string, unknown> = {
    version: '1.0',
    orderNo: wire.orderNo,
    orgCode: wire.orgCode,
    merInnerNo: wire.merInnerNo,
    merCupNo: wire.merCupNo,
    retUrl: wire.retUrl,
  }
  // 仅传非空字段（变更接口语义：缺省 = 不变更）
  const optionalKeys: Array<keyof UpdateLakalaMerchantInfoInput> = [
    'merRegName', 'merBizName', 'merRegDistCode', 'merRegAddr', 'mccCode',
    'merBlisName', 'merBlis', 'merBlisStDt', 'merBlisExpDt', 'merBusiContent',
    'larName', 'larIdcard', 'larIdType', 'larIdcardStDt', 'larIdcardExpDt',
    'merContactMobile', 'merContactName',
    'termNo', 'shopName', 'shopDistCode', 'shopAddr', 'shopContactName', 'shopContactMobile',
    'openningBankCode', 'openningBankName', 'clearingBankCode', 'acctNo', 'acctName',
    'acctTypeCode', 'settlePeriod', 'clearDt', 'acctIdType', 'acctIdcard', 'acctIdDt',
  ]
  for (const k of optionalKeys) {
    const v = wire[k]
    if (v !== undefined && v !== null && v !== '') reqData[k as string] = v
  }
  if (wire.fileData) reqData.fileData = wire.fileData
  if (wire.feeData !== undefined) reqData.feeData = wire.feeData // server-only
  return request({
    path: '/api/v2/mms/openApi/changeMer',
    reqData,
    envelope: 'v2',
    reqIdHint: input.reqIdHint,
  })
}
