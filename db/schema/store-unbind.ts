import { pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { storeUnbindRequestStatusEnum } from './enums'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'

export const storeUnbindRequests = pgTable(
  'store_unbind_requests',
  {
    requestId:    text('request_id').primaryKey(),
    userId:       text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    fromStoreId:  text('from_store_id')
      .notNull()
      .references(() => stores.storeId),
    
    toStoreId:    text('to_store_id').references(() => stores.storeId),
    status:       storeUnbindRequestStatusEnum('status').notNull().default('待处理'),
    note:         text('note'),
    reviewedBy:   varchar('reviewed_by', { length: 30 }).references(() => staffWechatUsers.employeeId),
    reviewedAt:   timestamp('reviewed_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    
    uniqueIndex('uq_store_unbind_pending')
      .on(table.userId)
      .where(sql`status = '待处理'`),
  ],
)

export type StoreUnbindRequest = typeof storeUnbindRequests.$inferSelect
export type NewStoreUnbindRequest = typeof storeUnbindRequests.$inferInsert
