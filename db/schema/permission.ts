import { bigserial, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'
import { staffWechatUsers } from './user'


export const permissionRoles = pgTable(
  'permission_roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    
    role: text('role').notNull(),
    
    scopeId: text('scope_id')
      .notNull()
      .references(() => orgNodes.id),
    
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_perm_roles_emp_role_scope')
      .on(table.employeeId, table.role, table.scopeId),
  ],
)

export type PermissionRole = typeof permissionRoles.$inferSelect
export type NewPermissionRole = typeof permissionRoles.$inferInsert
