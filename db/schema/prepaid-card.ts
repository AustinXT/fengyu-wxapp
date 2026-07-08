import { bigserial, check, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { cardTransactionTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'


export const prepaidCards = pgTable(
  'prepaid_cards',
  {
    cardId: text('card_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_prepaid_cards_user').on(table.userId),
    check('chk_prepaid_balance_nonneg', sql`${table.balance} >= 0`),
  ],
)


export const cardTransactions = pgTable(
  'card_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => prepaidCards.cardId),
    type: cardTransactionTypeEnum('type').notNull(),
    
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_card_txns_card_id').on(table.cardId),
    uniqueIndex('uq_card_txn_external_ref')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    check(
      'chk_card_tx_amount_sign',
      sql`(${table.type} = '充值' AND ${table.amount} > 0) OR (${table.type} = '扣款' AND ${table.amount} < 0)`,
    ),
  ],
)

export type PrepaidCard = typeof prepaidCards.$inferSelect
export type NewPrepaidCard = typeof prepaidCards.$inferInsert
export type CardTransaction = typeof cardTransactions.$inferSelect
export type NewCardTransaction = typeof cardTransactions.$inferInsert
