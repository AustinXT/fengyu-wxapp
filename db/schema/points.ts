import { bigserial, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 积分流水（权威源）
 * 余额缓存已合并至 client_wechat_users.points_balance，由 cronTask 每日重算写入。
 * 会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护。
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
    /** 外部幂等引用；系统批量发放（升级/活动）使用，业务发放可为 null */
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_point_txns_user_id').on(table.userId),
    uniqueIndex('uq_point_txns_external_ref')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
  ],
)

export type PointTransaction = typeof pointTransactions.$inferSelect
export type NewPointTransaction = typeof pointTransactions.$inferInsert
