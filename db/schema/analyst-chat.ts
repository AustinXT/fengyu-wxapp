import { bigint, bigserial, check, index, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { staffWechatUsers } from './user'

/**
 * 分析助手聊天会话。
 *
 * 会话严格归属于创建员工；完整消息不复用 operation_logs，避免审计摘要成为业务数据源。
 */
export const analystChatSessions = pgTable(
  'analyst_chat_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerEmployeeId: varchar('owner_employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    title: varchar('title', { length: 100 }).notNull().default('新对话'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_analyst_chat_sessions_owner_updated').on(table.ownerEmployeeId, table.updatedAt, table.id),
  ],
)

/** 分析助手聊天消息；删除会话时由外键级联永久删除。 */
export const analystChatMessages = pgTable(
  'analyst_chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => analystChatSessions.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(),
    content: text('content').notNull(),
    visualizations: jsonb('visualizations'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_analyst_chat_messages_session_id').on(table.sessionId, table.id),
    check('chk_analyst_chat_messages_role', sql`${table.role} IN ('user', 'assistant')`),
  ],
)

export type AnalystChatSession = typeof analystChatSessions.$inferSelect
export type NewAnalystChatSession = typeof analystChatSessions.$inferInsert
export type AnalystChatMessage = typeof analystChatMessages.$inferSelect
export type NewAnalystChatMessage = typeof analystChatMessages.$inferInsert
