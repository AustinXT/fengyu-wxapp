import { date, index, integer, numeric, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { allocationStatusEnum, serviceOrderStatusEnum, serviceOrderTypeEnum } from './enums'
import { stores } from './org'
import { saleItems } from './order'
import { clientWechatUsers, staffWechatUsers } from './user'
import { appointments } from './appointment'

/**
 * 护理单主表
 *
 * 与订单的关联通过 service_items.sale_item_id → sale_items.sale_item_id 实现，
 * 主表不存 sale_order_id，支持同一次到店跨多笔订单核销。
 * 状态流转：待服务 -> 服务中 -> 已完成
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    serviceOrderId: varchar('service_order_id', { length: 30 }).primaryKey(),
    status: serviceOrderStatusEnum('status').notNull().default('待服务'),
    serviceOrderType: serviceOrderTypeEnum('service_order_type').notNull().default('售前'),
    /** 所属市场（快照） */
    marketName: varchar('market_name', { length: 100 }).notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    serviceDate: date('service_date').notNull(),
    assignedEmployeeId: varchar('assigned_employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    remark: text('remark'),
    appointmentId: text('appointment_id').references(() => appointments.appointmentId),
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    /** 服务开始时间（状态转为"服务中"时记录） */
    startedAt: timestamp('started_at'),
    /** 服务完成时间（状态转为"已完成"时记录） */
    completedAt: timestamp('completed_at'),
    /** 提成分配状态（仅已完成的服务单有值） */
    commissionStatus: allocationStatusEnum('commission_status'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_svc_orders_store_date').on(table.storeId, table.serviceDate),
    index('idx_svc_orders_assigned_employee').on(table.assignedEmployeeId),
    index('idx_svc_orders_client_user_id').on(table.clientUserId),
  ],
)

/**
 * 护理明细
 */
export const serviceItems = pgTable(
  'service_items',
  {
    serviceItemId: text('service_item_id').primaryKey(),
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    /** sale_items.unit_real_price 快照 */
    unitRealPrice: numeric('unit_real_price', { precision: 10, scale: 2 }),
    serviceOrderId: varchar('service_order_id', { length: 30 })
      .notNull()
      .references(() => serviceOrders.serviceOrderId),
    sessionUsed: integer('session_used').notNull(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 服务时长（分钟） */
    serviceDuration: integer('service_duration'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_svc_items_order_id').on(table.serviceOrderId),
  ],
)

export type ServiceOrder = typeof serviceOrders.$inferSelect
export type NewServiceOrder = typeof serviceOrders.$inferInsert
export type ServiceItem = typeof serviceItems.$inferSelect
export type NewServiceItem = typeof serviceItems.$inferInsert
