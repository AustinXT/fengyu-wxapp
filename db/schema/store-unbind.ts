import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { storeUnbindRequestStatusEnum } from './enums'
import { stores } from './org'
import { employees } from './employee'
import { clientWechatUsers } from './user'

export const storeUnbindRequests = pgTable('store_unbind_requests', {
  requestId:    text('request_id').primaryKey(),
  userId:       text('user_id')
    .notNull()
    .references(() => clientWechatUsers.userId),
  fromStoreId:  text('from_store_id')
    .notNull()
    .references(() => stores.storeId),
  status:       storeUnbindRequestStatusEnum('status').notNull().default('pending'),
  note:         text('note'),
  reviewedBy:   varchar('reviewed_by', { length: 30 }).references(() => employees.employeeId),
  reviewedAt:   timestamp('reviewed_at'),
  rejectReason: text('reject_reason'),
  createdAt:    timestamp('created_at').notNull().defaultNow(),
  updatedAt:    timestamp('updated_at').notNull().defaultNow(),
})

export type StoreUnbindRequest = typeof storeUnbindRequests.$inferSelect
export type NewStoreUnbindRequest = typeof storeUnbindRequests.$inferInsert
