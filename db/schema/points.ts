import { bigserial, index, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 顾客积分余额
 *
 * 注意：会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护，
 * 由 cronTask 每日凌晨3点根据滚动 12 个月消费额重算，与积分系统解耦。
 */
export const customerPoints = pgTable('customer_points', {
  userId: text('user_id')
    .primaryKey()
    .references(() => clientWechatUsers.userId),
  balance: integer('balance').notNull().default(0),
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
    type: text('type').notNull().default('获取'),
    /** 积分变动量 */
    amount: integer('amount').notNull(),
    /** 关联订单ID（可选） */
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_point_txns_user_id').on(table.userId),
  ],
)

export type CustomerPoints = typeof customerPoints.$inferSelect
export type PointTransaction = typeof pointTransactions.$inferSelect
export type NewPointTransaction = typeof pointTransactions.$inferInsert
