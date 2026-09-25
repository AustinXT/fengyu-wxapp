import { bigserial, check, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { saleItems } from './order'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'
import { inventorySkus } from './inventory'

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
    /** 旧版单库存 SKU 提货记录；组成式提货写 NULL，实际明细以 inventory_doc_items 为准。 */
    inventorySkuId: text('inventory_sku_id').references(() => inventorySkus.skuId),
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
    /**
     * 提货时冻结的顾客实际单价（= 当时 sale_items.unit_real_price，#341）。
     * 之后订单改价不回写；上线前的历史行为 NULL（不回填）。
     */
    pickupUnitPrice: numeric('pickup_unit_price', { precision: 12, scale: 2 }),
    /**
     * 出库金额 = 本次提货数 × 冻结单价（#341，店长产品出库提成的数据来源）。
     * 销售单位级、套装只记一次；与 GCK 明细的成本金额（inventory_doc_items.amount）分开存。
     * 寄存单 / 0 元赠品 / 转换转入同样按 unit_real_price 计（0 元行即 0）。
     */
    pickupAmount: numeric('pickup_amount', { precision: 12, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pickup_records_sale_item').on(table.saleItemId),
    index('idx_pickup_records_inventory_sku').on(table.inventorySkuId),
    index('idx_pickup_records_client').on(table.clientUserId),
    uniqueIndex('uq_pickup_idempotency')
      .on(table.saleItemId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    check('chk_pickup_quantity', sql`${table.pickupQuantity} > 0`),
    // 两列同生同灭（历史行双 NULL），且金额必须等于 数量 × 冻结单价：写入端算错会直接被拒。
    check(
      'chk_pickup_amount_frozen',
      sql`(${table.pickupUnitPrice} IS NULL AND ${table.pickupAmount} IS NULL) OR (${table.pickupUnitPrice} IS NOT NULL AND ${table.pickupAmount} = ROUND(${table.pickupUnitPrice} * ${table.pickupQuantity}, 2))`,
    ),
  ],
)

export type PickupRecord = typeof pickupRecords.$inferSelect
export type NewPickupRecord = typeof pickupRecords.$inferInsert
