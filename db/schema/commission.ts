import { bigserial, check, numeric, pgTable, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core'
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
    /**
     * 划卡单价阈值（#379）：单次实价低于阈值时按阈值 × 比例计消耗提成；NULL = 不启用。
     * 仅服务单的自销自耗 / 他销自耗行允许配置（chk_commission_matrix_price_threshold 封死范围），
     * 计算端不硬编码类目，只做 max(单价, COALESCE(阈值, 0))。
     */
    priceThreshold: numeric('price_threshold', { precision: 10, scale: 2 }),
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
    check(
      'chk_commission_matrix_price_threshold',
      sql`${table.priceThreshold} IS NULL OR (${table.priceThreshold} >= 0 AND ${table.orderType} = '服务单' AND ${table.salesCategory} IN ('自销自耗', '他销自耗'))`,
    ),
  ],
)

export type CommissionRateMatrix = typeof commissionRateMatrix.$inferSelect
export type NewCommissionRateMatrix = typeof commissionRateMatrix.$inferInsert
