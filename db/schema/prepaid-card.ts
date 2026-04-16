import { bigserial, index, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { cardTransactionTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { stores } from './org'
import { saleOrders } from './order'

/**
 * 充值卡账户
 *
 * 业务规则：金额与门店绑定 —— 一个顾客在每家门店独立一个账户，
 * 通过 UNIQUE(user_id, store_id) 保证"一户一店一账户"。
 * 消费时云函数必须校验卡的 store_id 与当前消费门店一致，否则拒绝。
 */
export const prepaidCards = pgTable(
  'prepaid_cards',
  {
    cardId: text('card_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    /** 绑定门店（必填，金额按门店隔离的核心约束） */
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    // 核心约束：一户一店一账户
    uniqueIndex('uq_prepaid_cards_user_store').on(table.userId, table.storeId),
    index('idx_prepaid_cards_user_id').on(table.userId),
    index('idx_prepaid_cards_store_id').on(table.storeId),
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
