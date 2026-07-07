import { boolean, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { allocationStatusEnum, salesCategoryEnum, serviceOrderStatusEnum, serviceOrderTypeEnum } from './enums'
import { stores } from './org'
import { saleItems } from './order'
import { clientWechatUsers, staffWechatUsers } from './user'
import { appointments } from './appointment'


export const serviceOrders = pgTable(
  'service_orders',
  {
    serviceOrderId: varchar('service_order_id', { length: 30 }).primaryKey(),
    status: serviceOrderStatusEnum('status').notNull().default('待服务'),
    serviceOrderType: serviceOrderTypeEnum('service_order_type').notNull().default('售前'),
    
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
    
    startedAt: timestamp('started_at'),
    
    staffCompletedAt: timestamp('staff_completed_at'),
    
    completedAt: timestamp('completed_at'),
    
    commissionStatus: allocationStatusEnum('commission_status'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_svc_orders_store_date').on(table.storeId, table.serviceDate),
    index('idx_svc_orders_assigned_employee').on(table.assignedEmployeeId),
    index('idx_svc_orders_client_user_id').on(table.clientUserId),
    
    index('idx_svc_orders_status_updated').on(
      table.status,
      table.updatedAt.desc().nullsFirst(),
      table.createdAt.desc().nullsFirst(),
    ),
    
    uniqueIndex('uq_so_appointment')
      .on(table.appointmentId)
      .where(sql`appointment_id IS NOT NULL`),
    
    uniqueIndex('uq_so_client_active')
      .on(table.clientUserId)
      .where(sql`status NOT IN ('已完成','已取消')`),
  ],
)


export const serviceItems = pgTable(
  'service_items',
  {
    serviceItemId: text('service_item_id').primaryKey(),
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    
    unitRealPrice: numeric('unit_real_price', { precision: 10, scale: 2 }),
    
    isShengmei: boolean('is_shengmei'),
    
    salesCategory: salesCategoryEnum('sales_category'),
    serviceOrderId: varchar('service_order_id', { length: 30 })
      .notNull()
      .references(() => serviceOrders.serviceOrderId),
    sessionUsed: integer('session_used').notNull(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    
    serviceDuration: integer('service_duration'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_svc_items_order_id').on(table.serviceOrderId),
  ],
)


export const serviceReviews = pgTable(
  'service_reviews',
  {
    serviceOrderId: varchar('service_order_id', { length: 30 })
      .primaryKey()
      .references(() => serviceOrders.serviceOrderId),
    
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    
    rating: integer('rating').notNull(),
    
    comment: text('comment'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    
    index('idx_svc_reviews_employee').on(table.employeeId),
  ],
)

export type ServiceOrder = typeof serviceOrders.$inferSelect
export type NewServiceOrder = typeof serviceOrders.$inferInsert
export type ServiceItem = typeof serviceItems.$inferSelect
export type NewServiceItem = typeof serviceItems.$inferInsert
export type ServiceReview = typeof serviceReviews.$inferSelect
export type NewServiceReview = typeof serviceReviews.$inferInsert
