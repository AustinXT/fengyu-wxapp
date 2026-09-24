const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { HEALTH_WINDOW_MS, verifyHealthPayload } = require('../utils/system-health')

const ORIGINAL_SECRET = process.env.CLIENT_SECRET

function payload(service, timestamp = Date.now(), nonce = '12345678-1234-1234-1234-123456789abc') {
  const value = { service, timestamp: String(timestamp), nonce }
  return {
    ...value,
    signature: crypto.createHmac('sha256', process.env.CLIENT_SECRET)
      .update(`${service}\n${value.timestamp}\n${nonce}`)
      .digest('hex'),
  }
}

describe('system health HMAC contract', () => {
  beforeEach(() => { process.env.CLIENT_SECRET = 'health-test-secret' })
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.CLIENT_SECRET
    else process.env.CLIENT_SECRET = ORIGINAL_SECRET
  })

  it('接受服务名绑定且未过期的签名', () => {
    const now = Date.now()
    expect(() => verifyHealthPayload(payload('staffApi', now), 'staffApi', now)).not.toThrow()
  })

  it('拒绝篡改、跨服务重放和过期签名', () => {
    const now = Date.now()
    const valid = payload('staffApi', now)
    expect(() => verifyHealthPayload({ ...valid, signature: '0'.repeat(64) }, 'staffApi', now)).toThrow(/UNAUTHORIZED/)
    expect(() => verifyHealthPayload(valid, 'clientApi', now)).toThrow(/UNAUTHORIZED/)
    expect(() => verifyHealthPayload(payload('staffApi', now - HEALTH_WINDOW_MS - 1), 'staffApi', now)).toThrow(/UNAUTHORIZED/)
  })

  it('三个云函数保持同一份签名契约', () => {
    const own = fs.readFileSync(path.join(__dirname, '../utils/system-health.js'), 'utf8')
    const client = fs.readFileSync(path.join(__dirname, '../../../../fengyu-client/cloudfunctions/clientApi/utils/system-health.js'), 'utf8')
    const payNotify = fs.readFileSync(path.join(__dirname, '../../../../fengyu-client/cloudfunctions/payNotify/utils/system-health.js'), 'utf8')
    expect(client).toBe(own)
    expect(payNotify).toBe(own)
  })
})
