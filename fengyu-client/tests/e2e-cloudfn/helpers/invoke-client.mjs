/**
 * client 端 invokeClientApi wrapper
 *
 * 在调用前设置 globalThis.__e2e_current_openid__，让 wx-server-sdk-mock 的
 * cloud.getWXContext().OPENID 返回测试 openid。
 * 这是为了支持那些直接读 cloud.getWXContext() 的路由（auth.login / bindStore /
 * bindPhone / updateProfile / uploadAvatar），它们不走 auth 中间件 _testOpenid 路径。
 *
 * 同时 _testOpenid 也注入到 payload，让需要 auth 中间件的路由也能识别。
 *
 * 用法：
 *   const res = await invokeAs(TEST_CLIENT_OPENID, 'auth.login', {})
 *   const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', { items: [...] })
 *
 * 不传 openid（公开接口）：
 *   const res = await invokePublic('store.list', {})
 */
import { invokeClientApi as rawInvoke } from './invoke.mjs'

export async function invokeAs(openid, action, payload = {}) {
  if (!openid) throw new Error('invokeAs: openid required')
  globalThis.__e2e_current_openid__ = openid
  try {
    return await rawInvoke(action, { _testOpenid: openid, ...payload })
  } finally {
    delete globalThis.__e2e_current_openid__
  }
}

export async function invokePublic(action, payload = {}) {
  delete globalThis.__e2e_current_openid__
  return await rawInvoke(action, payload)
}

// 透传给需要更精细控制的场景
export { rawInvoke as invokeClientApiRaw }

/**
 * 断言云函数响应是某种已知错误。
 *
 * clientApi/index.js 错误处理特性：
 *  - errorType 字段 = 已知错误前缀（INVALID_PARAMS/UNAUTHORIZED/PHONE_REQUIRED/
 *    PERMISSION_DENIED/NOT_FOUND/INSUFFICIENT_BALANCE），未知前缀时为 null
 *  - message 字段 = 已知前缀错误的 message 会被 strip 掉前缀；未知错误统一替换为 '服务器内部错误'
 *  - code: -401=UNAUTHORIZED, -403=PHONE_REQUIRED|PERMISSION_DENIED, -400=INVALID_PARAMS, -404=NOT_FOUND, -1=其他
 *
 * 用法：
 *   expectError(res, 'INVALID_PARAMS')
 *   expectError(res, 'INVALID_PARAMS', { messageIncludes: '已绑定' })
 *   expectError(res, 'PHONE_REQUIRED')
 *
 * @throws Error if 不符
 */
export function expectError(res, errorType, opts = {}) {
  if (res.code === 0) {
    throw new Error(`expect error errorType=${errorType}, but got success: ${JSON.stringify(res.data)}`)
  }
  if (errorType && res.errorType !== errorType) {
    throw new Error(
      `expect errorType=${errorType}, got errorType=${res.errorType ?? 'null'} (code=${res.code}, message="${res.message}")`
    )
  }
  if (opts.messageIncludes && !String(res.message ?? '').includes(opts.messageIncludes)) {
    throw new Error(
      `expect message includes "${opts.messageIncludes}", got: "${res.message}"`
    )
  }
  if (opts.code !== undefined && res.code !== opts.code) {
    throw new Error(`expect code=${opts.code}, got ${res.code}`)
  }
}

/**
 * 断言云函数响应成功
 */
export function expectSuccess(res) {
  if (res.code !== 0) {
    throw new Error(`expect success (code=0), got code=${res.code} errorType=${res.errorType} message="${res.message}"`)
  }
  return res.data
}
