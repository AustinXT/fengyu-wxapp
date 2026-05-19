/**
 * 拉卡拉对接 — 环境变量集中读取 + 启动预检
 *
 * 与 fengyu-client/cloudfunctions/payNotify/utils/lakala-config.js
 *    fengyu-staff/cloudfunctions/staffApi/utils/lakala-config.js
 *    fengyu-admin/src/lib/lakala-config.ts
 * 四份独立副本，跨端一致性靠 snapshot 测试守护。
 *
 * 环境变量清单（必填项缺失会让 isReady() 返回 false，业务路由可据此拒绝拉卡拉调用）：
 *   LAKALA_API_BASE             https 调用基地址（测试 https://test.wsmsd.cn/sit/api，生产 https://s2.lakala.com/api）
 *   LAKALA_APPID                接入方 appid（OP00000003 测试号）
 *   LAKALA_SERIAL_NO            接入方加签证书序列号
 *   LAKALA_PRIVATE_KEY_PEM      接入方加签私钥 PEM（含 BEGIN/END 头尾）
 *   LAKALA_PLATFORM_CERT_PEM    拉卡拉平台公钥证书 PEM（验签用）
 *
 *   LAKALA_DEFAULT_MERCHANT_NO  门店未配置时的默认商户号
 *   LAKALA_DEFAULT_TERM_NO      门店未配置时的默认终端号
 *
 *   LAKALA_NOTIFY_URL           异步通知 HTTPS URL（CloudBase HTTP 触发器地址）
 *   LAKALA_CALLBACK_IP_WHITELIST  逗号分隔的回调 IP 白名单（'*' 跳过校验）
 *
 *   LAKALA_SM4_KEY              SM4 Key（base64，仅 special_create_encry 加密变体用）
 *   LAKALA_ENV                  'release' / 'trial'（前端跳转小程序 envVersion）
 *
 * 加签算法见 sources/documents/拉卡拉接口规范-补充.md「安全统一接入规范」。
 */

'use strict'

const REQUIRED_VARS = Object.freeze([
  'LAKALA_API_BASE',
  'LAKALA_APPID',
  'LAKALA_SERIAL_NO',
  'LAKALA_PRIVATE_KEY_PEM',
  'LAKALA_PLATFORM_CERT_PEM',
  'LAKALA_DEFAULT_MERCHANT_NO',
  'LAKALA_DEFAULT_TERM_NO',
])

function readConfig() {
  const apiBase = process.env.LAKALA_API_BASE || ''
  const appid = process.env.LAKALA_APPID || ''
  const serialNo = process.env.LAKALA_SERIAL_NO || ''
  const privateKeyPem = process.env.LAKALA_PRIVATE_KEY_PEM || ''
  const platformCertPem = process.env.LAKALA_PLATFORM_CERT_PEM || ''
  const defaultMerchantNo = process.env.LAKALA_DEFAULT_MERCHANT_NO || ''
  const defaultTermNo = process.env.LAKALA_DEFAULT_TERM_NO || ''
  const notifyUrl = process.env.LAKALA_NOTIFY_URL || ''
  const ipWhitelist = process.env.LAKALA_CALLBACK_IP_WHITELIST || ''
  const sm4Key = process.env.LAKALA_SM4_KEY || ''
  const env = process.env.LAKALA_ENV || 'trial'

  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    appid,
    serialNo,
    privateKeyPem,
    platformCertPem,
    defaultMerchantNo,
    defaultTermNo,
    notifyUrl,
    ipWhitelist: ipWhitelist === '*' ? null : ipWhitelist.split(',').map((s) => s.trim()).filter(Boolean),
    ipWhitelistOpen: ipWhitelist === '*',
    sm4Key,
    env: env === 'release' ? 'release' : 'trial',
  }
}

/**
 * 是否所有必填变量都已配置（不抛错，业务路由用这个判断是否走真实拉卡拉调用还是 fallback）
 */
function isReady() {
  return REQUIRED_VARS.every((k) => (process.env[k] || '').length > 0)
}

/**
 * 列出缺失的必填变量。
 */
function missingVars() {
  return REQUIRED_VARS.filter((k) => !(process.env[k] || '').length)
}

/**
 * 强制断言所有必填变量都已配置；不通过抛 INVALID_STATE。
 * 业务路由在调拉卡拉前调一次，启动期失败优于运行期失败。
 */
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
