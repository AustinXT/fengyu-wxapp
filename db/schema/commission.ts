import { bigserial, numeric, pgTable, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'

/**
 * 提成比例矩阵
 *
 * 同步自 WorkFine，市场名称通过 JOIN org_nodes 获取。
 */
export const commissionRateMatrix = pgTable(
  'commission_rate_matrix',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** FK → org_nodes.id（市场节点） */
    orgId: text('org_id')
      .notNull()
      .references(() => orgNodes.id),
    orderType: varchar('order_type', { length: 20 }).notNull(),
    roleType: varchar('role_type', { length: 20 }).notNull(),
    salesCategory: varchar('sales_category', { length: 20 }).notNull(),
    /** 金额阶段下限（含） */
    amountTierMin: numeric('amount_tier_min', { precision: 10, scale: 2 }).notNull(),
    /** 金额阶段上限（不含；null 表示无上限） */
    amountTierMax: numeric('amount_tier_max', { precision: 10, scale: 2 }),
    /** 提成比例（如 0.08 = 8%） */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
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
