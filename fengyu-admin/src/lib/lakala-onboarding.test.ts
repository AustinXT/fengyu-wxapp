import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lakalaDownloadElectronicContract,
  lakalaQueryBanks,
  maskPayload,
} from './lakala-onboarding'

const ENV_KEYS = [
  'LAKALA_ONBOARDING_ENABLED',
  'LAKALA_API_BASE',
  'LAKALA_APPID',
  'LAKALA_SERIAL_NO',
  'LAKALA_PRIVATE_KEY_PEM',
  'LAKALA_PLATFORM_CERT_PEM',
  'LAKALA_SM4_KEY',
]
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

beforeEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('拉卡拉入网日志脱敏', () => {
  it('不会保留证件、银行卡、合同链接、Base64 文件或费率', () => {
    const payload = {
      certNo: '110101199001011234',
      accountNo: '6222021234567890123',
      mobile: '13800138000',
      resultUrl: 'https://supplier.example/contract/private',
      fileBase64: Buffer.from('%PDF-private').toString('base64url'),
      feeData: [{ fee_code: 'WX_RATE', fee_value: '0.38' }],
      mer_addr: '测试省测试市测试区测试路 1 号',
      legal_person: '李四',
      ec_content_parameters: JSON.stringify({
        legal_person: '张三',
        settlement_account_name: '凤御门店',
      }),
      nested: JSON.stringify({ contract_no: 'contract-private', bank_name: '测试银行' }),
    }

    const masked = maskPayload(payload)
    const serialized = JSON.stringify(masked)
    for (const privateValue of [
      '110101199001011234',
      '6222021234567890123',
      '13800138000',
      'supplier.example',
      'contract-private',
      '0.38',
      '测试省测试市测试区测试路 1 号',
      '李四',
      '张三',
      '凤御门店',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(masked.feeData).toBe('[fee policy omitted]')
    expect(masked.ec_content_parameters).toBe('[redacted]')
  })
})

describe('拉卡拉入网鉴权', () => {
  it('开关未启用时不读取支付密钥也不发起网络请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(lakalaQueryBanks({ areaCode: '360100', bankName: '测试银行' }))
      .rejects.toThrow('拉卡拉门店入网未启用')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('下载合同复用标准 LAKALA_* 身份并接受 URL-safe Base64 PDF', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const appId = 'pay-app-id'
    const serialNo = 'pay-serial-no'
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    process.env.LAKALA_API_BASE = 'https://lakala.example/api'
    process.env.LAKALA_APPID = appId
    process.env.LAKALA_SERIAL_NO = serialNo
    process.env.LAKALA_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.LAKALA_PLATFORM_CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    process.env.LAKALA_SM4_KEY = Buffer.alloc(16, 7).toString('base64')

    const rawBody = JSON.stringify({
      code: '000000',
      resp_data: {
        ec_no: 'contract-private',
        file_base64: Buffer.from('%PDF-1.7\nprivate contract').toString('base64url'),
      },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'supplier-response-nonce'
    const signer = createSign('RSA-SHA256')
    signer.update(`${appId}\n${serialNo}\n${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8')
    signer.end()
    const signature = signer.sign(privateKey, 'base64')
    const fetchMock = vi.fn(async () => new Response(rawBody, {
      status: 200,
      headers: {
        'lklapi-appid': appId,
        'lklapi-serial': serialNo,
        'lklapi-timestamp': timestamp,
        'lklapi-nonce': nonce,
        'lklapi-signature': signature,
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await lakalaDownloadElectronicContract({ orderNo: 'ec-order-1' })

    expect(result.success).toBe(true)
    expect(result.pdfBytes?.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lakala.example/api/v3/mms/open_api/ec/download',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringContaining('LKLAPI-SHA256withRSA') }),
      }),
    )
  })

  it('非 JSON 的签名响应仅用于临时解密，不会进入调用结果或审计日志', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const appId = 'pay-app-id'
    const serialNo = 'pay-serial-no'
    const rawBody = 'https://supplier.example/contract/private?customer=private'
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    process.env.LAKALA_API_BASE = 'https://lakala.example/api'
    process.env.LAKALA_APPID = appId
    process.env.LAKALA_SERIAL_NO = serialNo
    process.env.LAKALA_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.LAKALA_PLATFORM_CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    process.env.LAKALA_SM4_KEY = Buffer.alloc(16, 7).toString('base64')

    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'supplier-response-nonce'
    const signer = createSign('RSA-SHA256')
    signer.update(`${appId}\n${serialNo}\n${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8')
    signer.end()
    const signature = signer.sign(privateKey, 'base64')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rawBody, {
      status: 200,
      headers: {
        'lklapi-appid': appId,
        'lklapi-serial': serialNo,
        'lklapi-timestamp': timestamp,
        'lklapi-nonce': nonce,
        'lklapi-signature': signature,
      },
    })))

    const result = await lakalaDownloadElectronicContract({ orderNo: 'ec-order-raw-response' })
    const logged = JSON.stringify(maskPayload(result.raw))

    expect(logged).not.toContain('supplier.example')
    expect(logged).not.toContain('customer=private')
    expect(result.raw).toEqual({})
  })
})
