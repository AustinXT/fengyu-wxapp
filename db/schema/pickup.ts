import { bigserial, check, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { saleItems } from './order'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'


export const pickupRecords = pgTable(
  'pickup_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    
    pickupQuantity: integer('pickup_quantity').notNull(),
    
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    
    confirmedBy: varchar('confirmed_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    remark: text('remark'),
    
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pickup_records_sale_item').on(table.saleItemId),
    index('idx_pickup_records_client').on(table.clientUserId),
    uniqueIndex('uq_pickup_idempotency')
      .on(table.saleItemId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    check('chk_pickup_quantity', sql`${table.pickupQuantity} > 0`),
  ],
)

export type PickupRecord = typeof pickupRecords.$inferSelect
export type NewPickupRecord = typeof pickupRecords.$inferInsert
