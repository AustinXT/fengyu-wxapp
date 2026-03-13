import { bigserial, boolean, index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { messageRecipientTypeEnum } from './enums'

/**
 * 消息中心
 *
 * 统一存储客户端和员工端的站内消息。
 * ref_entity_type + ref_entity_id 用于关联业务实体（如订单、预约等）。
 */
export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipientType: messageRecipientTypeEnum('recipient_type').notNull(),
    /** 接收人ID（client_wechat_users.user_id 或 staff_wechat_users.employee_id） */
    recipientId: text('recipient_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    /** 消息分类（如 order/appointment/service/system） */
    messageType: varchar('message_type', { length: 50 }),
    isRead: boolean('is_read').notNull().default(false),
    /** 关联实体类型（如 sale_order/appointment/service_order） */
    refEntityType: varchar('ref_entity_type', { length: 50 }),
    /** 关联实体ID */
    refEntityId: text('ref_entity_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_recipient').on(table.recipientType, table.recipientId, table.isRead),
  ],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
