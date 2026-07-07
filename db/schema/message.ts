import { bigserial, boolean, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { messageRecipientTypeEnum } from './enums'


export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recipientType: messageRecipientTypeEnum('recipient_type').notNull(),
    
    recipientId: text('recipient_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    
    messageType: varchar('message_type', { length: 50 }),
    isRead: boolean('is_read').notNull().default(false),
    
    refEntityType: varchar('ref_entity_type', { length: 50 }),
    
    refEntityId: text('ref_entity_id'),
    
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    
    deletedAt: timestamp('deleted_at'),
    
    deletedBy: text('deleted_by'),
  },
  (table) => [
    index('idx_messages_recipient').on(table.recipientType, table.recipientId, table.isRead),
    uniqueIndex('uq_messages_idempotency_key')
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index('idx_messages_active')
      .on(table.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
  ],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
