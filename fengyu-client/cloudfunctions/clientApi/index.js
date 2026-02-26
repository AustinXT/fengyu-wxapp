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
  'store.list': () => require('./routes/store').list,
  'store.detail': () => require('./routes/store').detail,
  'product.categories': () => require('./routes/product').categories,
  'product.spuList': () => require('./routes/product').spuList,
  'product.skuDetail': () => require('./routes/product').skuDetail,
  'product.spuDetail': () => require('./routes/product').spuDetail,
  'product.hotList': () => require('./routes/product').hotList,
  'product.shopInit': () => require('./routes/product').shopInit,
  'staff.list': () => require('./routes/staff').list,
  'staff.default': () => require('./routes/staff').defaultStaff,
  'order.create': () => require('./routes/order').create,
  'order.pay': () => require('./routes/order').pay,
  'order.offlinePay': () => require('./routes/order').offlinePay,
  'order.list': () => require('./routes/order').list,
  'order.detail': () => require('./routes/order').detail,
  'order.appointableItems': () => require('./routes/order').appointableItems,
  'appointment.create': () => require('./routes/appointment').create,
  'appointment.list': () => require('./routes/appointment').list,
  'appointment.cancel': () => require('./routes/appointment').cancel,
  'service.detail': () => require('./routes/service').detail
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

  try {
    // 执行中间件链 + 业务处理
    await auth(ctx, async () => {
      await handler(ctx)
    })

    return {
      code: 0,
      message: 'success',
      data: ctx.result
    }
  } catch (error) {
    console.error(`[${action}] Error:`, error)

    // 解析错误类型
    const errorMessage = error.message || '服务器内部错误'
    const code = errorMessage.startsWith('UNAUTHORIZED') ? -401 :
                  errorMessage.startsWith('PHONE_REQUIRED') ? -403 :
                  errorMessage.startsWith('INVALID_PARAMS') ? -400 :
                  errorMessage.startsWith('PERMISSION_DENIED') ? -403 :
                  -1

    return {
      code,
      message: errorMessage,
      data: null
    }
  }
}
