import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { storeUnbindRequestStatusEnum } from './enums'

export const storeUnbindRequests = pgTable('store_unbind_requests', {
  requestId:     text('request_id').primaryKey(),
  userId:        text('user_id').notNull(),
  fromStoreName: text('from_store_name').notNull(),
  status:        storeUnbindRequestStatusEnum('status').notNull().default('pending'),
  note:          text('note'),
  reviewedBy:    text('reviewed_by'),
  reviewedAt:    timestamp('reviewed_at'),
  rejectReason:  text('reject_reason'),
  createdAt:     timestamp('created_at').notNull().defaultNow(),
  updatedAt:     timestamp('updated_at').notNull().defaultNow(),
})
