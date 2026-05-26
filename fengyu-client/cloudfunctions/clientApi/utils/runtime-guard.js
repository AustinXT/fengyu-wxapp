/**
 * 运行时环境守卫（顾客端）
 *
 * 测试旁路（_testOpenid 身份覆盖 / phoneNumber 明文直传）只允许在「非生产环境」
 * 且对应 env 开关显式开启时生效。生产环境由「运行时真实 envId」硬闸强制禁用：
 * `cloud.getWXContext().ENV` 是微信平台注入的当前云环境 id，客户端不可篡改。
 *
 * 即使 prod 函数 env 被误配为 ALLOW_TEST_OPENID=true，本硬闸也不会放行——
 * 不依赖运维把 env 设对（client 的 directPhone 旁路原本完全无门控、任意环境裸奔）。
 *
 * ⚠️ 各端独立副本（禁止抽取 cloudfunctions-shared），逻辑与 staffApi 对齐，
 *    仅 PROD_ENV_IDS 内容不同。新增/迁移 prod 环境时需同步维护此白名单。
 */

const cloud = require('wx-server-sdk')

// 生产云环境 id 白名单（顾客端）
const PROD_ENV_IDS = new Set([
  'fengyu-client-prod-d1cga6909c0ba',
])

/**
 * 当前调用是否运行在生产云环境（运行时 envId 命中白名单）
 * @returns {boolean}
 */
function isProdRuntime() {
  try {
    return PROD_ENV_IDS.has(cloud.getWXContext().ENV)
  } catch (e) {
    // getWXContext 不可用（如本地单测未 mock ENV）时按非生产处理
    return false
  }
}

/**
 * 测试旁路开关是否允许生效 = env 显式开启 且 非生产运行时
 * @param {string} envFlag - 环境变量名（'ALLOW_TEST_OPENID' / 'ALLOW_DIRECT_PHONE'）
 * @returns {boolean}
 */
function testBypassAllowed(envFlag) {
  return process.env[envFlag] === 'true' && !isProdRuntime()
}

module.exports = { isProdRuntime, testBypassAllowed, PROD_ENV_IDS }
