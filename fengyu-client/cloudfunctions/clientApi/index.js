/**
 * clientApi 云函数入口
 * 客户端统一接口,按 action 字段路由分发
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入路由模块
const authRoutes = require('./routes/auth')
const storeRoutes = require('./routes/store')
const productRoutes = require('./routes/product')
const staffRoutes = require('./routes/staff')
const orderRoutes = require('./routes/order')
const appointmentRoutes = require('./routes/appointment')
const serviceRoutes = require('./routes/service')

// 导入中间件
const { auth } = require('./middleware/auth')

// 路由映射表
const routes = {
  'auth.login': authRoutes.login,
  'auth.bindPhone': authRoutes.bindPhone,
  'auth.bindStore': authRoutes.bindStore,
  'store.list': storeRoutes.list,
  'product.categories': productRoutes.categories,
  'product.spuList': productRoutes.spuList,
  'product.skuDetail': productRoutes.skuDetail,
  'staff.list': staffRoutes.list,
  'staff.default': staffRoutes.defaultStaff,
  'order.create': orderRoutes.create,
  'order.pay': orderRoutes.pay,
  'order.offlinePay': orderRoutes.offlinePay,
  'order.list': orderRoutes.list,
  'order.detail': orderRoutes.detail,
  'order.appointableItems': orderRoutes.appointableItems,
  'appointment.create': appointmentRoutes.create,
  'appointment.list': appointmentRoutes.list,
  'appointment.cancel': appointmentRoutes.cancel,
  'service.detail': serviceRoutes.detail
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

  // 查找路由
  const handler = routes[action]
  if (!handler) {
    return { code: -1, message: `未知的 action: ${action}` }
  }

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
