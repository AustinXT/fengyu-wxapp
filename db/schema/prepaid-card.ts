import { bigserial, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { cardTransactionTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 充值卡账户
 *
 * 业务规则：一户一账户，余额跨店共享 —— 顾客换绑门店后原余额继续可用。
 * 消费时云函数只需校验 user_id，无门店范围限制。
 */
export const prepaidCards = pgTable(
  'prepaid_cards',
  {
    cardId: text('card_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_prepaid_cards_user').on(table.userId),
  ],
)

/**
 * 充值卡流水
 */
export const cardTransactions = pgTable(
  'card_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => prepaidCards.cardId),
    type: cardTransactionTypeEnum('type').notNull(),
    /** 金额（topup 为正，deduct 为负） */
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    /** 关联订单ID（可选） */
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_card_txns_card_id').on(table.cardId),
  ],
)

export type PrepaidCard = typeof prepaidCards.$inferSelect
export type NewPrepaidCard = typeof prepaidCards.$inferInsert
export type CardTransaction = typeof cardTransactions.$inferSelect
export type NewCardTransaction = typeof cardTransactions.$inferInsert
