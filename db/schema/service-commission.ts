import { bigserial, boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { serviceItems } from './service'
import { staffWechatUsers } from './user'


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
    
    roleType: varchar('role_type', { length: 20 }).notNull(),
    
    allocationRatio: numeric('allocation_ratio', { precision: 5, scale: 2 }),
    
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    
    fixedFee: numeric('fixed_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    
    consumeAmount: numeric('consume_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    
    commissionAmount: numeric('commission_amount', { precision: 10, scale: 2 }).notNull(),
    
    isVoid: boolean('is_void').notNull().default(false),
    
    voidedAt: timestamp('voided_at'),
    
    voidedReason: text('voided_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_svc_comm_item_emp_role')
      .on(table.serviceItemId, table.employeeId, table.roleType)
      .where(sql`is_void = false`),
    index('idx_svc_comm_employee_id').on(table.employeeId),
    
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
