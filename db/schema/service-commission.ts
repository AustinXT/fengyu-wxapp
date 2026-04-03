import { bigserial, boolean, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { serviceItems } from './service'
import { staffWechatUsers } from './user'

/**
 * 服务提成（手工费/卡数提成）
 *
 * 护理单完成时触发，计算基础是 service_items.unit_real_price。
 * 与 sale_allocations（销售提成）独立追踪。
 */
export const serviceCommissions = pgTable(
  'service_commissions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    serviceItemId: text('service_item_id')
      .notNull()
      .references(() => serviceItems.serviceItemId),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 员工角色类型（美容师/养生师/推广师） */
    roleType: varchar('role_type', { length: 20 }),
    /** 分配比例（0.10~1.00，整十百分比） */
    allocationRatio: numeric('allocation_ratio', { precision: 5, scale: 2 }),
    /** 提成比例（从提成矩阵获取） */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    /** 提成金额 */
    commissionAmount: numeric('commission_amount', { precision: 10, scale: 2 }).notNull(),
    /** 软删除标记 */
    isVoid: boolean('is_void').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_svc_comm_item_emp_role')
      .on(table.serviceItemId, table.employeeId, table.roleType)
      .where(sql`is_void = false`),
    index('idx_svc_comm_employee_id').on(table.employeeId),
  ],
)

export type ServiceCommission = typeof serviceCommissions.$inferSelect
export type NewServiceCommission = typeof serviceCommissions.$inferInsert
