import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'


export const systemConfigs = pgTable('system_configs', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SystemConfig = typeof systemConfigs.$inferSelect
export type NewSystemConfig = typeof systemConfigs.$inferInsert
