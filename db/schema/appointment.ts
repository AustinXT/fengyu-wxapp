import { index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { appointmentStatusEnum } from './enums'
import { stores } from './org'
import { clientWechatUsers } from './user'
import { saleItems } from './order'
import { employees } from './employee'

/**
 * 预约
 *
 * 状态流转：
 *   待确认 -> 已确认 -> 已完成（到店核销完成后自动流转）
 *   待确认 -> 已取消（顾客取消）
 *   已确认 -> 已取消（顾客取消）
 *   待确认/已确认 -> 已关闭（超过预约时间一天未到店）
 */
export const appointments = pgTable(
  'appointments',
  {
    appointmentId: text('appointment_id').primaryKey(),
    status: appointmentStatusEnum('status').notNull().default('待确认'),
    marketName: varchar('market_name', { length: 100 }).notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    customerName: varchar('customer_name', { length: 50 }).notNull(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => employees.employeeId),
    employeeName: varchar('employee_name', { length: 50 }).notNull(),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(() => saleItems.saleItemId),
    appointmentTime: timestamp('appointment_time').notNull(),
    checkinAt: timestamp('checkin_at'),
    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_appts_store_id').on(table.storeId),
    index('idx_appts_client_user_id').on(table.clientUserId),
    index('idx_appts_employee_time').on(table.employeeId, table.appointmentTime),
  ],
)

export type Appointment = typeof appointments.$inferSelect
export type NewAppointment = typeof appointments.$inferInsert
