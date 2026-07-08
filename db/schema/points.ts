import { bigint, bigserial, check, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'


export const pointTransactions = pgTable(
  'point_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    type: text('type').notNull().default('获取'),
    
    amount: bigint('amount', { mode: 'number' }).notNull(),
    
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_point_txns_user_id').on(table.userId),
    uniqueIndex('uq_point_txns_external_ref')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    
    uniqueIndex('uq_point_txn_order_user_type')
      .on(table.userId, table.refOrderId, table.type)
      .where(sql`ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')`),
    
    
    check(
      'chk_pt_amount_sign',
      sql`(${table.amount} < 0 AND ${table.type} = '消费冲销') OR ${table.amount} > 0`,
    ),
  ],
)

export type PointTransaction = typeof pointTransactions.$inferSelect
export type NewPointTransaction = typeof pointTransactions.$inferInsert
