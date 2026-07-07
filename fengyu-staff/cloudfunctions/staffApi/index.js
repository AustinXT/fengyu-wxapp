



process.env.TZ = 'Asia/Shanghai'

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })


const { auth } = require('./middleware/auth')
const { buildErrorResponse } = require('./utils/error-codes')
const { extractAppVersion } = require('./utils/app-version')


const routes = {
  
  'auth.login':           () => require('./routes/auth').login,
  'auth.bindPhone':       () => require('./routes/auth').bindPhone,

  
  'store.list':            () => require('./routes/store').list,
  'store.unbindRequests':  () => require('./routes/store').unbindRequests,
  'store.approveUnbind':   () => require('./routes/store').approveUnbind,
  'store.rejectUnbind':    () => require('./routes/store').rejectUnbind,

  
  'staff.list':           () => require('./routes/staff').list,
  'staff.departments':    () => require('./routes/staff').departments,
  'staff.todayCommission': () => require('./routes/staff').todayCommission,
  'staff.monthlyCalendar': () => require('./routes/staff').monthlyCalendar,
  'staff.todoList':       () => require('./routes/staff').todoList,
  'staff.bindStore':      () => require('./routes/staff').bindStore,
  'staff.performanceDetail': () => require('./routes/staff').performanceDetail,
  'staff.uploadAvatar':   () => require('./routes/staff').uploadAvatar,
  'staff.skillTags':      () => require('./routes/staff').skillTags,

  
  'customer.search':      () => require('./routes/customer').search,
  'customer.calendar':    () => require('./routes/customer').calendar,
  'customer.detail':      () => require('./routes/customer').detail,
  'customer.paidOrders':  () => require('./routes/customer').paidOrders,
  'customer.orderHistory': () => require('./routes/customer').orderHistory,
  'customer.serviceHistory': () => require('./routes/customer').serviceHistory,
  'customer.stats':       () => require('./routes/customer').stats,
  'customer.listByTag':   () => require('./routes/customer').listByTag,
  'customer.refundHistory': () => require('./routes/customer').refundHistory,
  'customer.updateNotes': () => require('./routes/customer').updateNotes,
  'customer.assign':      () => require('./routes/customer').assign,
  'customer.customerBalance': () => require('./routes/customer').customerBalance,
  'customer.appointments': () => require('./routes/customer').appointments,
  'customer.phoneChangeLogs': () => require('./routes/customer').phoneChangeLogs,

  
  'product.shopInit':     () => require('./routes/product').shopInit,
  'product.categories':   () => require('./routes/product').categories,
  'product.skuDetail':    () => require('./routes/product').skuDetail,
  'product.skuList':      () => require('./routes/product').skuList,
  'product.promotionList': () => require('./routes/product').promotionList,
  'product.promotionPlans': () => require('./routes/product').promotionPlans,

  
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
  'order.createDeposit':  () => require('./routes/order').createDeposit,
  'order.availablePickupItems': () => require('./routes/order').availablePickupItems,
  'order.pickupRecordsList':    () => require('./routes/order').pickupRecordsList,

  
  'inventory.list':       () => require('./routes/inventory').list,
  'inventory.detail':     () => require('./routes/inventory').detail,

  
  'allocation.pendingPayments':         () => require('./routes/allocation').pendingPayments,
  'allocation.suggestPayment':          () => require('./routes/allocation').suggestPayment,
  'allocation.savePayment':             () => require('./routes/allocation').savePayment,
  'allocation.deletePaymentAllocation': () => require('./routes/allocation').deletePaymentAllocation,
  'allocation.rates':        () => require('./routes/allocation').getCommissionRates,

  
  'serviceCommission.pendingList': () => require('./routes/serviceCommission').pendingList,
  'serviceCommission.detail':      () => require('./routes/serviceCommission').detail,
  'serviceCommission.save':        () => require('./routes/serviceCommission').save,

  
  'appointment.list':     () => require('./routes/appointment').list,
  'appointment.confirm':  () => require('./routes/appointment').confirm,
  'appointment.checkin':  () => require('./routes/appointment').checkin,
  'appointment.detail':   () => require('./routes/appointment').detail,

  
  'coupon.available':     () => require('./routes/coupon').available,

  
  'card.rechargeConfig':  () => require('./routes/card').rechargeConfig,
  'card.recharge':        () => require('./routes/card').recharge,
  'card.inflow':          () => require('./routes/card').inflow,
  'card.createRefund':    () => require('./routes/card').createRefund,
  'card.approveRefund':   () => require('./routes/card').approveRefund,
  'card.rejectRefund':    () => require('./routes/card').rejectRefund,

  
  'service.create':       () => require('./routes/service').create,
  'service.start':        () => require('./routes/service').start,
  'service.complete':     () => require('./routes/service').complete,
  'service.confirm':      () => require('./routes/service').confirm,
  'service.cancel':       () => require('./routes/service').cancel,
  'service.list':         () => require('./routes/service').list,
  'service.detail':       () => require('./routes/service').detail,
  'service.counts':       () => require('./routes/service').counts,

  
  'mgmtDashboard.scopeOptions': () => require('./routes/mgmt-dashboard').scopeOptions,
  'mgmtDashboard.summary':     () => require('./routes/mgmt-dashboard').summary,
  'mgmtDashboard.storeRanking': () => require('./routes/mgmt-dashboard').storeRanking,
  'mgmtDashboard.staffRanking': () => require('./routes/mgmt-dashboard').staffRanking,
  'mgmtDashboard.salesData':    () => require('./routes/mgmt-dashboard').salesData,

  
  'mgmtProduct.cardHolders': () => require('./routes/mgmt-product').cardHolders,
  'mgmtProduct.cycleStats':  () => require('./routes/mgmt-product').cycleStats,

  
  'mgmtTraffic.summary':       () => require('./routes/mgmt-traffic').summary,

  
  'mgmtCustomer.search':        () => require('./routes/mgmt-customer').search,
  'mgmtCustomer.detail':        () => require('./routes/mgmt-customer').detail,
  'mgmtCustomer.calendar':      () => require('./routes/mgmt-customer').calendar,
  'mgmtCustomer.paidOrders':    () => require('./routes/mgmt-customer').paidOrders,
  'mgmtCustomer.orderHistory':  () => require('./routes/mgmt-customer').orderHistory,
  'mgmtCustomer.serviceHistory': () => require('./routes/mgmt-customer').serviceHistory,
  'mgmtCustomer.giftHistory':   () => require('./routes/mgmt-customer').giftHistory,
  'mgmtCustomer.refundHistory': () => require('./routes/mgmt-customer').refundHistory,
}


exports.main = async (event, context) => {
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

  try {
    
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
