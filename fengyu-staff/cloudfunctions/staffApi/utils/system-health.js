'use strict'

const crypto = require('crypto')

const HEALTH_WINDOW_MS = 5 * 60 * 1000

function verifyHealthPayload(payload, expectedService, now = Date.now()) {
  const secret = process.env.CLIENT_SECRET
  if (!secret) throw new Error('INVALID_STATE: HEALTH_SECRET_MISSING: health secret is not configured')
  const service = payload && String(payload.service || '')
  const timestamp = payload && String(payload.timestamp || '')
  const nonce = payload && String(payload.nonce || '')
  const signature = payload && String(payload.signature || '')
  const timestampNumber = Number(timestamp)
  if (
    service !== expectedService
    || !timestampNumber
    || Math.abs(now - timestampNumber) > HEALTH_WINDOW_MS
    || !/^[0-9a-f-]{16,64}$/i.test(nonce)
    || !/^[0-9a-f]{64}$/i.test(signature)
  ) {
    throw new Error('UNAUTHORIZED: HEALTH_SIGNATURE_INVALID: health signature is invalid')
  }
  const expected = crypto.createHmac('sha256', secret)
    .update(`${service}\n${timestamp}\n${nonce}`)
    .digest('hex')
  const actualBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('UNAUTHORIZED: HEALTH_SIGNATURE_INVALID: health signature is invalid')
  }
}

module.exports = { HEALTH_WINDOW_MS, verifyHealthPayload }
