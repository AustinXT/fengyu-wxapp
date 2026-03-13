import { boolean, bigserial, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'
import { staffWechatUsers } from './user'

/**
 * 权限角色分配
 *
 * 一人可有多个角色（如 manager + hr），每个角色一条记录。
 * 同一角色可分配到多个域（如 manager 同时管两家门店），每个 scope_id 一条记录。
 * 软删除：is_void = true 的记录不参与权限查询。
 */
export const permissionRoles = pgTable(
  'permission_roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 角色：admin / manager / finance / hr / product / staff / customer_mgr */
    role: text('role').notNull(),
    /** 指向 headquarters/market/store 级别的节点 */
    scopeId: text('scope_id')
      .notNull()
      .references(() => orgNodes.id),
    isVoid: boolean('is_void').notNull().default(false),
    voidedAt: timestamp('voided_at'),
    /** 同步脚本标记 'sync'，手动标记操作人员工编号 */
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_perm_roles_emp_role_scope')
      .on(table.employeeId, table.role, table.scopeId)
      .where(sql`is_void = false`),
  ],
)

export type PermissionRole = typeof permissionRoles.$inferSelect
export type NewPermissionRole = typeof permissionRoles.$inferInsert
