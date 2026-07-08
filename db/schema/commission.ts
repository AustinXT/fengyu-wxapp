import { bigserial, numeric, pgTable, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'


export const commissionRateMatrix = pgTable(
  'commission_rate_matrix',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    
    orgId: text('org_id')
      .notNull()
      .references(() => orgNodes.id),
    orderType: varchar('order_type', { length: 20 }).notNull(),
    roleType: varchar('role_type', { length: 20 }).notNull(),
    salesCategory: varchar('sales_category', { length: 20 }).notNull(),
    
    amountTierMin: numeric('amount_tier_min', { precision: 10, scale: 2 }).notNull(),
    
    amountTierMax: numeric('amount_tier_max', { precision: 10, scale: 2 }),
    
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    unique('uq_commission_matrix').on(
      table.orgId,
      table.orderType,
      table.roleType,
      table.salesCategory,
      table.amountTierMin,
    ),
  ],
)

export type CommissionRateMatrix = typeof commissionRateMatrix.$inferSelect
export type NewCommissionRateMatrix = typeof commissionRateMatrix.$inferInsert
