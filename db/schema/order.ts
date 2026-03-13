import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  allocationStatusEnum,
  itemDirectionEnum,
  orderSourceEnum,
  orderStatusEnum,
  paymentMethodEnum,
  saleOrderTypeEnum,
  salesCategoryEnum,
} from './enums'
import { stores } from './org'
import { productSkus } from './product'
import { clientWechatUsers, staffWechatUsers } from './user'

/**
 * 订单主表（四种单据统一模型）
 *
 * sale_orders + sale_items + sale_allocations 覆盖销售单、回款单、转换单、退款单，
 * 通过 sale_order_type 区分。回款/转换/退款通过 ref_sale_order_id 引用原销售单。
 */
export const saleOrders = pgTable(
  'sale_orders',
  {
    saleOrderId: varchar('sale_order_id', { length: 30 }).primaryKey(),
    status: orderStatusEnum('status').notNull().default('待支付'),
    saleOrderType: saleOrderTypeEnum('sale_order_type').notNull().default('普通'),
    /** 回款/转换/退款引用的原销售单，销售单为 null */
    refSaleOrderId: varchar('ref_sale_order_id', { length: 30 }).references((): any => saleOrders.saleOrderId),
    /** 所属市场（快照） */
    marketName: varchar('market_name', { length: 100 }).notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    saleOrderDatetime: timestamp('sale_order_datetime').notNull(),
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    clientPhone: varchar('client_phone', { length: 30 }),
    customerName: varchar('customer_name', { length: 50 }),
    /** 订单总金额；退款为负数，转换=补差价，回款=本次回款金额 */
    totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull(),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),
    saleOrderSource: orderSourceEnum('sale_order_source').notNull(),
    openedBy: varchar('opened_by', { length: 30 }).references(() => staffWechatUsers.employeeId),
    preferredEmployeeId: varchar('preferred_employee_id', { length: 30 }).references(() => staffWechatUsers.employeeId),
    paidAt: timestamp('paid_at'),
    wechatTransactionId: varchar('wechat_transaction_id', { length: 64 }).unique(),
    alipayTransactionId: varchar('alipay_transaction_id', { length: 64 }).unique(),
    offlineConfirmedBy: varchar('offline_confirmed_by', { length: 30 }).references(() => staffWechatUsers.employeeId),
    offlineConfirmedAt: timestamp('offline_confirmed_at'),
    allocationStatus: allocationStatusEnum('allocation_status'),
    /** 使用的券实例ID（关系由 user_coupons.used_sale_order_id 维护，不设反向 FK 避免循环引用） */
    couponId: text('coupon_id'),
    /** 券抵扣总金额 */
    couponDiscount: numeric('coupon_discount', { precision: 10, scale: 2 }).default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_sale_orders_client_pending')
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL`),
    uniqueIndex('uq_sale_orders_phone_pending')
      .on(table.clientPhone, table.storeId)
      .where(sql`status = '待支付' AND client_user_id IS NULL`),
    index('idx_sale_orders_store_status').on(table.storeId, table.status),
    index('idx_sale_orders_ref').on(table.refSaleOrderId),
  ],
)

/**
 * 销售明细
 *
 * 同时用于销售、回款、转换、退款四种单据的明细行。
 * item_direction 标识行的方向语义。
 * 疗程卡并发扣减须使用原子 UPDATE remaining_sessions。
 */
export const saleItems = pgTable(
  'sale_items',
  {
    saleItemId: varchar('sale_item_id', { length: 30 }).primaryKey(),
    saleOrderId: varchar('sale_order_id', { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId),
    itemDirection: itemDirectionEnum('item_direction').notNull().default('purchase'),
    /** convert_out/refund_out 引用原购买行，其他为 null */
    refSaleItemId: varchar('ref_sale_item_id', { length: 30 }).references((): any => saleItems.saleItemId),
    skuId: text('sku_id').references(() => productSkus.skuId),
    sessionCount: integer('session_count'),
    remainingSessions: integer('remaining_sessions'),
    /** 原价快照（开单时持久化） */
    unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** 优惠后单价金额 */
    unitRealPrice: numeric('unit_real_price', { precision: 10, scale: 2 }).notNull(),
    saleAmount: numeric('sale_amount', { precision: 10, scale: 2 }).notNull(),
    /** 实收金额（convert_out/refund_out 行为负数） */
    received: numeric('received', { precision: 10, scale: 2 }).notNull(),
    expireDate: date('expire_date'),
    remark: text('remark'),
    salesCategory: salesCategoryEnum('sales_category'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_sale_items_order_id').on(table.saleOrderId),
    index('idx_sale_items_sku_id').on(table.skuId),
    index('idx_sale_items_ref').on(table.refSaleItemId),
    check('chk_item_unit_price', sql`${table.unitPrice} >= 0`),
    check('chk_item_unit_real_price', sql`${table.unitRealPrice} >= 0`),
    check('chk_item_remaining', sql`${table.remainingSessions} IS NULL OR ${table.remainingSessions} >= 0`),
    check('chk_item_quantity', sql`${table.quantity} > 0`),
  ],
)

/**
 * 营业额分配
 *
 * 同时用于销售、回款、转换、退款四种单据的业绩分配。
 * 退款业绩 total_amount 为负数，转换/回款保持正数。
 */
export const saleAllocations = pgTable(
  'sale_allocations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    allocationRatio: numeric('allocation_ratio', { precision: 5, scale: 2 }).notNull(),
    /** 该员工最终分配金额（退款为负数） */
    totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull(),
    isVoid: boolean('is_void').notNull().default(false),
    voidedAt: timestamp('voided_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_sale_alloc_item_emp')
      .on(table.saleItemId, table.employeeId)
      .where(sql`is_void = false`),
    index('idx_sale_alloc_employee_id').on(table.employeeId),
  ],
)

export type SaleOrder = typeof saleOrders.$inferSelect
export type NewSaleOrder = typeof saleOrders.$inferInsert
export type SaleItem = typeof saleItems.$inferSelect
export type NewSaleItem = typeof saleItems.$inferInsert
export type SaleAllocation = typeof saleAllocations.$inferSelect
export type NewSaleAllocation = typeof saleAllocations.$inferInsert
