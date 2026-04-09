/**
 * clientApi 云函数入口
 * 客户端统一接口,按 action 字段路由分发
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入中间件
const { auth } = require('./middleware/auth')

// 路由映射表 —— 懒加载：只在匹配到 action 时才 require 对应模块
const routes = {
  'auth.login': () => require('./routes/auth').login,
  'auth.bindPhone': () => require('./routes/auth').bindPhone,
  'auth.bindStore': () => require('./routes/auth').bindStore,
  'auth.updateProfile': () => require('./routes/auth').updateProfile,
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
  'appointment.create': () => require('./routes/appointment').create,
  'appointment.list': () => require('./routes/appointment').list,
  'appointment.cancel': () => require('./routes/appointment').cancel,
  'service.detail': () => require('./routes/service').detail,
  'service.list': () => require('./routes/service').list,
  'coupon.list': () => require('./routes/coupon').list,
  'coupon.available': () => require('./routes/coupon').available,
  'coupon.redeem': () => require('./routes/coupon').redeem,
  'points.balance': () => require('./routes/points').balance,
  'points.history': () => require('./routes/points').history,
  'message.list': () => require('./routes/message').list,
  'message.read': () => require('./routes/message').read,
  'message.unreadCount': () => require('./routes/message').unreadCount,
  'card.list': () => require('./routes/card').list,
  'card.history': () => require('./routes/card').history,
  'config.banners': () => require('./routes/config').banners,
  'config.fengyuguan': () => require('./routes/config').fengyuguan,
  'config.invalidateConfig': () => require('./routes/config').invalidateConfig
}

/**
 * 云函数入口函数
 */
exports.main = async (event, context) => {
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
  const publicActions = ['config.banners', 'config.fengyuguan', 'config.invalidateConfig']

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

    // 解析错误类型——仅透传已知前缀的业务错误，其余一律返回通用提示
    const errorMessage = error.message || '服务器内部错误'
    const errorTypeMatch = errorMessage.match(/^([A-Z_]+):\s*/)
    const errorType = errorTypeMatch ? errorTypeMatch[1] : null
    const knownTypes = ['UNAUTHORIZED', 'PHONE_REQUIRED', 'INVALID_PARAMS', 'PERMISSION_DENIED', 'NOT_FOUND']
    const isKnown = errorType && knownTypes.includes(errorType)
    const displayMessage = isKnown ? errorMessage.slice(errorTypeMatch[0].length) : '服务器内部错误'

    const code = errorMessage.startsWith('UNAUTHORIZED') ? -401 :
                  errorMessage.startsWith('PHONE_REQUIRED') ? -403 :
                  errorMessage.startsWith('INVALID_PARAMS') ? -400 :
                  errorMessage.startsWith('PERMISSION_DENIED') ? -403 :
                  errorMessage.startsWith('NOT_FOUND') ? -404 :
                  -1

    return {
      code,
      message: displayMessage,
      errorType: isKnown ? errorType : null,
      data: error.data || null
    }
  }
}
