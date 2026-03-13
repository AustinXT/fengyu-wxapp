import { bigserial, index, integer, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { pointTransactionTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 会员等级定义
 */
export const memberLevels = pgTable('member_levels', {
  levelId: text('level_id').primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  /** 达到此等级所需最低积分 */
  minPoints: integer('min_points').notNull().default(0),
  /** 等级权益描述（JSON） */
  benefits: jsonb('benefits'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 顾客积分余额
 */
export const customerPoints = pgTable('customer_points', {
  userId: text('user_id')
    .primaryKey()
    .references(() => clientWechatUsers.userId),
  balance: integer('balance').notNull().default(0),
  levelId: text('level_id').references(() => memberLevels.levelId),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 积分流水
 */
export const pointTransactions = pgTable(
  'point_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    type: pointTransactionTypeEnum('type').notNull(),
    /** 积分变动量（earn 为正，redeem 为负） */
    amount: integer('amount').notNull(),
    /** 关联订单ID（可选） */
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_point_txns_user_id').on(table.userId),
  ],
)

export type MemberLevel = typeof memberLevels.$inferSelect
export type NewMemberLevel = typeof memberLevels.$inferInsert
export type CustomerPoints = typeof customerPoints.$inferSelect
export type PointTransaction = typeof pointTransactions.$inferSelect
export type NewPointTransaction = typeof pointTransactions.$inferInsert
