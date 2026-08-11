import { bigserial, boolean, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'
import { staffWechatUsers } from './user'

/**
 * 可配置权限角色定义。
 *
 * roleKey 是内部稳定标识：旧角色沿用 admin/manager/...，自定义角色由服务端生成。
 * 展示名、权限与能力可编辑，但 roleKey 永不改名，避免重写员工授权和审计记录。
 */
export const permissionRoleDefinitions = pgTable(
  'permission_role_definitions',
  {
    roleKey: varchar('role_key', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 30 }).notNull(),
    description: varchar('description', { length: 200 }),
    actions: text('actions').array().notNull().default(sql`ARRAY[]::text[]`),
    canAccessAdmin: boolean('can_access_admin').notNull().default(true),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    isStoreManager: boolean('is_store_manager').notNull().default(false),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_permission_role_definitions_name').on(table.name),
  ],
)

/**
 * 权限角色分配
 *
 * 一人可有多个角色（如 manager + hr），每个角色一条记录。
 * 同一角色可分配到多个域（如 manager 同时管两家门店），每个 scope_id 一条记录。
 * 撤销权限直接删除记录（硬删除）。
 */
export const permissionRoles = pgTable(
  'permission_roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 指向可配置角色定义的稳定 role_key */
    role: text('role')
      .notNull()
      .references(() => permissionRoleDefinitions.roleKey, { onDelete: 'restrict' }),
    /** 指向 headquarters/market/store 级别的节点 */
    scopeId: text('scope_id')
      .notNull()
      .references(() => orgNodes.id),
    /** 同步脚本标记 'sync'，手动标记操作人员工编号 */
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_perm_roles_emp_role_scope')
      .on(table.employeeId, table.role, table.scopeId),
  ],
)

export type PermissionRole = typeof permissionRoles.$inferSelect
export type NewPermissionRole = typeof permissionRoles.$inferInsert
export type PermissionRoleDefinition = typeof permissionRoleDefinitions.$inferSelect
export type NewPermissionRoleDefinition = typeof permissionRoleDefinitions.$inferInsert
