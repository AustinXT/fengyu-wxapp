import 'server-only'

import { Readable } from 'node:stream'
import OcrClient, {
  RecognizeBusinessLicenseRequest,
  RecognizeIdcardRequest,
} from '@alicloud/ocr-api20210707'
import { Config } from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import { getLakalaMerchantAreaPathByCode, lakalaMerchantAreaCodeFromAddress } from '../lakala-merchant-area'
import { normalizeLakalaDetailAddress } from '../lakala-onboarding-address'
import type { BusinessLicenseOcrResult, IdCardOcrResult } from './types'
import { OcrConfigurationError, OcrServiceError } from './types'

type OcrFile = Pick<File, 'arrayBuffer' | 'name'>
type UnknownRecord = Record<string, unknown>

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new OcrConfigurationError(`OCR 未配置：缺少 ${names.join(' 或 ')}`)
}

function ocrMode(): 'real' | 'mock' {
  const value = process.env.ALIYUN_OCR_MODE?.trim().toLowerCase()
  if (!value || value === 'real') return 'real'
  if (value === 'mock') return 'mock'
  throw new OcrConfigurationError('OCR 配置错误：ALIYUN_OCR_MODE 只能是 real 或 mock')
}

function mockBusinessLicense(): BusinessLicenseOcrResult {
  return {
    merBlisName: 'OCR 模拟营业执照主体',
    merRegName: 'OCR 模拟营业执照主体',
    merBlis: '91360100MOCK000001',
    merRegAddr: '模拟路 1 号',
    larName: '模拟法人',
    merBlisStDt: '2021-01-01',
    merBlisExpDt: '2041-01-01',
  }
}

function mockIdCard(side: 'face' | 'back'): IdCardOcrResult {
  return side === 'face'
    ? { side, larName: '模拟法人', larIdcard: '360102199001011234' }
    : { side, larIdcardStDt: '2021-01-01', larIdcardExpDt: '2041-01-01' }
}

function nestedIdCardResult(result: UnknownRecord, side: 'face' | 'back'): UnknownRecord {
  const sideRecord = asRecord(valueByKey(result, side))
  const sideData = asRecord(parseMaybeJson(valueByKey(sideRecord, 'data')))
  return flattenWords({
    ...result,
    ...sideRecord,
    ...sideData,
  })
}

export function parseAliyunIdCardResult(value: unknown, side: 'face' | 'back'): IdCardOcrResult {
  const result = nestedIdCardResult(flattenWords(unwrapResponse(value)), side)
  const period = dateRange(textValue(result, ['validPeriod', 'validPeriodRange', '有效期限', '证件有效期']))
  return side === 'face'
    ? {
        side,
        larName: textValue(result, ['name', '姓名']),
        larIdcard: textValue(result, ['idNumber', 'idNo', 'num', '身份证号', '公民身份号码']),
      }
    : {
        side,
        larIdcardStDt: period.start ?? formatDate(textValue(result, ['startDate', 'issueDate', 'validFrom', '签发日期', '有效期起始日期'])),
        larIdcardExpDt: period.end ?? formatDate(textValue(result, ['endDate', 'expiryDate', 'validTo', '失效日期', '有效期截止日期'])),
        larIdcardLongTerm: period.longTerm ?? (/长期|永久/i.test(textValue(result, ['endDate', 'expiryDate', 'validTo', '失效日期', '有效期截止日期']) ?? '') ? 'true' : undefined),
      }
}

export function parseAliyunBusinessLicenseResult(value: unknown): BusinessLicenseOcrResult {
  const result = flattenWords(unwrapResponse(value))
  const expiry = textValue(result, ['validPeriodEnd', 'validToDate', 'expiryDate', 'validTo', 'endDate', 'validPeriod', '有效期', '有效期截止日期'])
  const rawAddress = textValue(result, ['address', 'businessAddress', 'registeredAddress', 'registerAddress', '住所', '注册地址', '经营场所'])
  const areaCode = lakalaMerchantAreaCodeFromAddress(rawAddress)
  const registeredRegion = getLakalaMerchantAreaPathByCode(areaCode)
  const merRegAddr = rawAddress
    ? normalizeLakalaDetailAddress(rawAddress, registeredRegion.label)
    : undefined
  return {
    merBlisName: textValue(result, ['name', 'companyName', 'businessName', 'enterpriseName', '企业名称', '营业执照名称', '名称']),
    merRegName: textValue(result, ['name', 'companyName', 'businessName', 'enterpriseName', '企业名称', '营业执照名称', '名称']),
    merBlis: textValue(result, ['creditCode', 'registerNumber', 'socialCreditCode', 'regNum', 'registrationNumber', '统一社会信用代码', '社会信用代码', '注册号']),
    merRegAddr,
    merRegProvinceCode: registeredRegion.provinceCode || undefined,
    merRegCityCode: registeredRegion.cityCode || undefined,
    merRegDistCode: registeredRegion.countyCode || undefined,
    larName: textValue(result, ['legalPerson', 'legalRepresentative', 'legalPersonName', '法人', '法定代表人', '经营者']),
    merBlisStDt: formatDate(textValue(result, ['validPeriodStart', 'validFromDate', 'startDate', 'validFrom', 'establishDate', 'RegistrationDate', 'registrationDate', '成立日期', '有效期起始日期'])),
    merBlisExpDt: formatDate(expiry),
    merBlisLongTerm: /长期|永久/i.test(expiry ?? '') ? 'true' : undefined,
  }
}

