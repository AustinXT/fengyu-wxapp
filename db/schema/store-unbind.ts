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
    /**
     * 目标门店：转店流程下顾客申请要绑定的新门店。
     * 审批通过后 client_wechat_users.bound_store_id 直接从 from_store_id 改为 to_store_id，
     * 不再出现「解绑后悬空未绑定」中间态。
     * DB 层可空（避免对存量行的 NOT NULL 迁移失败），应用层强制必填。
     */
    toStoreId:    text('to_store_id').references(() => stores.storeId),
    status:       storeUnbindRequestStatusEnum('status').notNull().default('待处理'),
    note:         text('note'),
    reviewedBy:   varchar('reviewed_by', { length: 30 }).references(() => staffWechatUsers.employeeId),
    reviewedAt:   timestamp('reviewed_at'),
    rejectReason: text('reject_reason'),
    createdAt:    timestamp('created_at').notNull().defaultNow(),
    updatedAt:    timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    /** 同顾客同时只能有 1 条待处理转店申请：防双击 / 弱网重试写多行 */
    uniqueIndex('uq_store_unbind_pending')
      .on(table.userId)
      .where(sql`status = '待处理'`),
  ],
)

export type StoreUnbindRequest = typeof storeUnbindRequests.$inferSelect
export type NewStoreUnbindRequest = typeof storeUnbindRequests.$inferInsert
