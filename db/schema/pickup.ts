import { bigserial, check, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { saleItems } from './order'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'

/**
 * 提货记录
 *
 * 家居产品分次提货追踪。每次提货创建一条记录，
 * 同时原子累加 sale_items.picked_up_quantity。
 * 可提数量 = sale_items.quantity - sale_items.picked_up_quantity。
 */
export const pickupRecords = pgTable(
  'pickup_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 关联的销售明细（家居产品购买行） */
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    /** 本次提货数量 */
    pickupQuantity: integer('pickup_quantity').notNull(),
    /** 提货门店 */
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    /** 提货顾客 */
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    /** 确认提货的员工 */
    confirmedBy: varchar('confirmed_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    remark: text('remark'),
    /** 调用方传入的幂等键（如 pickup-{saleItemId}-{timestamp}），NULL 时不参与唯一约束（向后兼容旧前端） */
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