function valueByKey(record: UnknownRecord, key: string): unknown {
  if (key in record) return record[key]
  const actualKey = Object.keys(record).find((item) => item.toLowerCase() === key.toLowerCase())
  return actualKey ? record[actualKey] : undefined
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function unwrapResponse(value: unknown): UnknownRecord {
  let current = value
  for (let depth = 0; depth < 5; depth += 1) {
    current = parseMaybeJson(current)
    const record = asRecord(current)
    if (!Object.keys(record).length) break
    const nested = valueByKey(record, 'data') ?? valueByKey(record, 'result') ?? valueByKey(record, 'body')
    if (nested === undefined) return record
    current = nested
  }
  return asRecord(current)
}

function textValue(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = valueByKey(record, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function formatDate(value?: string): string | undefined {
  if (!value || /长期|永久/i.test(value)) return undefined
  const digits = value.replace(/\D/g, '')
  if (digits.length < 8) return value
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

function dateRange(value?: string): { start?: string; end?: string; longTerm?: string } {
  if (!value) return {}
  const normalized = value.replace(/年|月/g, '.').replace(/日/g, '')
  const dates = normalized.match(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g) ?? []
  return {
    start: formatDate(dates[0]),
    end: formatDate(dates[1]),
    longTerm: /长期|永久/i.test(value) ? 'true' : undefined,
  }
}

function flattenWords(record: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = { ...record }
  for (const key of ['prism_wordsInfo', 'prismWordsInfo', 'wordsInfo', 'wordInfo', 'items']) {
    const values = valueByKey(record, key)
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const item = asRecord(value)
      const field = textValue(item, ['key', 'name', 'label', 'fieldName', '字段'])
      const content = textValue(item, ['word', 'value', 'text', 'content', '字段值'])
      if (field && content) out[field] = content
    }
  }
  return out
}

function createClient() {
  const accessKeyId = requiredEnv('ALIYUN_OCR_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID')
  const accessKeySecret = requiredEnv('ALIYUN_OCR_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET')
  const config = new Config({ accessKeyId, accessKeySecret })
  config.endpoint = process.env.ALIYUN_OCR_ENDPOINT?.trim() || 'ocr-api.cn-hangzhou.aliyuncs.com'
  return {
    client: new OcrClient(config),
    runtimeOptions: new RuntimeOptions({
      readTimeout: Number(process.env.ALIYUN_OCR_READ_TIMEOUT_MS || 20_000),
      connectTimeout: Number(process.env.ALIYUN_OCR_CONNECT_TIMEOUT_MS || 10_000),
      autoretry: true,
      maxAttempts: 2,
    }),
  }
}

async function runRecognition(
  kind: 'businessLicense' | 'idCard',
  file: OcrFile,
  extra: UnknownRecord = {},
): Promise<UnknownRecord> {
  const { client, runtimeOptions } = createClient()
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const requestInput = {
      body: Readable.from(buffer),
      ...extra,
    }
    const response = kind === 'businessLicense'
      ? await client.recognizeBusinessLicenseWithOptions(
        new RecognizeBusinessLicenseRequest(requestInput),
        runtimeOptions,
      )
      : await client.recognizeIdcardWithOptions(
        new RecognizeIdcardRequest(requestInput),
        runtimeOptions,
      )
    return flattenWords(unwrapResponse(response.body ?? response))
  } catch (error) {
    if (error instanceof OcrConfigurationError) throw error
    // OCR SDK 异常可能回显上传资料或供应商原始响应，日志只保留固定事件名。
    console.error('Aliyun OCR request failed')
    throw new OcrServiceError()
  }
}

export async function recognizeBusinessLicense(file: OcrFile): Promise<BusinessLicenseOcrResult> {
  if (ocrMode() === 'mock') return mockBusinessLicense()
  const result = await runRecognition('businessLicense', file)
  const parsed = parseAliyunBusinessLicenseResult(result)
  if (!Object.values(parsed).some(Boolean)) throw new OcrServiceError('OCR 未识别出营业执照字段，请手动填写')
  return parsed
}

export async function recognizeIdCard(file: OcrFile, side: 'face' | 'back'): Promise<IdCardOcrResult> {
  if (ocrMode() === 'mock') return mockIdCard(side)
  const result = await runRecognition('idCard', file, { side })
  const parsed = parseAliyunIdCardResult(result, side)
  if (!Object.values(parsed).some((value) => value && value !== side)) {
    throw new OcrServiceError('OCR 未识别出身份证字段，请手动填写')
  }
  return parsed
}
