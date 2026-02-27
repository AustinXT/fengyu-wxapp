/**
 * staffApi 云函数入口
 * 员工端统一接口，按 action 字段路由分发
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入中间件
const { auth } = require('./middleware/auth')

// 路由映射表 —— 懒加载：只在匹配到 action 时才 require 对应模块
const routes = {
  // 认证
  'auth.login':           () => require('./routes/auth').login,
  'auth.bindPhone':       () => require('./routes/auth').bindPhone,

  // 门店
  'store.list':           () => require('./routes/store').list,

  // 员工
  'staff.list':           () => require('./routes/staff').list,
  'staff.departments':    () => require('./routes/staff').departments,
  'staff.todayCommission': () => require('./routes/staff').todayCommission,
  'staff.monthlyCalendar': () => require('./routes/staff').monthlyCalendar,
  'staff.todoList':       () => require('./routes/staff').todoList,
  'staff.bindStore':      () => require('./routes/staff').bindStore,

  // 顾客档案
  'customer.search':      () => require('./routes/customer').search,
  'customer.calendar':    () => require('./routes/customer').calendar,
  'customer.detail':      () => require('./routes/customer').detail,
  'customer.paidOrders':  () => require('./routes/customer').paidOrders,

  // 商品
  'product.shopInit':     () => require('./routes/product').shopInit,
  'product.categories':   () => require('./routes/product').categories,
  'product.skuDetail':    () => require('./routes/product').skuDetail,
  'product.spuList':      () => require('./routes/product').spuList,
  'product.promotionList': () => require('./routes/product').promotionList,
  'product.promotionPlans': () => require('./routes/product').promotionPlans,

  // 订单
  'order.create':         () => require('./routes/order').create,
  'order.qrcode':         () => require('./routes/order').qrcode,
  'order.confirmOffline': () => require('./routes/order').confirmOffline,
  'order.close':          () => require('./routes/order').close,
  'order.resetFailed':    () => require('./routes/order').resetFailed,
  'order.list':           () => require('./routes/order').list,
  'order.detail':         () => require('./routes/order').detail,

  // 营业额分配
  'allocation.save':      () => require('./routes/allocation').save,
  'allocation.delete':    () => require('./routes/allocation').deleteAllocation,

  // 预约
  'appointment.list':     () => require('./routes/appointment').list,
  'appointment.confirm':  () => require('./routes/appointment').confirm,
  'appointment.checkin':  () => require('./routes/appointment').checkin,
  'appointment.detail':   () => require('./routes/appointment').detail,

  // 服务单
  'service.create':       () => require('./routes/service').create,
  'service.start':        () => require('./routes/service').start,
  'service.complete':     () => require('./routes/service').complete,
  'service.list':         () => require('./routes/service').list,
  'service.detail':       () => require('./routes/service').detail,
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

  // 查找路由（懒加载）
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
