/**
 * clientApi 云函数入口
 * 客户端统一接口,按 action 字段路由分发
 *
 * 入口分流：
 *   1. event.httpMethod 存在 → HTTP 触发器入口（仅 staffApi 跨 env 转上传走此路径，
 *      HMAC + 时间戳 + allowlist 三重守卫，详见 handleHttpEntry）
 *   2. 其他 → 原 cloud.callFunction 入口（小程序前端 + admin callClientFunction）
 */

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入中间件
const { auth } = require('./middleware/auth')
const { buildErrorResponse } = require('./utils/error-codes')

// HTTP 触发器仅放白名单 action（其他即使签对了也 403）
// 任何新增需要 HTTP 暴露的 action 必须显式加这里
const HTTP_ACTION_ALLOWLIST = new Set(['auth.uploadStaffAvatar'])

// HMAC 时间戳容忍窗口（±5min）
const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000

// 路由映射表 —— 懒加载：只在匹配到 action 时才 require 对应模块
const routes = {
  'auth.login': () => require('./routes/auth').login,
  'auth.bindPhone': () => require('./routes/auth').bindPhone,
  'auth.bindStore': () => require('./routes/auth').bindStore,
  'auth.updateProfile': () => require('./routes/auth').updateProfile,
  'auth.uploadAvatar': () => require('./routes/auth').uploadAvatar,
  // 跨 env 入口：仅供 staffApi 通过 HTTP 触发器 + HMAC 调用，cloud.callFunction 直调被 _fromHttp 守卫拒绝
  'auth.uploadStaffAvatar': () => require('./routes/auth').uploadStaffAvatar,
  'store.list': () => require('./routes/store').list,
  'store.detail': () => require('./routes/store').detail,
  'store.requestUnbind': () => require('./routes/store').requestUnbind,
  'store.getUnbindRequest': () => require('./routes/store').getUnbindRequest,
  'store.cancelUnbindRequest': () => require('./routes/store').cancelUnbindRequest,
  'store.geocode': () => require('./routes/store').geocode,
  'product.categories': () => require('./routes/product').categories,
  'product.spuList': () => require('./routes/product').spuList,
  'product.skuDetail': () => require('./routes/product').skuDetail,
  'product.spuDetail': () => require('./routes/product').spuDetail,
  'product.hotList': () => require('./routes/product').hotList,
  'product.shopInit': () => require('./routes/product').shopInit,
  'product.experienceCardList': () => require('./routes/product').experienceCardList,
  'staff.list': () => require('./routes/staff').list,
  'staff.default': () => require('./routes/staff').defaultStaff,
  'staff.detail': () => require('./routes/staff').detail,
  'order.create': () => require('./routes/order').create,
  'order.pay': () => require('./routes/order').pay,
  'order.alipayPay': () => require('./routes/order').alipayPay,
  'order.offlinePay': () => require('./routes/order').offlinePay,
  'order.list': () => require('./routes/order').list,
  'order.detail': () => require('./routes/order').detail,
  'order.cancel': () => require('./routes/order').cancel,
  'order.appointableItems': () => require('./routes/order').appointableItems,
  'order.scanDetail': () => require('./routes/order').scanDetail,
  'order.scanAdjust': () => require('./routes/order').scanAdjust,
  'order.confirmPrepaidFull': () => require('./routes/order').confirmPrepaidFull,
  'order.repay': () => require('./routes/order').repay,
  'appointment.create': () => require('./routes/appointment').create,
  'appointment.list': () => require('./routes/appointment').list,
  'appointment.cancel': () => require('./routes/appointment').cancel,
  'service.detail': () => require('./routes/service').detail,
  'service.list': () => require('./routes/service').list,
  'coupon.list': () => require('./routes/coupon').list,
  'coupon.available': () => require('./routes/coupon').available,
  'points.balance': () => require('./routes/points').balance,
  'points.history': () => require('./routes/points').history,
  'message.list': () => require('./routes/message').list,
  'message.read': () => require('./routes/message').read,
  'message.unreadCount': () => require('./routes/message').unreadCount,
  'card.list': () => require('./routes/card').list,
  'card.balance': () => require('./routes/card').balance,
  'card.history': () => require('./routes/card').history,
  'card.rechargeConfig': () => require('./routes/card').rechargeConfig,
  'card.recharge': () => require('./routes/card').recharge,
  'config.banners': () => require('./routes/config').banners,
  'config.fengyuguan': () => require('./routes/config').fengyuguan,
  'config.invalidateConfig': () => require('./routes/config').invalidateConfig
}

/**
 * 云函数入口函数
 */
