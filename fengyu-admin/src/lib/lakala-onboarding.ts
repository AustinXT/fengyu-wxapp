import 'server-only'

import { createCipheriv, createDecipheriv, createHash, createSign, createVerify, randomBytes } from 'node:crypto'
import { DEFAULT_LAKALA_VALUES, DEFAULT_ONBOARDING_FEE_DATA, normalizeTkbsAttachmentType } from './lakala-onboarding-constants'

type JsonRecord = Record<string, unknown>
type HeaderMap = Headers | Record<string, string | string[] | undefined>

export interface LakalaUploadFileInput {
  attachmentType: string
  contentType: string
  contentBase64: string
}

export interface LakalaUploadFileResult {
  success: boolean
  fileId?: string
  fileReference?: string
  showUrl?: string
  batchNo?: string
  ocrStatus?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaOcrResult extends LakalaUploadFileResult {
  ocrResult?: JsonRecord
}

export interface LakalaElectronicContractResult {
  success: boolean
  orderNo?: string
  applyId?: string
  resultUrl?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaElectronicContractStatusResult {
  success: boolean
  status?: string
  contractNo?: string
  orderNo?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaElectronicContractDownloadResult {
  success: boolean
  contractNo?: string
  pdfBytes?: Buffer
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaAddMerchantResult {
  success: boolean
  contractId?: string
  merInnerNo?: string
  merCupNo?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaQuerySubMerchantResult {
  success: boolean
  status: 'SUCCESS' | 'FAILED' | 'REGISTERING'
  merchantNo?: string
  innerCustomerNo?: string
  terminalNo?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaChannelSubMerchantResult {
  success: boolean
  wechat: Array<{ subMerchantNo: string; registerType?: string; channelId?: string; registerChannelName?: string }>
  alipay: Array<{ subMerchantNo: string; registerType?: string; channelId?: string; registerChannelName?: string }>
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaCertificationResult {
  success: boolean
  registerType: 'WXZF' | 'ZFBZF'
  subMchId?: string
  merchantNo?: string
  registerState?: string
  authorizeState?: string
  applymentState?: string
  registerCode?: string
  registerMsg?: string
  rejectReason?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaMerchantAuthStateResult {
  success: boolean
  tradeMode: 'WECHAT' | 'ALIPAY'
  merchantNo: string
  subMerchantId: string
  checkResult?: string
  errorCode?: string
  errorMessage?: string
  raw: JsonRecord
}

export interface LakalaBankOption {
  branchBankNo: string
  clearNo: string
  branchBankName: string
  areaCode: string
  bankNo?: string
}

interface SignedResponse {
  status: number
  headers: Record<string, string>
  rawBody: string
  data: JsonRecord
}

const SENSITIVE_KEY = /(?:password|secret|token|key|signature|authorization|private|certificate|cert|raw(?:text|body|payload)?|file(?:_|)?base64|contentbase64|attcontext|(?:acct|account)(?:_|)?(?:no|number|name|type|id|idcard|card|bank)?|id_?card|idnumber|mobile|phone|email|license|address|addr|legal(?:_|)?person|bank|fee|name|merchant(?:_|)?(?:no|number)|mer(?:_|)?(?:cup|inner)(?:_|)?no|customer(?:_|)?no|sub(?:_|)?merchant(?:_|)?(?:no|id)|sub_mch_id|contract(?:_|)?(?:no|id)|(?:result|show|file)(?:_|)?url|url|uri|link)/i

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`INVALID_STATE: ${name} 未配置`)
  return value
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function requireHttpsUrl(name: string): string {
  const value = requireEnv(name).replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`INVALID_STATE: ${name} 不是合法 URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`INVALID_STATE: ${name} 必须使用 HTTPS`)
  }
  return value
}

function assertOnboardingEnabled(): void {
  if (getLakalaOnboardingClientMode() === 'disabled') {
    throw new Error('INVALID_STATE: 拉卡拉门店入网未启用或未完成开发环境配置')
  }
}

function asHeaders(input: HeaderMap): Record<string, string> {
  const result: Record<string, string> = {}
  if (input instanceof Headers) {
    input.forEach((value, key) => { result[key.toLowerCase()] = value })
    return result
  }
  for (const [key, value] of Object.entries(input)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value[0] ?? '' : value ?? ''
  }
  return result
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

function responseData(raw: JsonRecord): JsonRecord {
  const candidate = raw.resp_data ?? raw.respData ?? raw.data
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as JsonRecord
    : raw
}

function successResponse(raw: JsonRecord): boolean {
  const code = normalizeCode(raw.code ?? raw.retCode ?? raw.respCode)
  return code === '000000' || code === '0000' || code === 'BBS00000'
}

function errorCode(raw: JsonRecord): string | undefined {
  return normalizeCode(raw.code ?? raw.retCode ?? raw.respCode ?? raw.httpStatus)
}

function safeErrorMessage(raw: JsonRecord): string | undefined {
  const code = errorCode(raw)
  return code ? `拉卡拉返回错误码：${code}` : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function parseJsonRecord(value: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : undefined
  } catch {
    return undefined
  }
}

function randomRequestId(): string {
  return `fy${Date.now()}${randomBytes(6).toString('hex')}`
}

function formatLakalaTime(now = new Date()): string {
  const offset = now.getTime() + 8 * 60 * 60 * 1000
  const date = new Date(offset)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}`
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n')
}

interface OnboardingLakalaConfig {
  apiBase: string
  appId: string
  serialNo: string
  privateKeyPem: string
  platformCertPem: string
}

/** 入网使用交接包专用身份，避免改动支付链路的 LAKALA_* 配置。 */
function onboardingLakalaConfig(): OnboardingLakalaConfig {
  const privateKeyPem = normalizePem(requireEnv('LAKALA_ONBOARDING_PRIVATE_KEY_PEM'))
  const platformCertPem = normalizePem(requireEnv('LAKALA_ONBOARDING_PLATFORM_CERT_PEM'))
  if (!/-----BEGIN[\s\S]+-----/.test(privateKeyPem)) {
    throw new Error('INVALID_STATE: LAKALA_ONBOARDING_PRIVATE_KEY_PEM 格式不合法')
  }
  if (!/-----BEGIN[\s\S]+-----/.test(platformCertPem)) {
    throw new Error('INVALID_STATE: LAKALA_ONBOARDING_PLATFORM_CERT_PEM 格式不合法')
  }
  return {
    apiBase: requireHttpsUrl('LAKALA_ONBOARDING_API_BASE'),
    appId: requireEnv('LAKALA_ONBOARDING_APPID'),
    serialNo: requireEnv('LAKALA_ONBOARDING_SERIAL_NO'),
    privateKeyPem,
    platformCertPem,
  }
}

function signedAuthorization(body: string, config: OnboardingLakalaConfig): { appId: string; authorization: string } {
  assertOnboardingEnabled()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  const payload = `${config.appId}\n${config.serialNo}\n${timestamp}\n${nonce}\n${body}\n`
  const signer = createSign('RSA-SHA256')
  signer.update(payload, 'utf8')
  signer.end()
  const signature = signer.sign(config.privateKeyPem, 'base64')
  return {
    appId: config.appId,
    authorization: `LKLAPI-SHA256withRSA appid="${config.appId}",serial_no="${config.serialNo}",timestamp="${timestamp}",nonce_str="${nonce}",signature="${signature}"`,
  }
}

/** 拉卡拉 RSA-SHA256 验签，签名串与既有支付客户端保持一致。 */
export function verifyLakalaRsaSha256Signature(
  headersInput: HeaderMap,
  rawBody: string,
  platformCertificatePem: string,
): boolean {
  const headers = asHeaders(headersInput)
  const appId = headers['lklapi-appid']
  const serialNo = headers['lklapi-serial']
  const timestamp = headers['lklapi-timestamp']
  const nonce = headers['lklapi-nonce']
  const signature = headers['lklapi-signature']
  if (!appId || !serialNo || !timestamp || !nonce || !signature) return false
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${appId}\n${serialNo}\n${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8')
    verifier.end()
    return verifier.verify(platformCertificatePem, signature, 'base64')
  } catch {
    return false
  }
}

async function postSignedRaw(pathname: string, body: string): Promise<SignedResponse> {
  // Keep the kill switch ahead of any network/configuration work. Individual public
  // APIs also check it before constructing provider-specific payloads.
  assertOnboardingEnabled()
  const config = onboardingLakalaConfig()
  const signed = signedAuthorization(body, config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const normalizedPath = config.apiBase.endsWith('/api') || pathname.startsWith('/api/')
      ? pathname
      : `/api${pathname}`
    const response = await fetch(`${config.apiBase}${normalizedPath}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: signed.authorization,
        'LKLAPI-AppId': signed.appId,
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    })
    const rawBody = await response.text()
    const headers = asHeaders(response.headers)
    if (!headers['lklapi-signature']) {
      throw new Error('INVALID_STATE: 拉卡拉响应缺少签名')
    }
    if (!verifyLakalaRsaSha256Signature(headers, rawBody, config.platformCertPem)) {
      throw new Error('INVALID_STATE: 拉卡拉响应签名校验失败')
    }
    // 原始响应仅用于验签和 TKBS 解密，绝不能进入调用结果或审计日志。
    let data = parseJsonRecord(rawBody) ?? {}
    if (!response.ok) data = { ...data, httpStatus: response.status }
    return { status: response.status, headers, rawBody, data }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('INVALID_STATE: 拉卡拉请求超时')
    }
    if (error instanceof Error && error.message.startsWith('INVALID_STATE:')) throw error
    throw new Error('INVALID_STATE: 拉卡拉请求失败')
  } finally {
    clearTimeout(timer)
  }
}

function decodeSm4Key(): Buffer {
  const source = requireEnv('LAKALA_ONBOARDING_SM4_KEY')
  const base64 = Buffer.from(source, 'base64')
  if (base64.length === 16) return base64
  const hex = Buffer.from(source, 'hex')
  if (/^[0-9a-fA-F]{32}$/.test(source) && hex.length === 16) return hex
  throw new Error('INVALID_STATE: LAKALA_ONBOARDING_SM4_KEY 必须是 16 字节的 base64 或 hex')
}

export function verifyOnboardingSm4Key(): void {
  decodeSm4Key()
}

function encryptSm4(value: string): string {
  const cipher = createCipheriv('sm4-ecb', decodeSm4Key(), null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64')
}

function decryptSm4(value: string): string {
  const decipher = createDecipheriv('sm4-ecb', decodeSm4Key(), null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(value, 'base64'), decipher.final()]).toString('utf8')
}

async function postSignedJson(pathname: string, payload: JsonRecord): Promise<JsonRecord> {
  return (await postSignedRaw(pathname, JSON.stringify(payload))).data
}

async function postTkbsEncrypted(pathname: string, reqData: JsonRecord): Promise<JsonRecord> {
  const envelope = {
    ver: DEFAULT_LAKALA_VALUES.tkbsVersion,
    timestamp: formatLakalaTime(),
    req_id: randomRequestId(),
    req_data: reqData,
  }
  const response = await postSignedRaw(pathname, encryptSm4(JSON.stringify(envelope)))
  const plainJson = parseJsonRecord(response.rawBody)
  if (plainJson) return plainJson
  try {
    const decryptedJson = parseJsonRecord(decryptSm4(response.rawBody))
    return decryptedJson ?? { httpStatus: response.status }
  } catch {
    return { httpStatus: response.status }
  }
}

function tkbsResult(raw: JsonRecord): { success: boolean; data: JsonRecord; errorCode?: string; errorMessage?: string } {
  return {
    success: successResponse(raw),
    data: responseData(raw),
    errorCode: errorCode(raw),
    errorMessage: safeErrorMessage(raw),
  }
}

/**
 * 仅在服务器读取费率；调用方不得把 feeData 写入申请表、操作日志或返回值。
 */
export function getServerOnboardingFeePolicy(): { feeData: Array<{ fee_code: string; fee_value: string }>; version: string } {
  const raw = optionalEnv('LAKALA_ONBOARDING_FEE_DATA') ?? JSON.stringify(DEFAULT_ONBOARDING_FEE_DATA)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_STATE: LAKALA_ONBOARDING_FEE_DATA 不是有效 JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('INVALID_STATE: LAKALA_ONBOARDING_FEE_DATA 必须是非空费率数组')
  }
  const feeData = parsed.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('INVALID_STATE: LAKALA_ONBOARDING_FEE_DATA 格式不合法')
    const source = row as JsonRecord
    const feeCode = typeof source.fee_code === 'string' ? source.fee_code.trim() : ''
    const feeValue = typeof source.fee_value === 'string' || typeof source.fee_value === 'number'
      ? String(source.fee_value).trim()
      : ''
    if (!/^[A-Z0-9_]{2,40}$/.test(feeCode) || !/^\d+(?:\.\d{1,4})?$/.test(feeValue)) {
      throw new Error('INVALID_STATE: LAKALA_ONBOARDING_FEE_DATA 包含非法费率项')
    }
    return { fee_code: feeCode, fee_value: feeValue }
  })
  const canonical = JSON.stringify([...feeData].sort((a, b) => a.fee_code.localeCompare(b.fee_code)))
  return {
    feeData,
    version: `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`,
  }
}

export function getLakalaOnboardingApiFamily(): 'tkbs' {
  return 'tkbs'
}

export function getLakalaOnboardingClientMode(): 'real' | 'mock' | 'disabled' {
  if (process.env.LAKALA_ONBOARDING_ENABLED !== 'true') return 'disabled'
  const mode = process.env.LAKALA_ONBOARDING_CLIENT_MODE?.trim().toLowerCase()
  if (!mode || mode === 'real') return 'real'
  if (mode === 'mock') return 'mock'
  throw new Error('INVALID_STATE: LAKALA_ONBOARDING_CLIENT_MODE 只能是 real 或 mock')
}

export function getLakalaOnboardingApiBase(): string | undefined {
  return optionalEnv('LAKALA_ONBOARDING_API_BASE')
}

export function getOnboardingOrgCode(): string {
  return requireEnv('LAKALA_ONBOARDING_ORG_CODE')
}

export function getOnboardingUserNo(): string {
  return requireEnv('LAKALA_ONBOARDING_USER_NO')
}

export function getOnboardingActivityId(): string {
  return requireEnv('LAKALA_ONBOARDING_ACTIVITY_ID')
}

export function getEContractOrgId(): string {
  return optionalEnv('LAKALA_ECONTRACT_ORG_ID') ?? optionalEnv('LAKALA_ONBOARDING_ECONTRACT_ORG_ID') ?? getOnboardingOrgCode()
}

export function getEContractType(): string {
  return optionalEnv('LAKALA_ECONTRACT_TYPE') ?? optionalEnv('LAKALA_ONBOARDING_ECONTRACT_TYPE') ?? 'EC015'
}

export function getEContractCallbackUrl(): string | undefined {
  return optionalEnv('LAKALA_ECONTRACT_CALLBACK_URL')
}

export async function lakalaUploadFile(input: LakalaUploadFileInput): Promise<LakalaUploadFileResult> {
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    const attachmentType = normalizeTkbsAttachmentType(input.attachmentType)
    const fileId = `mock-file-${randomBytes(8).toString('hex')}`
    return {
      success: true,
      fileId,
      fileReference: fileId,
      batchNo: `mock-batch-${randomBytes(6).toString('hex')}`,
      ocrStatus: ['BUSINESS_LICENCE', 'ID_CARD_FRONT', 'ID_CARD_BEHIND'].includes(attachmentType) ? '00' : undefined,
      raw: { code: '000000', mode: 'mock', attachmentType },
    }
  }
  const raw = await postSignedJson('/v3/tkbs/customer/file/upload', {
    ver: DEFAULT_LAKALA_VALUES.tkbsVersion,
    timestamp: formatLakalaTime(),
    req_id: randomRequestId(),
    req_data: {
      file_base64: `data:${input.contentType};base64,${input.contentBase64}`,
      img_type: normalizeTkbsAttachmentType(input.attachmentType),
      prefix: 'reg',
      sourcechnl: '0',
      is_ocr: ['BUSINESS_LICENCE', 'ID_CARD_FRONT', 'ID_CARD_BEHIND'].includes(normalizeTkbsAttachmentType(input.attachmentType)) ? 'true' : 'false',
    },
  })
  const result = tkbsResult(raw)
  return {
    success: result.success && Boolean(firstString(result.data.url, result.data.file_id, result.data.att_file_id)),
    fileId: firstString(result.data.file_id, result.data.att_file_id, result.data.url),
    fileReference: firstString(result.data.url, result.data.file_url),
    showUrl: firstString(result.data.show_url, result.data.showUrl),
    batchNo: firstString(result.data.batch_no, result.data.batchNo),
    ocrStatus: firstString(result.data.status, result.data.ocr_status),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaQueryOcrResult(input: { imgType: string; batchNo: string }): Promise<LakalaOcrResult> {
  if (!input.imgType || !input.batchNo) return { success: false, errorMessage: '缺少 OCR 批次信息', raw: {} }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return {
      success: true,
      batchNo: input.batchNo,
      ocrStatus: '00',
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postSignedJson('/v3/tkbs/ocr_result', {
    ver: DEFAULT_LAKALA_VALUES.tkbsVersion,
    timestamp: formatLakalaTime(),
    req_id: randomRequestId(),
    req_data: { img_type: normalizeTkbsAttachmentType(input.imgType), batch_no: input.batchNo },
  })
  const result = tkbsResult(raw)
  const ocrStatus = firstString(result.data.status, result.data.ocr_status)
  return {
    success: result.success && ocrStatus !== '02',
    fileId: firstString(result.data.file_id, result.data.att_file_id, result.data.url),
    fileReference: firstString(result.data.url, result.data.file_url),
    showUrl: firstString(result.data.show_url, result.data.showUrl),
    batchNo: firstString(result.data.batch_no, result.data.batchNo) ?? input.batchNo,
    ocrStatus,
    ocrResult: result.data.result && typeof result.data.result === 'object' ? result.data.result as JsonRecord : undefined,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaApplyElectronicContract(reqData: JsonRecord): Promise<LakalaElectronicContractResult> {
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    const orderNo = firstString(reqData.order_no) ?? `mock-ec-${Date.now()}`
    return {
      success: true,
      orderNo,
      applyId: `mock-apply-${randomBytes(6).toString('hex')}`,
      resultUrl: '/merchants/onboarding?mockContract=1',
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postSignedJson('/v3/mms/open_api/ec/apply', {
    req_time: formatLakalaTime(),
    version: '3.0',
    req_data: reqData,
  })
  const result = tkbsResult(raw)
  return {
    success: result.success,
    orderNo: firstString(result.data.order_no, result.data.orderNo),
    applyId: firstString(result.data.ec_apply_id, result.data.apply_id),
    resultUrl: firstString(result.data.result_url, result.data.resultUrl),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

/** 主动查询电子合同状态，作为供应商入站回调之外的兜底。 */
export async function lakalaQueryElectronicContract(input: {
  orderNo: string
  applyId?: string | null
}): Promise<LakalaElectronicContractStatusResult> {
  if (!input.orderNo.trim()) {
    return { success: false, errorMessage: '缺少电子合同订单号', raw: {} }
  }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return {
      success: true,
      status: 'SIGNED',
      contractNo: `mock-contract-${input.orderNo.slice(-12)}`,
      orderNo: input.orderNo,
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postSignedJson('/v3/mms/open_api/ec/q_status', {
    req_time: formatLakalaTime(),
    version: '3.0',
    req_data: {
      order_no: input.orderNo,
      ...(input.applyId ? { ec_apply_id: input.applyId } : {}),
    },
  })
  const result = tkbsResult(raw)
  return {
    success: result.success,
    status: firstString(result.data.ec_status, result.data.status, result.data.contract_status),
    contractNo: firstString(result.data.ec_no, result.data.contract_no, result.data.contractNo),
    orderNo: firstString(result.data.order_no, result.data.orderNo) ?? input.orderNo,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

function decodeUrlSafeBase64Pdf(value: string): Buffer | undefined {
  const compact = value
    .replace(/^data:application\/pdf;base64,/i, '')
    .replace(/\s/g, '')
  if (!compact || compact.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return undefined
  const padded = compact.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (compact.length % 4)) % 4)
  try {
    const bytes = Buffer.from(padded, 'base64')
    return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? bytes : undefined
  } catch {
    return undefined
  }
}

/**
 * 下载已签约电子合同。拉卡拉返回 URL-safe Base64 的 PDF，调用方必须立即写入私有存储；
 * 该内容绝不能进入外部调用日志或浏览器响应。
 */
export async function lakalaDownloadElectronicContract(input: {
  orderNo: string
  contractNo?: string | null
}): Promise<LakalaElectronicContractDownloadResult> {
  if (!input.orderNo.trim()) {
    return { success: false, errorMessage: '缺少电子合同订单号', raw: {} }
  }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return {
      success: true,
      contractNo: input.contractNo ?? `mock-contract-${input.orderNo.slice(-12)}`,
      pdfBytes: Buffer.from('%PDF-1.4\n% mock signed contract\n%%EOF\n'),
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postSignedJson('/v3/mms/open_api/ec/download', {
    req_time: formatLakalaTime(),
    version: '3.0',
    req_data: {
      order_no: input.orderNo,
      ...(input.contractNo ? { ec_no: input.contractNo } : {}),
    },
  })
  const result = tkbsResult(raw)
  const encoded = firstString(
    result.data.pdf_base64,
    result.data.pdfBase64,
    result.data.file_base64,
    result.data.fileBase64,
    result.data.contract_pdf,
    result.data.contractPdf,
    result.data.file_content,
    result.data.fileContent,
  )
  const pdfBytes = encoded ? decodeUrlSafeBase64Pdf(encoded) : undefined
  return {
    success: result.success && Boolean(pdfBytes),
    contractNo: firstString(result.data.ec_no, result.data.contract_no, result.data.contractNo) ?? input.contractNo ?? undefined,
    pdfBytes,
    errorCode: result.success && !pdfBytes ? 'ECONTRACT_PDF_INVALID' : result.errorCode,
    errorMessage: result.success && !pdfBytes ? '拉卡拉电子合同未返回有效 PDF' : result.errorMessage,
    raw,
  }
}

export async function lakalaAddMerchant(reqData: JsonRecord): Promise<LakalaAddMerchantResult> {
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    const suffix = firstString(reqData.external_no)?.slice(-8) ?? randomBytes(4).toString('hex')
    return {
      success: true,
      contractId: `mock-contract-${suffix}`,
      merInnerNo: `mock-inner-${suffix}`,
      merCupNo: `mock-cup-${suffix}`,
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postTkbsEncrypted('/v3/tkbs/merchant_encry', reqData)
  const result = tkbsResult(raw)
  const merchantNo = firstString(result.data.merchant_no, result.data.mer_cup_no, result.data.merchantNo)
  return {
    success: result.success,
    contractId: firstString(result.data.contract_id, result.data.contractId),
    merInnerNo: firstString(result.data.mer_inner_no, result.data.merInnerNo, result.data.customer_no),
    merCupNo: merchantNo,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaQuerySubMerchant(input: { contractId?: string | null; merInnerNo?: string | null; merCupNo?: string | null }): Promise<LakalaQuerySubMerchantResult> {
  const customerNo = input.merInnerNo || input.merCupNo
  if (!customerNo) {
    return { success: false, status: 'FAILED', errorMessage: '缺少拉卡拉商户标识', raw: {} }
  }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    const suffix = customerNo.slice(-8)
    return {
      success: true,
      status: 'SUCCESS',
      merchantNo: input.merCupNo ?? `mock-cup-${suffix}`,
      innerCustomerNo: input.merInnerNo ?? `mock-inner-${suffix}`,
      terminalNo: `mock-term-${suffix}`,
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postTkbsEncrypted('/v3/tkbs/open_merchant_info', {
    merchant_no: null,
    customer_no: customerNo,
    org_code: getOnboardingOrgCode(),
  })
  const result = tkbsResult(raw)
  const customer = result.data.customer && typeof result.data.customer === 'object'
    ? result.data.customer as JsonRecord
    : result.data
  const customerStatus = firstString(customer.customer_status, customer.status)?.toUpperCase()
  const status = customerStatus === 'OPEN' || customerStatus === 'SUCCESS'
    ? 'SUCCESS'
    : ['REJECT', 'REVIEW_FAIL', 'FAILED'].includes(customerStatus ?? '')
      ? 'FAILED'
      : 'REGISTERING'
  const terminal = extractTerminalNo(result.data)
  return {
    success: result.success,
    status,
    merchantNo: firstString(customer.merchant_no, customer.mer_cup_no),
    innerCustomerNo: firstString(customer.customer_no, customer.mer_inner_no),
    terminalNo: terminal,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

function extractTerminalNo(data: JsonRecord): string | undefined {
  const customer = data.customer && typeof data.customer === 'object' ? data.customer as JsonRecord : {}
  const pos = data.pos && typeof data.pos === 'object' ? data.pos as JsonRecord : {}
  const direct = firstString(customer.term_no, customer.termNo, pos.term_no, pos.termNo)
  if (direct) return direct
  const terminalInfo = data.terminal_info
  const items = Array.isArray(terminalInfo) ? terminalInfo : terminalInfo && typeof terminalInfo === 'object' ? [terminalInfo] : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as JsonRecord
    const termNo = firstString(row.term_no, row.termNo)
    if (termNo) return termNo
  }
  return undefined
}

export async function lakalaQueryChannelSubMerchants(input: { merchantNo: string }): Promise<LakalaChannelSubMerchantResult> {
  if (!input.merchantNo) return { success: false, wechat: [], alipay: [], errorMessage: '缺少银联商户号', raw: {} }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return {
      success: true,
      wechat: [{ subMerchantNo: `mock-wx-${input.merchantNo.slice(-8)}`, registerType: 'WXZF', channelId: 'mock-wechat', registerChannelName: '微信支付' }],
      alipay: [{ subMerchantNo: `mock-ali-${input.merchantNo.slice(-8)}`, registerType: 'ZFBZF', channelId: 'mock-alipay', registerChannelName: '支付宝' }],
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postTkbsEncrypted('/v3/tkbs/open_merchant_submer', {
    merchant_no: input.merchantNo,
    org_code: getOnboardingOrgCode(),
  })
  const result = tkbsResult(raw)
  const mapItems = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as JsonRecord
    const subMerchantNo = firstString(row.sub_merchant_no, row.subMerchantNo)
    return subMerchantNo ? [{
      subMerchantNo,
      registerType: firstString(row.register_type, row.registerType),
      channelId: firstString(row.channel_id, row.channelId),
      registerChannelName: firstString(row.register_channel_name, row.registerChannelName),
    }] : []
  }) : []
  return {
    success: result.success,
    wechat: mapItems(result.data.wx_list ?? result.data.wxList),
    alipay: mapItems(result.data.zfb_list ?? result.data.zfbList),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaQueryRegisterStatus(input: { merchantNo: string; registerType: 'WXZF' | 'ZFBZF' }): Promise<LakalaCertificationResult> {
  if (!input.merchantNo) return { success: false, registerType: input.registerType, errorMessage: '缺少银联商户号', raw: {} }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return {
      success: true,
      registerType: input.registerType,
      subMchId: input.registerType === 'WXZF' ? `mock-wx-${input.merchantNo.slice(-8)}` : `mock-ali-${input.merchantNo.slice(-8)}`,
      merchantNo: input.merchantNo,
      registerState: 'SUCCESS',
      authorizeState: 'SUCCESS',
      applymentState: 'SUCCESS',
      registerCode: '000000',
      registerMsg: '模拟认证成功',
      raw: { code: '000000', mode: 'mock' },
    }
  }
  const raw = await postTkbsEncrypted('/v3/tkbs/open_merchant_register_status_query', {
    org_code: getOnboardingOrgCode(),
    merchant_no: input.merchantNo,
    register_type: input.registerType,
  })
  const result = tkbsResult(raw)
  return {
    success: result.success,
    registerType: input.registerType,
    subMchId: firstString(result.data.sub_mch_id, result.data.subMerchantId),
    merchantNo: firstString(result.data.merchant_no),
    registerState: firstString(result.data.register_state),
    authorizeState: firstString(result.data.authorize_state),
    applymentState: firstString(result.data.applyment_state),
    registerCode: firstString(result.data.register_code),
    registerMsg: firstString(result.data.register_msg),
    rejectReason: firstString(result.data.reject_reason),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaQueryMerchantAuthState(input: { merchantNo: string; tradeMode: 'WECHAT' | 'ALIPAY'; subMerchantId: string }): Promise<LakalaMerchantAuthStateResult> {
  if (!input.merchantNo || !input.subMerchantId) {
    return { success: false, ...input, errorMessage: '缺少商户号或子商户号', raw: {} }
  }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return { success: true, ...input, checkResult: 'AUTHORIZED', raw: { code: '000000', mode: 'mock' } }
  }
  const raw = await postSignedJson('/v2/mms/sme/mrchAuthStateQuery', {
    ver: '1.0.0',
    timestamp: String(Date.now()),
    reqId: randomRequestId(),
    reqData: {
      merchantNo: input.merchantNo,
      tradeMode: input.tradeMode,
      subMerchantId: input.subMerchantId,
    },
  })
  const result = tkbsResult(raw)
  return {
    success: result.success,
    ...input,
    checkResult: firstString(result.data.checkResult, result.data.check_result),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    raw,
  }
}

export async function lakalaQueryBanks(input: { areaCode: string; bankName: string }): Promise<{ success: boolean; banks: LakalaBankOption[]; errorCode?: string; errorMessage?: string; raw: JsonRecord }> {
  if (!input.areaCode || !input.bankName.trim()) {
    return { success: false, banks: [], errorMessage: '缺少开户行地区或银行名称', raw: {} }
  }
  assertOnboardingEnabled()
  if (getLakalaOnboardingClientMode() === 'mock') {
    return { success: true, banks: [], raw: { code: '000000', mode: 'mock' } }
  }
  const raw = await postSignedJson('/v3/tkbs/bank', {
    ver: DEFAULT_LAKALA_VALUES.tkbsVersion,
    timestamp: formatLakalaTime(),
    req_id: randomRequestId(),
    req_data: {
      org_code: getOnboardingOrgCode(),
      area_code: input.areaCode,
      bank_name: input.bankName.trim(),
    },
  })
  const result = tkbsResult(raw)
  const rows = Array.isArray(result.data) ? result.data : Array.isArray(raw.resp_data) ? raw.resp_data : []
  const banks = rows.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as JsonRecord
    const branchBankNo = firstString(row.branch_bank_no, row.branchBankNo)
    const clearNo = firstString(row.clear_no, row.clearNo)
    const branchBankName = firstString(row.branch_bank_name, row.branchBankName)
    return branchBankNo && clearNo && branchBankName ? [{
      branchBankNo,
      clearNo,
      branchBankName,
      areaCode: input.areaCode,
      bankNo: firstString(row.bank_no, row.bankNo),
    }] : []
  })
  return { success: result.success, banks, errorCode: result.errorCode, errorMessage: result.errorMessage, raw }
}

function resemblesBase64(value: string): boolean {
  const compact = value.replace(/\s/g, '')
  return compact.length > 128 && /^[A-Za-z0-9+/_=-]+$/.test(compact)
}

/** 对外调用日志统一脱敏，禁止身份证、银行卡、合同链接和 Base64 文件进入数据库。 */
export function maskPayload<T>(payload: T): T {
  if (payload == null || typeof payload !== 'object') {
    return typeof payload === 'string' && resemblesBase64(payload) ? '[redacted]' as T : payload
  }
  if (Array.isArray(payload)) return payload.map((item) => maskPayload(item)) as T

  const result: JsonRecord = {}
  for (const [key, value] of Object.entries(payload as JsonRecord)) {
    // 电子合同正文是 JSON 字符串，包含法人、主体和结算资料。即使其内部字段
    // 未来变化，也不能作为审计日志载荷保留。
    if (key === 'ec_content_parameters' || SENSITIVE_KEY.test(key)) {
      result[key] = /fee|rate/i.test(key) ? '[fee policy omitted]' : '[redacted]'
      continue
    }
    if (typeof value === 'string') {
      if (resemblesBase64(value)) {
        result[key] = '[redacted]'
        continue
      }
      if (value.length <= 64 * 1024 && /^[\[{]/.test(value.trim())) {
        try {
          result[key] = maskPayload(JSON.parse(value))
          continue
        } catch {
          // 保留不可解析的短文本，例如拉卡拉错误码说明。
        }
      }
    }
    result[key] = typeof value === 'object' && value !== null ? maskPayload(value) : value
  }
  return result as T
}
