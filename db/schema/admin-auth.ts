import { bigserial, boolean, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { staffWechatUsers } from './user'

/**
 * 管理后台登录密码
 *
 * 仅持有此表记录的员工可通过手机号+密码登录管理后台。
 * staff 角色不可登录；admin/manager/finance/hr/product/customer_mgr 可登录。
 */
export const adminPasswords = pgTable(
  'admin_passwords',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** bcrypt（cost ≥ 12） */
    passwordHash: text('password_hash').notNull(),
    /** 首次登录强制改密 */
    mustChange: boolean('must_change').notNull().default(true),
    lastChangedAt: timestamp('last_changed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_admin_passwords_employee').on(table.employeeId),
  ],
)

export type AdminPassword = typeof adminPasswords.$inferSelect
export type NewAdminPassword = typeof adminPasswords.$inferInsert
