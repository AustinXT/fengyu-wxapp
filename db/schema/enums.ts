import { pgEnum } from 'drizzle-orm/pg-core'

export const productKindEnum = pgEnum('product_kind', ['福利活动', '护理项目', '家居产品', '充值卡'])

export const productTypeEnum = pgEnum('product_type', ['疗程卡', '单品', '院装产品'])

export const orderStatusEnum = pgEnum('order_status', [
  '待支付',
  '待确认收款',
  '已支付',
  '已完成',
  '支付失败',
  '已关闭',
  '待审批',
])

export const saleOrderTypeEnum = pgEnum('sale_order_type', [
  '普通', '体验', '内部', '福利活动', '回款', '转换', '退款',
])

export const allocationStatusEnum = pgEnum('allocation_status', ['pending', 'allocated'])

export const itemDirectionEnum = pgEnum('item_direction', [
  'purchase', 'convert_out', 'convert_in', 'refund_out',
])

export const paymentMethodEnum = pgEnum('payment_method', ['wechat', 'alipay', 'offline'])

export const orderSourceEnum = pgEnum('order_source', ['client', 'staff'])

export const serviceOrderStatusEnum = pgEnum('service_order_status', ['待服务', '服务中', '已完成', '已取消'])

export const serviceOrderTypeEnum = pgEnum('service_order_type', ['普通', '体验'])

export const appointmentStatusEnum = pgEnum('appointment_status', [
  '待确认',
  '已确认',
  '已完成',
  '已取消',
  '已关闭',
])

export const storeUnbindRequestStatusEnum = pgEnum('store_unbind_request_status', [
  'pending', 'approved', 'rejected', 'cancelled',
])

export const salesCategoryEnum = pgEnum('sales_category', [
  '自采自销', '他销自耗', '他销他耗', '生态合作',
])

export const couponTypeEnum = pgEnum('coupon_type', ['现金券', '项目券', '折扣券'])

export const couponStatusEnum = pgEnum('coupon_status', ['未使用', '已使用', '已过期'])

export const orgNodeTypeEnum = pgEnum('org_node_type', [
  'headquarters',  // 总部（根节点，仅一个）
  'market',        // 市场
  'store',         // 门店
  'department',    // 部门（可挂在任意层级）
])
