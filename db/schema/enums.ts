import { pgEnum } from 'drizzle-orm/pg-core'

export const bigCategoryEnum = pgEnum('big_category', ['生美', '非生美', '院装产品'])

export const workfineSourceEnum = pgEnum('workfine_source', [
  'UDT_M_1281',
  'UDT_M_1383',
  'UDT_M_1460',
  'UDT_M_341',
])

export const productTypeEnum = pgEnum('product_type', ['疗程卡', '单品', '院装产品'])

export const orderStatusEnum = pgEnum('order_status', [
  '待支付',
  '待确认收款',
  '已支付',
  '已完成',
  '支付失败',
  '已关闭',
])

export const orderTypeEnum = pgEnum('order_type', ['正式', '体验'])

export const paymentMethodEnum = pgEnum('payment_method', ['wechat', 'offline'])

export const orderSourceEnum = pgEnum('order_source', ['client', 'staff'])

export const serviceOrderStatusEnum = pgEnum('service_order_status', ['待服务', '服务中', '已完成'])

export const appointmentStatusEnum = pgEnum('appointment_status', [
  '待确认',
  '已确认',
  '已完成',
  '已取消',
  '已关闭',
])
