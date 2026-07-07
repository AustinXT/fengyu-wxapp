import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 系统配置
 *
 * 键值对形式存储系统级配置（如同步时间戳、功能开关等）。
 */
export const systemConfigs = pgTable('system_configs', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SystemConfig = typeof systemConfigs.$inferSelect
export type NewSystemConfig = typeof systemConfigs.$inferInsert
