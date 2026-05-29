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
 *   LAKALA_NOTIFY_URL           异步通知 HTTPS URL（CloudBase HTTP 触发器地址）
 *   LAKALA_CALLBACK_IP_WHITELIST  逗号分隔的回调 IP 白名单（'*' 跳过校验）
 *
 *   LAKALA_ENV                  'release' / 'trial'（前端跳转小程序 envVersion，聚合主扫已不用，保留兼容）
 *
 *   LAKALA_SUB_APPID            微信小程序 sub_appid（聚合主扫 trans_type=71 必送，
 *                                 client 小程序固定 wx811eb4ded3dfba3f，未配置时兜底硬编码）
 *   LAKALA_ALIPAY_SHARE_SOURCE  支付宝吱口令 acc_busi_fields.source（ISV 公司名缩写，
 *                                 由拉卡拉商务对接确认；未配置时 alipayPay 自动报 ALIPAY_NOT_AVAILABLE）
 *
 * 已删除（一店一商户原则，env 不留默认；支付失败就让失败，不兜底）：
 *   LAKALA_DEFAULT_MERCHANT_NO / LAKALA_DEFAULT_TERM_NO — stores 表必填，未配则报 LAKALA_NOT_CONFIGURED/LAKALA_TERM_NO_MISSING
 *   LAKALA_SM4_KEY — special_create_encry 加密变体从未启用，聚合主扫迁移后彻底无引用
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
])

/**
 * PEM 换行归一化：部分部署/加载链路（dotenv 未展开、cloudbaserc 单行写法等）会把换行存成
 * 字面量 "\n"，而 Node crypto 只认真实换行，否则 createSign/createVerify 报
 * `DECODER routines::unsupported`，导致加签/验签全部失败（拉卡拉联调"全被拒"根因）。
 * 这里把字面 "\n" 统一还原成真实换行；本身已是真实换行时为幂等空操作。
 */
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
  // 微信小程序 sub_appid（聚合主扫 trans_type=71 必送）：兜底硬编码 client appid
  const subAppid = process.env.LAKALA_SUB_APPID || 'wx811eb4ded3dfba3f'
  // 支付宝吱口令 source：不硬编码，未配置时 alipayPay 自动报 ALIPAY_NOT_AVAILABLE
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
