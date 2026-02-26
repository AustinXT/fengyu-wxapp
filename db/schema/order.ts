import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orderSourceEnum, orderStatusEnum, orderTypeEnum, paymentMethodEnum } from './enums'
import { productSpuSkuMap } from './product'

/**
 * 实体二：订单主表（对应 WorkFine UDT_S_209）
 *
 * 部分唯一索引：
 *   - UNIQUE(client_user_id) WHERE status='待支付' AND client_user_id IS NOT NULL
 *   - UNIQUE(client_phone, store_name) WHERE status='待支付' AND client_user_id IS NULL
 */
export const orders = pgTable(
  'orders',
  {
    /** 主键，格式 FY-XSD-WX-{YYMMDD}{序号} */
    orderNo: text('order_no').primaryKey(),
    status: orderStatusEnum('status').notNull().default('待支付'),
    /** 正式：价格来自 WorkFine；体验：店长自定义价格，用于首次体验/引流 */
    orderType: orderTypeEnum('order_type').notNull().default('正式'),
    /** 所属市场快照，防止组织架构调整影响历史单 */
    marketName: text('market_name').notNull(),
    /** 所属门店快照 */
    storeName: text('store_name').notNull(),
    orderDatetime: timestamp('order_datetime').notNull(),
    /**
     * 关联 client_wechat_users.user_id；
     * 员工开单时若顾客未注册客户端小程序则为 null
     */
    clientUserId: text('client_user_id'),
    /**
     * 顾客手机号快照；员工开单时必填，作为 client_user_id 为 null 时的替代标识。
     * 顾客绑定手机号后通过此字段批量补全 client_user_id（手机号补全机制）。
     */
    clientPhone: text('client_phone'),
    /**
     * 顾客姓名快照；员工开单时写入，便于员工端列表展示。
     * client_user_id 为 null 时无法反查 WorkFine，必须依赖此快照。
     * 与 appointments.customer_name 保持一致。
     */
    customerName: text('customer_name'),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),
    orderSource: orderSourceEnum('order_source').notNull(),
    /** 开单人员工编号，客户端自助时为 null */
    openedBy: text('opened_by'),
    /** 顾客指定美容师，关联 WorkFine UDT_S_287.UDF_S_1147，未指定为 null */
    preferredStaffWfId: text('preferred_staff_wf_id'),
    paidAt: timestamp('paid_at'),
    /**
     * 微信支付回调返回的流水号（transaction_id）。
     * 用途：回调幂等性校验（已存在则不重复入账）、对账、退款接口必填参数。
     * 线下付款时为 null。
     */
    wechatTransactionId: text('wechat_transaction_id').unique(),
    offlineConfirmedBy: text('offline_confirmed_by'),
    offlineConfirmedAt: timestamp('offline_confirmed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    // 已注册顾客同一时刻只能有一笔待支付订单
    uniqueIndex('uq_orders_client_pending')
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL`),
    // 未注册顾客（employee 开单）防并发重复开单兜底
    uniqueIndex('uq_orders_phone_pending')
      .on(table.clientPhone, table.storeName)
      .where(sql`status = '待支付' AND client_user_id IS NULL`),
    index('idx_orders_client_user_id').on(table.clientUserId),
    index('idx_orders_store_status').on(table.storeName, table.status),
  ],
)

/**
 * 实体二：销售明细（对应 WorkFine UDT_M_213）
 *
 * 疗程卡并发扣减须使用原子 UPDATE：
 *   UPDATE order_items
 *   SET remaining_sessions = remaining_sessions - n
 *   WHERE item_flow_no = $1 AND remaining_sessions >= n
 * 检查 rowCount=1 判断成功，禁止先 SELECT 再 UPDATE。
 */
export const orderItems = pgTable(
  'order_items',
  {
    /** 主键，销售流水号，格式 XSLSH-WX-{YYYYMMDD}{序号}，被 service_items 引用作为核销锚点 */
    itemFlowNo: text('item_flow_no').primaryKey(),
    orderNo: text('order_no')
      .notNull()
      .references(() => orders.orderNo),
    skuId: text('sku_id').references(() => productSpuSkuMap.skuId),
    /** 疗程卡≥2，单品=1，院装产品=null */
    sessionCount: integer('session_count'),
    /** 初始值等于 session_count；院装产品=null；不得低于 0 */
    remainingSessions: integer('remaining_sessions'),
    /** 原价快照，开单时从 WorkFine 读取并持久化，防止后续价格变更影响历史单 */
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitDiscount: numeric('unit_discount', { precision: 12, scale: 2 }).notNull().default('0'),
    /** 优惠后销售金额，应用层计算后写入 */
    saleAmount: numeric('sale_amount', { precision: 12, scale: 2 }).notNull(),
    receivable: numeric('receivable', { precision: 12, scale: 2 }).notNull(),
    received: numeric('received', { precision: 12, scale: 2 }).notNull(),
    /** 疗程卡及单品适用，院装产品为 null；疗程卡：开单时写入合同约定到期日；单品：支付回调成功时由系统写入 paid_at + 1 year */
    expireDate: date('expire_date'),
    remark: text('remark'),
    promotionSchemeId: text('promotion_scheme_id'),
  },
  (table) => [
    index('idx_order_items_order_no').on(table.orderNo),
  ],
)

/**
 * 实体二：营业额分配（对应 WorkFine UDT_M_217）
 *
 * UNIQUE(order_no, employee_id)
 * 订单关闭/支付失败时 is_void=true，重新付款后由店长手动重新分配。
 */
export const revenueAllocations = pgTable(
  'revenue_allocations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderNo: text('order_no')
      .notNull()
      .references(() => orders.orderNo),
    /** 关联 WorkFine UDT_S_287.UDF_S_1147 */
    employeeId: text('employee_id').notNull(),
    /** 占比，如 0.3；跨部门或单人时为 1.0 */
    allocationRatio: numeric('allocation_ratio', { precision: 5, scale: 2 }).notNull(),
    /** 等于 revenue_allocation_items.amount 之和 */
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
    isVoid: boolean('is_void').notNull().default(false),
    voidedAt: timestamp('voided_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    unique('uq_rev_alloc_order_emp').on(table.orderNo, table.employeeId),
    index('idx_rev_alloc_order_no').on(table.orderNo),
  ],
)

/**
 * 实体二：业绩分类明细
 *
 * 新增业绩分类只需插入新行，无需变更表结构。
 */
export const revenueAllocationItems = pgTable('revenue_allocation_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  allocationId: bigint('allocation_id', { mode: 'number' })
    .notNull()
    .references(() => revenueAllocations.id),
  /** 业绩分类名称，如"眉眼"、"唇"、"祛斑点痣"、"单品" */
  performanceCategory: text('performance_category').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
})

export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert
export type RevenueAllocation = typeof revenueAllocations.$inferSelect
export type NewRevenueAllocation = typeof revenueAllocations.$inferInsert
export type RevenueAllocationItem = typeof revenueAllocationItems.$inferSelect
export type NewRevenueAllocationItem = typeof revenueAllocationItems.$inferInsert
