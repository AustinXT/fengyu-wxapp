import { bigserial, integer, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'


export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    
    phone: varchar('phone', { length: 20 }).notNull(),
    
    failCount: integer('fail_count').notNull().default(0),
    
    lockedUntil: timestamp('locked_until'),
    
    lastFailedAt: timestamp('last_failed_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_login_attempts_phone').on(table.phone),
  ],
)

export type LoginAttempt = typeof loginAttempts.$inferSelect
export type NewLoginAttempt = typeof loginAttempts.$inferInsert
