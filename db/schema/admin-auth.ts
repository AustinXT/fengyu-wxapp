import { bigserial, boolean, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { staffWechatUsers } from './user'


export const adminPasswords = pgTable(
  'admin_passwords',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .references((): any => staffWechatUsers.employeeId),
    
    passwordHash: text('password_hash').notNull(),
    
    mustChange: boolean('must_change').notNull().default(true),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_admin_passwords_employee').on(table.employeeId),
  ],
)

export type AdminPassword = typeof adminPasswords.$inferSelect
export type NewAdminPassword = typeof adminPasswords.$inferInsert
