import { bigserial, index, numeric, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { cardTransactionTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { stores } from './org'
import { saleOrders } from './order'

/**
 * 充值卡
 */
export const prepaidCards = pgTable(
  'prepaid_cards',
  {
    cardId: text('card_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull().default('0'),
    storeId: text('store_id').references(() => stores.storeId),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_prepaid_cards_user_id').on(table.userId),
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
