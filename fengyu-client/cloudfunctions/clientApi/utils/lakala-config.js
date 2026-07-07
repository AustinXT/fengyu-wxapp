

'use strict'

const REQUIRED_VARS = Object.freeze([
  'LAKALA_API_BASE',
  'LAKALA_APPID',
  'LAKALA_SERIAL_NO',
  'LAKALA_PRIVATE_KEY_PEM',
  'LAKALA_PLATFORM_CERT_PEM',
])


function normalizePem(s) {
  return (s || '').replace(/\\n/g, '\n')
}

function readConfig() {
  const apiBase = process.env.LAKALA_API_BASE || ''
  const appid = process.env.LAKALA_APPID || ''
  const serialNo = process.env.LAKALA_SERIAL_NO || ''
  const privateKeyPem = normalizePem(process.env.LAKALA_PRIVATE_KEY_PEM || '')
  const platformCertPem = normalizePem(process.env.LAKALA_PLATFORM_CERT_PEM || '')
  const notifyUrl = process.env.LAKALA_NOTIFY_URL || ''
  const ipWhitelist = process.env.LAKALA_CALLBACK_IP_WHITELIST || ''
  const env = process.env.LAKALA_ENV || 'trial'
  
  const subAppid = process.env.LAKALA_SUB_APPID || 'wx811eb4ded3dfba3f'
  
  const alipayShareSource = process.env.LAKALA_ALIPAY_SHARE_SOURCE || ''

  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    appid,
    serialNo,
    privateKeyPem,
    platformCertPem,
    notifyUrl,
    ipWhitelist: ipWhitelist === '*' ? null : ipWhitelist.split(',').map((s) => s.trim()).filter(Boolean),
    ipWhitelistOpen: ipWhitelist === '*',
    env: env === 'release' ? 'release' : 'trial',
    subAppid,
    alipayShareSource,
  }
}


function isReady() {
  return REQUIRED_VARS.every((k) => (process.env[k] || '').length > 0)
}


function missingVars() {
  return REQUIRED_VARS.filter((k) => !(process.env[k] || '').length)
}


function assertReady() {
  const missing = missingVars()
  if (missing.length > 0) {
    throw new Error(`INVALID_STATE: LAKALA_NOT_CONFIGURED: 缺少环境变量 ${missing.join(',')}`)
  }
}

module.exports = {
  REQUIRED_VARS,
  readConfig,
  isReady,
  missingVars,
  assertReady,
}
