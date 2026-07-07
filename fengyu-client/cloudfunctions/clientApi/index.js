



process.env.TZ = 'Asia/Shanghai'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })


const { auth } = require('./middleware/auth')
const { buildErrorResponse } = require('./utils/error-codes')
const { extractAppVersion } = require('./utils/app-version')



const HTTP_ACTION_ALLOWLIST = new Set(['auth.uploadStaffAvatar'])


const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000


const routes = {
  'auth.login': () => require('./routes/auth').login,
  'auth.bindPhone': () => require('./routes/auth').bindPhone,
  'auth.bindStore': () => require('./routes/auth').bindStore,
  'auth.updateProfile': () => require('./routes/auth').updateProfile,
  'auth.uploadAvatar': () => require('./routes/auth').uploadAvatar,
  
  'auth.uploadStaffAvatar': () => require('./routes/auth').uploadStaffAvatar,
  'store.list': () => require('./routes/store').list,
  'store.detail': () => require('./routes/store').detail,
  'store.requestUnbind': () => require('./routes/store').requestUnbind,
  'store.getUnbindRequest': () => require('./routes/store').getUnbindRequest,
  'store.cancelUnbindRequest': () => require('./routes/store').cancelUnbindRequest,
  'store.geocode': () => require('./routes/store').geocode,
  'product.categories': () => require('./routes/product').categories,
  'product.spuList': () => require('./routes/product').spuList,
  'product.search': () => require('./routes/product').search,
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
  'order.queryLakalaStatus': () => require('./routes/order').queryLakalaStatus,
  'order.confirmPayment': () => require('./routes/order').confirmPayment,
  'appointment.create': () => require('./routes/appointment').create,
  'appointment.list': () => require('./routes/appointment').list,
  'appointment.cancel': () => require('./routes/appointment').cancel,
  'service.detail': () => require('./routes/service').detail,
  'service.list': () => require('./routes/service').list,
  'service.confirm': () => require('./routes/service').confirm,
  'service.createReview': () => require('./routes/service').createReview,
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
  'config.shareGift': () => require('./routes/config').shareGift,
  'config.invalidateConfig': () => require('./routes/config').invalidateConfig,
  'config.consumeAgreement': () => require('./routes/config').consumeAgreement
}


exports.main = async (event, context) => {
  
  
  
  if (event && event.httpMethod) {
    return await handleHttpEntry(event, context)
  }

  const { action, payload } = event

  
  if (!action) {
    return { code: -1, message: '缺少 action 参数' }
  }

  
  const resolver = routes[action]
  if (!resolver) {
    return { code: -1, message: `未知的 action: ${action}` }
  }
  const handler = resolver()

  
  const ctx = {
    event,
    context,
    auth: {}, 
    appVersion: extractAppVersion(payload), 
    result: null
  }

  
  
  
  const publicActions = ['config.banners', 'config.fengyuguan', 'config.shareGift', 'config.consumeAgreement', 'config.invalidateConfig', 'card.rechargeConfig']

  try {
    if (publicActions.includes(action)) {
      
      await handler(ctx)
    } else {
      
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
    appVersion: extractAppVersion(payload), 
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