exports.main = async (event, context) => {
  // ─── HTTP 触发器入口分流 ───
  // CloudBase HTTP 触发器把 event 包成 {httpMethod, headers, body, ...}
  // 命中此分支即走 HMAC 校验链路，不走 cloud.callFunction 默认 auth 中间件
  if (event && event.httpMethod) {
    return await handleHttpEntry(event, context)
  }

  const { action, payload } = event

  // 参数校验
  if (!action) {
    return { code: -1, message: '缺少 action 参数' }
  }

  // 查找路由（懒加载：首次调用时才 require 对应模块）
  const resolver = routes[action]
  if (!resolver) {
    return { code: -1, message: `未知的 action: ${action}` }
  }
  const handler = resolver()

  // 构造上下文
  const ctx = {
    event,
    context,
    auth: {}, // 将由认证中间件填充
    result: null
  }

  // 无需认证的公开接口
  // config.invalidateConfig 虽列于此，但授信前提是 admin 通过 CloudBase node-sdk 持密调用；
  // 被恶意调用的副作用仅限清一次进程内缓存，不涉及数据写入。
  const publicActions = ['config.banners', 'config.fengyuguan', 'config.invalidateConfig', 'card.rechargeConfig']

  try {
    if (publicActions.includes(action)) {
      // 公开接口，跳过认证
      await handler(ctx)
    } else {
      // 执行中间件链 + 业务处理
      await auth(ctx, async () => {
        await handler(ctx)
      })
    }

    return {
      code: 0,
      message: 'success',
      data: ctx.result
    }
  } catch (error) {
    console.error(`[${action}] Error:`, error)
    return buildErrorResponse(error)
  }
}

/**
 * HTTP 触发器入口（跨 env 转上传专用通道）
 *
 * 调用方：staffApi 通过 HTTPS POST 转发头像上传（详见 fengyu-staff/cloudfunctions/staffApi/routes/staff.js uploadAvatar）
 *
 * 守卫链：
 *   1. 仅接受 POST + JSON body
 *   2. x-fengyu-signature 头必须 = HMAC-SHA256(rawBody, CLIENT_SECRET)，timingSafeEqual 比较
 *   3. body.timestamp 必须在 ±5min 内（防重放）
 *   4. body.action 必须在 HTTP_ACTION_ALLOWLIST（即使 HMAC 持有者也不能打其他接口）
 *
 * 校验通过后向 ctx.event 注入 _fromHttp=true + _hmacVerified=true，
 * 路由函数自身可二次断言（如 auth.uploadStaffAvatar 拒绝任何缺这两个 flag 的调用）。
 *
 * 错误响应统一 statusCode=200 + body.code != 0（CloudBase HTTP 触发器对非 2xx
 * 状态码会改写响应体，统一用 200 + 业务 code 让客户端正常解析）。
 */
async function handleHttpEntry(event, context) {
  const jsonResp = (codeOrObj) => {
    const body = typeof codeOrObj === 'object' ? codeOrObj : { code: codeOrObj }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  }

  if (event.httpMethod !== 'POST') {
    return jsonResp({ code: -1, message: 'Method not allowed' })
  }

  const headers = event.headers || {}
  const sig = headers['x-fengyu-signature'] || headers['X-Fengyu-Signature']
  if (!sig) {
    return jsonResp({ code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 缺少签名头' })
  }

  const secret = process.env.CLIENT_SECRET
  if (!secret) {
    console.error('[HTTP] CLIENT_SECRET 未配置')
    return jsonResp({ code: -1, message: '服务器内部错误：CLIENT_SECRET 未配置' })
  }

  const rawBody = event.body || ''
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const sigBuf = Buffer.from(String(sig))
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return jsonResp({ code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 签名不匹配' })
  }

  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch (e) {
    return jsonResp({ code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: JSON 解析失败' })
  }

  const { action, payload, timestamp } = parsed
  const tsNum = Number(timestamp)
  if (!tsNum || Math.abs(Date.now() - tsNum) > HMAC_TIMESTAMP_WINDOW_MS) {
    return jsonResp({ code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 时间戳过期或缺失' })
  }

  if (!action) {
    return jsonResp({ code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 缺少 action' })
  }
  if (!HTTP_ACTION_ALLOWLIST.has(action)) {
    return jsonResp({ code: -403, errorType: 'PERMISSION_DENIED', message: `PERMISSION_DENIED: 该 action 不暴露 HTTP 入口` })
  }

  const resolver = routes[action]
  if (!resolver) {
    return jsonResp({ code: -1, message: `未知 action: ${action}` })
  }
  const handler = resolver()

  const ctx = {
    event: { ...event, payload: payload || {}, _fromHttp: true, _hmacVerified: true },
    context,
    auth: {},
    result: null,
  }

  try {
    await handler(ctx)
    return jsonResp({ code: 0, message: 'success', data: ctx.result })
  } catch (err) {
    console.error(`[HTTP ${action}] Error:`, err)
    return jsonResp(buildErrorResponse(err))
  }
}
