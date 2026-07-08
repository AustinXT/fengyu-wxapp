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
 *   per_session    = sale_items.unit_real_price （已是 per-session 单次价，直接取用，不再 ÷session_count）
 *   consume_amount = per_session × session_used × commission_rate
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
    /** 消耗提成部分 = per_session × session_used × commission_rate（per_session 见文件顶部公式） */
    consumeAmount: numeric('consume_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    /** 提成金额合计 = fixed_fee + consume_amount */
    commissionAmount: numeric('commission_amount', { precision: 10, scale: 2 }).notNull(),
    /** 软删除标记 */
    isVoid: boolean('is_void').notNull().default(false),
    /**
     * 软删除时间（与 sale_allocations.voided_at 对齐；2026-04-26 sale-order-domain-refactor 新增）。
     * 退款审批通过时由应用层级联写入，业绩重算时 WHERE voided_at IS NULL。
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    /** 软删除原因（与 sale_allocations.voided_reason 对齐；2026-04-26 新增） */
    voidedReason: text('voided_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_svc_comm_item_emp_role')
      .on(table.serviceItemId, table.employeeId, table.roleType)
      .where(sql`is_void = false`),
    index('idx_svc_comm_employee_id').on(table.employeeId),
    /** 软删除筛选索引（仅索引 voided_at IS NOT NULL 的行，用于历史回滚审计） */
    index('idx_sc_voided_at')
      .on(table.voidedAt)
      .where(sql`voided_at IS NOT NULL`),
    check('chk_svc_comm_fixed_fee', sql`${table.fixedFee} >= 0`),
    check('chk_svc_comm_consume_amount', sql`${table.consumeAmount} >= 0`),
    check('chk_svc_comm_commission_amount', sql`${table.commissionAmount} >= 0`),
    check('chk_svc_comm_commission_rate', sql`${table.commissionRate} >= 0 AND ${table.commissionRate} <= 1`),
    check('chk_svc_comm_alloc_ratio', sql`${table.allocationRatio} IS NULL OR ${table.allocationRatio} IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00)`),
  ],
)

export type ServiceCommission = typeof serviceCommissions.$inferSelect
export type NewServiceCommission = typeof serviceCommissions.$inferInsert
