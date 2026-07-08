import { pgTable, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'


export const lakalaMerchants = pgTable(
  'lakala_merchants',
  {
    id: text('id').primaryKey(),
    
    merchantName: text('merchant_name').notNull(),
    
    merchantNo: text('merchant_no'),
    
    termNo: text('term_no'),
    
    enabled: boolean('enabled').notNull().default(false),
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    marketOrgNodeId: text('market_org_node_id').references((): any => orgNodes.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    
    
    uniqueIndex('uq_lakala_merchants_merchant_no')
      .on(table.merchantNo)
      .where(sql`${table.merchantNo} IS NOT NULL`),
    
    index('idx_lakala_merchants_market_org_node_id').on(table.marketOrgNodeId),
  ],
)

export type LakalaMerchant = typeof lakalaMerchants.$inferSelect
export type NewLakalaMerchant = typeof lakalaMerchants.$inferInsert
