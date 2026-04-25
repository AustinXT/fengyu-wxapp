import { bigserial, boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { serviceItems } from './service'
import { staffWechatUsers } from './user'

/**
 * 服务提成（手工费/卡数提成）
 *
 * 服务单完成时触发，按"固定手工费 + 消耗比例"双字段模型计算。
 * 计算口径：
 *   fixed_fee      = sale_items.service_fee × service_items.session_used
 *   consume_amount = service_items.unit_real_price × session_used × commission_rate
 *   commission_amount = fixed_fee + consume_amount
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
    roleType: varchar('role_type', { length: 20 }).notNull(),
    /** 分配比例（0.10~1.00，整十百分比） */
    allocationRatio: numeric('allocation_ratio', { precision: 5, scale: 2 }),
    /** 提成比例（从提成矩阵 order_type='服务单' 获取，无匹配规则时为 0） */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    /** 固定手工费部分 = sale_items.service_fee × session_used（不随 commission_rate 变化） */
    fixedFee: numeric('fixed_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    /** 消耗提成部分 = unit_real_price × session_used × commission_rate */
    consumeAmount: numeric('consume_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    /** 提成金额合计 = fixed_fee + consume_amount */
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
    check('chk_svc_comm_fixed_fee', sql`${table.fixedFee} >= 0`),
    check('chk_svc_comm_consume_amount', sql`${table.consumeAmount} >= 0`),
  ],
)

export type ServiceCommission = typeof serviceCommissions.$inferSelect
export type NewServiceCommission = typeof serviceCommissions.$inferInsert
