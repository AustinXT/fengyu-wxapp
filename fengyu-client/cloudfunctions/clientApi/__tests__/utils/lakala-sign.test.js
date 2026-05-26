/**
 * 拉卡拉加签验签单元测试
 *
 * 用 Node crypto 生成一对临时 RSA-2048 密钥对，做加签 → 验签往返；
 * 不依赖真实拉卡拉证书，专注算法正确性。
 *
 * 覆盖：
 *   - randomNonce 长度 + 字符集
 *   - buildSignTarget5 / buildSignTarget3 字面量（含末尾 \n）
 *   - buildRequestAuthorization 生成 + verifyResponseSignature 5 行往返验签
 *   - verifyAsyncNotification 3 行往返验签（含 body 必须用原始字节）
 *   - parseAuthorizationHeader 解析 5 字段 / 3 字段
 *   - 签名篡改 → 验签失败
 *   - body 不一致 → 验签失败
 *   - 末尾 \n 丢失 → 验签失败（拉卡拉文档强调的 90% 错误来源）
 */

const crypto = require('crypto')
const sign = require('../../utils/lakala-sign')

describe('lakala-sign', () => {
  let privateKeyPem
  let publicKeyPem

  beforeAll(() => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    privateKeyPem = privateKey
    publicKeyPem = publicKey
  })

  describe('randomNonce', () => {
    it('default length is 12', () => {
      expect(sign.randomNonce()).toHaveLength(12)
    })
    it('charset is alphanumeric', () => {
      const n = sign.randomNonce(32)
      expect(n).toMatch(/^[A-Za-z0-9]+$/)
    })
    it('two consecutive calls are different', () => {
      const a = sign.randomNonce()
      const b = sign.randomNonce()
      expect(a).not.toBe(b)
    })
  })

  describe('buildSignTarget5', () => {
    it('joins 5 fields with \\n and ends with trailing \\n', () => {
      const target = sign.buildSignTarget5({
        appid: 'OP00000003',
        serialNo: 'abc',
        timestamp: '1610334026',
        nonceStr: '123456789012',
        body: '{"x":1}',
      })
      expect(target).toBe('OP00000003\nabc\n1610334026\n123456789012\n{"x":1}\n')
      expect(target.endsWith('\n')).toBe(true)
    })
  })

  describe('buildSignTarget3', () => {
    it('joins 3 fields with \\n and ends with trailing \\n', () => {
      const target = sign.buildSignTarget3({
        timestamp: '1630905585',
        nonceStr: '9003323344',
        body: '{"foo":"bar"}',
      })
      expect(target).toBe('1630905585\n9003323344\n{"foo":"bar"}\n')
      expect(target.endsWith('\n')).toBe(true)
    })
  })

  describe('buildRequestAuthorization → verifyResponseSignature 往返', () => {
    it('5-line round-trip succeeds', () => {
      const body = JSON.stringify({ req_data: { merchant_no: 'M001' }, version: '3.0', req_time: '20260520120000' })
      const { authorization, timestamp, nonceStr, signature } = sign.buildRequestAuthorization({
        appid: 'OP00000003',
        serialNo: 'serial-001',
        privateKeyPem,
        body,
      })
      // 模拟拉卡拉响应：把同样的字段放回 Lklapi-* Headers
      const ok = sign.verifyResponseSignature({
        headers: {
          'Lklapi-Appid': 'OP00000003',
          'Lklapi-Serial': 'serial-001',
          'Lklapi-Timestamp': timestamp,
          'Lklapi-Nonce': nonceStr,
          'Lklapi-Signature': signature,
        },
        body,
        platformCertPem: publicKeyPem,
      })
      expect(ok).toBe(true)
      expect(authorization).toContain('LKLAPI-SHA256withRSA')
      expect(authorization).toContain(`appid="OP00000003"`)
      expect(authorization).toContain(`serial_no="serial-001"`)
    })

    it('5-line verify fails when body is tampered', () => {
      const body = JSON.stringify({ req_data: {}, version: '3.0', req_time: '20260520120000' })
      const { timestamp, nonceStr, signature } = sign.buildRequestAuthorization({
        appid: 'A',
        serialNo: 'S',
        privateKeyPem,
        body,
      })
      const tampered = body + '__tampered'
      const ok = sign.verifyResponseSignature({
        headers: {
          'Lklapi-Appid': 'A',
          'Lklapi-Serial': 'S',
          'Lklapi-Timestamp': timestamp,
          'Lklapi-Nonce': nonceStr,
          'Lklapi-Signature': signature,
        },
        body: tampered,
        platformCertPem: publicKeyPem,
      })
      expect(ok).toBe(false)
    })

    it('5-line verify fails when signature is tampered', () => {
      const body = JSON.stringify({ x: 1 })
      const { timestamp, nonceStr, signature } = sign.buildRequestAuthorization({
        appid: 'A',
        serialNo: 'S',
        privateKeyPem,
        body,
      })
      const badSig = signature.slice(0, -4) + 'AAAA'
      const ok = sign.verifyResponseSignature({
        headers: {
          'Lklapi-Appid': 'A',
          'Lklapi-Serial': 'S',
          'Lklapi-Timestamp': timestamp,
          'Lklapi-Nonce': nonceStr,
          'Lklapi-Signature': badSig,
        },
        body,
        platformCertPem: publicKeyPem,
      })
      expect(ok).toBe(false)
    })

    it('throws when privateKey missing', () => {
      expect(() => sign.buildRequestAuthorization({
        appid: 'A',
        serialNo: 'S',
        privateKeyPem: '',
        body: '{}',
      })).toThrow(/LAKALA_SIGN_MISSING_KEYS/)
    })

    it('throws when body is not a string', () => {
      expect(() => sign.buildRequestAuthorization({
        appid: 'A',
        serialNo: 'S',
        privateKeyPem,
        body: { x: 1 },
      })).toThrow(/LAKALA_SIGN_BODY_MUST_BE_STRING/)
    })
  })

  describe('verifyAsyncNotification (3 行)', () => {
    it('round-trip succeeds with proper 3-line signature', () => {
      const rawBody = JSON.stringify({
        pay_order_no: '21092211012001970631000488056',
        out_order_no: 'FY-XSD-WX-XXX',
        order_status: '2',
      })
      const timestamp = '1630905585'
      const nonceStr = 'AbCdEf123456'
      const target = sign.buildSignTarget3({ timestamp, nonceStr, body: rawBody })
      const signature = sign.rsaSign(target, privateKeyPem)
      const authorizationHeader = `LKLAPI-SHA256withRSA timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`
      const result = sign.verifyAsyncNotification({
        authorizationHeader,
        rawBody,
        platformCertPem: publicKeyPem,
      })
      expect(result.ok).toBe(true)
    })

    it('fails when missing trailing \\n in body (拉卡拉文档强调 90% 错误来源)', () => {
      const rawBody = '{"x":1}'
      const timestamp = '1630905585'
      const nonceStr = 'AbCdEf123456'
      // 故意丢掉末尾 \n
      const badTarget = `${timestamp}\n${nonceStr}\n${rawBody}`
      const signature = sign.rsaSign(badTarget, privateKeyPem)
      const authorizationHeader = `LKLAPI-SHA256withRSA timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`
      // verifyAsyncNotification 用正确格式（带末尾 \n），所以会 mismatch
      const result = sign.verifyAsyncNotification({
        authorizationHeader,
        rawBody,
        platformCertPem: publicKeyPem,
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('SIGNATURE_MISMATCH')
    })

    it('fails when body has different whitespace (JSON.parse-then-stringify 风险)', () => {
      // 拉卡拉真实回调 body 可能含格式化空白，JSON.parse + JSON.stringify 会丢失
      const originalWithSpaces = '{\n  "pay_order_no": "X",\n  "amount": 100\n}'
      const timestamp = '1700000000'
      const nonceStr = 'XYZ123456789'
      const target = sign.buildSignTarget3({ timestamp, nonceStr, body: originalWithSpaces })
      const signature = sign.rsaSign(target, privateKeyPem)
      const authorizationHeader = `LKLAPI-SHA256withRSA timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`
      // 拿到 raw body 后误用 JSON.parse + stringify → 空白被去掉
      const reSerialized = JSON.stringify(JSON.parse(originalWithSpaces))
      expect(reSerialized).not.toBe(originalWithSpaces)  // 确认确实变了
      const result = sign.verifyAsyncNotification({
        authorizationHeader,
        rawBody: reSerialized,
        platformCertPem: publicKeyPem,
      })
      expect(result.ok).toBe(false)
    })

    it('fails on malformed authorization header', () => {
      const result = sign.verifyAsyncNotification({
        authorizationHeader: 'Bearer xxx',
        rawBody: '{}',
        platformCertPem: publicKeyPem,
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('BAD_AUTHORIZATION_FORMAT')
    })

    it('fails when authorization missing entirely', () => {
      const result = sign.verifyAsyncNotification({
        authorizationHeader: '',
        rawBody: '{}',
        platformCertPem: publicKeyPem,
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('NO_AUTHORIZATION_HEADER')
    })

    it('fails when platformCert missing', () => {
      const result = sign.verifyAsyncNotification({
        authorizationHeader: 'LKLAPI-SHA256withRSA timestamp="1",nonce_str="x",signature="y"',
        rawBody: '{}',
        platformCertPem: '',
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('NO_PLATFORM_CERT')
    })
  })

  describe('parseAuthorizationHeader', () => {
    it('parses 5-field request header', () => {
      const h = 'LKLAPI-SHA256withRSA appid="A",serial_no="S",timestamp="1",nonce_str="N",signature="SIG"'
      const parsed = sign.parseAuthorizationHeader(h)
      expect(parsed).toEqual({
        algorithm: 'LKLAPI-SHA256withRSA',
        appid: 'A',
        serialNo: 'S',
        timestamp: '1',
        nonceStr: 'N',
        signature: 'SIG',
      })
    })

    it('parses 3-field async-notify header', () => {
      const h = 'LKLAPI-SHA256withRSA timestamp="1",nonce_str="N",signature="SIG"'
      const parsed = sign.parseAuthorizationHeader(h)
      expect(parsed.timestamp).toBe('1')
      expect(parsed.nonceStr).toBe('N')
      expect(parsed.signature).toBe('SIG')
      expect(parsed.appid).toBeUndefined()
      expect(parsed.serialNo).toBeUndefined()
    })

    it('returns null on wrong algorithm', () => {
      expect(sign.parseAuthorizationHeader('Bearer xxx')).toBeNull()
    })

    it('returns null on empty input', () => {
      expect(sign.parseAuthorizationHeader('')).toBeNull()
      expect(sign.parseAuthorizationHeader(null)).toBeNull()
    })

    it('handles signature value with =/+/' + '/ (Base64 chars) correctly', () => {
      const sigB64 = 'AbCdEf12+/==XyZ012/=='
      const h = `LKLAPI-SHA256withRSA timestamp="1",nonce_str="N",signature="${sigB64}"`
      const parsed = sign.parseAuthorizationHeader(h)
      expect(parsed.signature).toBe(sigB64)
    })
  })

  describe('lowerCaseHeaders', () => {
    it('converts keys to lowercase', () => {
      const out = sign.lowerCaseHeaders({ 'Content-Type': 'application/json', 'X-Custom': 'a' })
      expect(out['content-type']).toBe('application/json')
      expect(out['x-custom']).toBe('a')
    })
    it('handles undefined input', () => {
      expect(sign.lowerCaseHeaders(undefined)).toEqual({})
    })
  })
})
