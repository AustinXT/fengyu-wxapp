import { index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appointmentStatusEnum } from './enums'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'
import { saleItems } from './order'

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
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    clientName: varchar('client_name', { length: 50 }).notNull(),
    /** 预约美容师（可选）：顾客可不指定，由门店后续分配 */
    employeeId: varchar('employee_id', { length: 30 }).references(() => staffWechatUsers.employeeId),
    employeeName: varchar('employee_name', { length: 50 }),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(() => saleItems.saleItemId),
    appointmentTime: timestamp('appointment_time').notNull(),
    /** 确认时间（员工确认预约时记录） */
    confirmedAt: timestamp('confirmed_at'),
    checkinAt: timestamp('checkin_at'),
    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_appts_store_id').on(table.storeId),
    index('idx_appts_client_user_id').on(table.clientUserId),
    index('idx_appts_employee_time').on(table.employeeId, table.appointmentTime),
    /** 同一 sale_item 同时只能有 1 个活跃预约：防 client 双发 create */
    uniqueIndex('uq_appt_sale_item_active')
      .on(table.saleItemId)
      .where(sql`sale_item_id IS NOT NULL AND status IN ('待确认','已确认')`),
  ],
)

export type Appointment = typeof appointments.$inferSelect
export type NewAppointment = typeof appointments.$inferInsert
