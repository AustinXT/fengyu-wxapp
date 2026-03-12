import { boolean, date, index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { stores, orgNodes } from './org'

/**
 * 员工表
 *
 * 同步自 WorkFine UDT_S_287，store_id 通过 store_name 匹配写入，
 * org_node_id 通过部门名匹配 org_nodes(type='department') 写入。
 *
 * 角色判定查询 permission_roles 表，无记录时降级为 role=staff, scope=所在门店。
 */
export const employees = pgTable(
  'employees',
  {
    employeeId: varchar('employee_id', { length: 30 }).primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    gender: varchar('gender', { length: 20 }),
    phone: varchar('phone', { length: 20 }),
    /** 身份证号码（AES-256-GCM 加密存储） */
    idCard: varchar('id_card', { length: 200 }),
    storeId: text('store_id').references(() => stores.storeId),
    /** 指向 type='department' 的部门节点 */
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    positionName: varchar('position_name', { length: 50 }),
    birthday: date('birthday'),
    /** 技能标签数组，由员工端手动维护 */
    skills: text('skills').array(),
    isResigned: boolean('is_resigned').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_employees_store_resigned').on(table.storeId, table.isResigned),
    index('idx_employees_phone').on(table.phone),
  ],
)

export type Employee = typeof employees.$inferSelect
export type NewEmployee = typeof employees.$inferInsert
