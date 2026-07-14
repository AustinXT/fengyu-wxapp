import { index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appointmentStatusEnum } from './enums'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'
import { saleItems } from './order'


export const appointments = pgTable(
  'appointments',
  {
    appointmentId: text('appointment_id').primaryKey(),
    status: appointmentStatusEnum('status').notNull().default('待确认'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    clientName: varchar('client_name', { length: 50 }).notNull(),
    
    employeeId: varchar('employee_id', { length: 30 }).references(() => staffWechatUsers.employeeId),
    employeeName: varchar('employee_name', { length: 50 }),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(() => saleItems.saleItemId),
    appointmentTime: timestamp('appointment_time', { withTimezone: true }).notNull(),
    
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    checkinAt: timestamp('checkin_at', { withTimezone: true }),
    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_appts_store_id').on(table.storeId),
    index('idx_appts_client_user_id').on(table.clientUserId),
    index('idx_appts_employee_time').on(table.employeeId, table.appointmentTime),
    
    uniqueIndex('uq_appt_sale_item_active')
      .on(table.saleItemId)
      .where(sql`sale_item_id IS NOT NULL AND status IN ('待确认','已确认')`),
    /** 同一美容师同一时段起点只能有 1 个活跃预约：1 对 1 防重复预约 + 并发兜底 */
    uniqueIndex('uq_appt_employee_time_active')
      .on(table.employeeId, table.appointmentTime)
      .where(sql`employee_id IS NOT NULL AND status IN ('待确认','已确认')`),
  ],
)

export type Appointment = typeof appointments.$inferSelect
export type NewAppointment = typeof appointments.$inferInsert
