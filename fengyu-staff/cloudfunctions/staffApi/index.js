/**
 * staffApi 云函数入口
 * 员工端统一接口，按 action 字段路由分发
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入中间件
const { auth } = require('./middleware/auth')
const { buildErrorResponse } = require('./utils/error-codes')

// 路由映射表 —— 懒加载：只在匹配到 action 时才 require 对应模块
const routes = {
  // 认证
  'auth.login':           () => require('./routes/auth').login,
  'auth.bindPhone':       () => require('./routes/auth').bindPhone,

  // 门店
  'store.list':            () => require('./routes/store').list,
  'store.unbindRequests':  () => require('./routes/store').unbindRequests,
  'store.approveUnbind':   () => require('./routes/store').approveUnbind,
  'store.rejectUnbind':    () => require('./routes/store').rejectUnbind,

  // 员工
  'staff.list':           () => require('./routes/staff').list,
  'staff.departments':    () => require('./routes/staff').departments,
  'staff.todayCommission': () => require('./routes/staff').todayCommission,
  'staff.monthlyCalendar': () => require('./routes/staff').monthlyCalendar,
  'staff.todoList':       () => require('./routes/staff').todoList,
  'staff.bindStore':      () => require('./routes/staff').bindStore,
  'staff.performanceDetail': () => require('./routes/staff').performanceDetail,
  'staff.dashboard':      () => require('./routes/staff').dashboard,

  // 顾客档案
  'customer.search':      () => require('./routes/customer').search,
  'customer.calendar':    () => require('./routes/customer').calendar,
  'customer.detail':      () => require('./routes/customer').detail,
  'customer.paidOrders':  () => require('./routes/customer').paidOrders,
  'customer.stats':       () => require('./routes/customer').stats,
  'customer.listByTag':   () => require('./routes/customer').listByTag,
  'customer.giftHistory': () => require('./routes/customer').giftHistory,
  'customer.refundHistory': () => require('./routes/customer').refundHistory,
  'customer.updateNotes': () => require('./routes/customer').updateNotes,
  'customer.assign':      () => require('./routes/customer').assign,
  'customer.customerBalance': () => require('./routes/customer').customerBalance,

  // 商品
  'product.shopInit':     () => require('./routes/product').shopInit,
  'product.categories':   () => require('./routes/product').categories,
  'product.skuDetail':    () => require('./routes/product').skuDetail,
  'product.skuList':      () => require('./routes/product').skuList,
  'product.spuDetail':    () => require('./routes/product').spuDetail,
  'product.cardKinds':    () => require('./routes/product').cardKinds,
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
  'order.createRefund':   () => require('./routes/order').createRefund,
  'order.approveRefund':  () => require('./routes/order').approveRefund,
  'order.rejectRefund':   () => require('./routes/order').rejectRefund,
  'order.refundList':     () => require('./routes/order').refundList,
  'order.refundDetail':   () => require('./routes/order').refundDetail,
  'order.createRepayment': () => require('./routes/order').createRepayment,
  'order.createConversion': () => require('./routes/order').createConversion,
  'order.customerHeldCards': () => require('./routes/order').customerHeldCards,
  'order.createPickup':   () => require('./routes/order').createPickup,

  // 营业额分配
  'allocation.save':         () => require('./routes/allocation').save,
  'allocation.delete':       () => require('./routes/allocation').deleteAllocation,
  'allocation.rates':        () => require('./routes/allocation').getCommissionRates,
  'allocation.pendingList':  () => require('./routes/allocation').pendingList,
  'allocation.suggest':      () => require('./routes/allocation').suggest,

  // 预约
  'appointment.list':     () => require('./routes/appointment').list,
  'appointment.confirm':  () => require('./routes/appointment').confirm,
  'appointment.checkin':  () => require('./routes/appointment').checkin,
  'appointment.detail':   () => require('./routes/appointment').detail,

  // 优惠券
  'coupon.available':     () => require('./routes/coupon').available,

  // 充值卡（店长替顾客充值）
  'card.rechargeSkus':    () => require('./routes/card').rechargeSkus,
  'card.recharge':        () => require('./routes/card').recharge,

  // 服务单
  'service.create':       () => require('./routes/service').create,
  'service.start':        () => require('./routes/service').start,
  'service.complete':     () => require('./routes/service').complete,
  'service.cancel':       () => require('./routes/service').cancel,
  'service.list':         () => require('./routes/service').list,
  'service.detail':       () => require('./routes/service').detail,
  'service.counts':       () => require('./routes/service').counts,

  // 管理层数据中心
  'mgmtDashboard.scopeOptions': () => require('./routes/mgmt-dashboard').scopeOptions,
  'mgmtDashboard.summary':     () => require('./routes/mgmt-dashboard').summary,
  'mgmtDashboard.storeRanking': () => require('./routes/mgmt-dashboard').storeRanking,
  'mgmtDashboard.staffRanking': () => require('./routes/mgmt-dashboard').staffRanking,
  'mgmtDashboard.salesData':    () => require('./routes/mgmt-dashboard').salesData,

  // 管理层 - 品项数据子页
  'mgmtProduct.cardHolders': () => require('./routes/mgmt-product').cardHolders,
  'mgmtProduct.cycleStats':  () => require('./routes/mgmt-product').cycleStats,

  // 管理层 - 客量数据子页
  'mgmtTraffic.summary':       () => require('./routes/mgmt-traffic').summary,

  // 管理层 - 顾客档案子页
  'mgmtCustomer.search':        () => require('./routes/mgmt-customer').search,
  'mgmtCustomer.detail':        () => require('./routes/mgmt-customer').detail,
  'mgmtCustomer.calendar':      () => require('./routes/mgmt-customer').calendar,
  'mgmtCustomer.paidOrders':    () => require('./routes/mgmt-customer').paidOrders,
  'mgmtCustomer.giftHistory':   () => require('./routes/mgmt-customer').giftHistory,
  'mgmtCustomer.refundHistory': () => require('./routes/mgmt-customer').refundHistory,
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
    return buildErrorResponse(error)
  }
}
