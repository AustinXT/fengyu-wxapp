import {
  bigserial,
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  inventoryDocStatusEnum,
  inventoryProcurementSubtypeEnum,
  inventorySaleSubtypeEnum,
  inventoryTransferSubtypeEnum,
} from './enums'
import { stores } from './org'
import { clientWechatUsers, staffWechatUsers } from './user'
import { saleOrders } from './order'








export const inventoryProcurementOrders = pgTable(
  'inventory_procurement_orders',
  {
    
    id: text('id').primaryKey(),
    docSubtype: inventoryProcurementSubtypeEnum('doc_subtype').notNull(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    
    isCompleted: boolean('is_completed').notNull().default(false),
    
    sourceDate: date('source_date'),
    
    sourceQuantity: numeric('source_quantity', { precision: 12, scale: 2 }),
    
    signatureUrl: text('signature_url'),
    
    relatedDocNo: text('related_doc_no'),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inv_proc_store_date').on(table.storeId, table.docDate),
    index('idx_inv_proc_subtype').on(table.docSubtype),
  ],
)

export const inventoryProcurementOrderItems = pgTable(
  'inventory_procurement_order_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => inventoryProcurementOrders.id, { onDelete: 'cascade' }),
    productCode: text('product_code').notNull(),
    productName: text('product_name').notNull(),
    specName: text('spec_name'),
    manufacturer: text('manufacturer'),
    productSeries: text('product_series'),
    batchNo: text('batch_no'),
    expiryDate: date('expiry_date'),
    isGift: boolean('is_gift').notNull().default(false),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    
    stockOnHand: numeric('stock_on_hand', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    
    requestQuantity: numeric('request_quantity', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_proc_items_order').on(table.orderId),
    index('idx_inv_proc_items_product').on(table.productCode),
    index('idx_inv_proc_items_batch').on(table.batchNo),
    check('chk_inv_proc_items_quantity', sql`${table.quantity} > 0`),
  ],
)






export const inventorySaleOrders = pgTable(
  'inventory_sale_orders',
  {
    id: text('id').primaryKey(),
    docSubtype: inventorySaleSubtypeEnum('doc_subtype').notNull(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    
    clientUserId: text('client_user_id').references(
      () => clientWechatUsers.userId,
    ),
    
    customerName: varchar('customer_name', { length: 50 }),
    
    relatedSaleOrderId: varchar('related_sale_order_id', { length: 30 }).references(
      () => saleOrders.saleOrderId,
    ),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inv_sale_store_date').on(table.storeId, table.docDate),
    index('idx_inv_sale_subtype').on(table.docSubtype),
    index('idx_inv_sale_client').on(table.clientUserId),
  ],
)

export const inventorySaleOrderItems = pgTable(
  'inventory_sale_order_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => inventorySaleOrders.id, { onDelete: 'cascade' }),
    productCode: text('product_code').notNull(),
    productName: text('product_name').notNull(),
    specName: text('spec_name'),
    manufacturer: text('manufacturer'),
    productSeries: text('product_series'),
    batchNo: text('batch_no'),
    expiryDate: date('expiry_date'),
    isGift: boolean('is_gift').notNull().default(false),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    stockOnHand: numeric('stock_on_hand', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    
    saleFlowNo: text('sale_flow_no'),
    
    customerRemaining: numeric('customer_remaining', { precision: 12, scale: 2 }),
    
    verificationName: text('verification_name'),
    
    verificationCode: text('verification_code'),
    remark: text('remark'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_sale_items_order').on(table.orderId),
    index('idx_inv_sale_items_product').on(table.productCode),
    index('idx_inv_sale_items_batch').on(table.batchNo),
    check('chk_inv_sale_items_quantity', sql`${table.quantity} > 0`),
  ],
)









export const inventoryTransferOrders = pgTable(
  'inventory_transfer_orders',
  {
    id: text('id').primaryKey(),
    docSubtype: inventoryTransferSubtypeEnum('doc_subtype').notNull(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    
    counterpartStoreId: text('counterpart_store_id')
      .notNull()
      .references(() => stores.storeId),
    
    isDispatcher: boolean('is_dispatcher').notNull().default(true),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    
    receiveQuantity: numeric('receive_quantity', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    
    confirmedAt: timestamp('confirmed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inv_transfer_store_date').on(table.storeId, table.docDate),
    index('idx_inv_transfer_counterpart').on(table.counterpartStoreId),
    index('idx_inv_transfer_subtype').on(table.docSubtype),
    check(
      'chk_inv_transfer_different_stores',
      sql`${table.storeId} <> ${table.counterpartStoreId}`,
    ),
  ],
)

export const inventoryTransferOrderItems = pgTable(
  'inventory_transfer_order_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => inventoryTransferOrders.id, { onDelete: 'cascade' }),
    productCode: text('product_code').notNull(),
    productName: text('product_name').notNull(),
    specName: text('spec_name'),
    manufacturer: text('manufacturer'),
    productSeries: text('product_series'),
    batchNo: text('batch_no'),
    expiryDate: date('expiry_date'),
    isGift: boolean('is_gift').notNull().default(false),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    stockOnHand: numeric('stock_on_hand', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_transfer_items_order').on(table.orderId),
    index('idx_inv_transfer_items_product').on(table.productCode),
    index('idx_inv_transfer_items_batch').on(table.batchNo),
    check('chk_inv_transfer_items_quantity', sql`${table.quantity} > 0`),
  ],
)







export const inventoryScrapOrders = pgTable(
  'inventory_scrap_orders',
  {
    id: text('id').primaryKey(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inv_scrap_store_date').on(table.storeId, table.docDate),
  ],
)

export const inventoryScrapOrderItems = pgTable(
  'inventory_scrap_order_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => inventoryScrapOrders.id, { onDelete: 'cascade' }),
    productCode: text('product_code').notNull(),
    productName: text('product_name').notNull(),
    specName: text('spec_name'),
    manufacturer: text('manufacturer'),
    productSeries: text('product_series'),
    batchNo: text('batch_no'),
    expiryDate: date('expiry_date'),
    isGift: boolean('is_gift').notNull().default(false),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    stockOnHand: numeric('stock_on_hand', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    
    scrapReason: text('scrap_reason').notNull(),
    
    itemUsage: text('item_usage'),
    remark: text('remark'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_scrap_items_order').on(table.orderId),
    index('idx_inv_scrap_items_product').on(table.productCode),
    index('idx_inv_scrap_items_batch').on(table.batchNo),
    check('chk_inv_scrap_items_quantity', sql`${table.quantity} > 0`),
  ],
)





export type InventoryProcurementOrder = typeof inventoryProcurementOrders.$inferSelect
export type NewInventoryProcurementOrder = typeof inventoryProcurementOrders.$inferInsert
export type InventoryProcurementOrderItem =
  typeof inventoryProcurementOrderItems.$inferSelect
export type NewInventoryProcurementOrderItem =
  typeof inventoryProcurementOrderItems.$inferInsert

export type InventorySaleOrder = typeof inventorySaleOrders.$inferSelect
export type NewInventorySaleOrder = typeof inventorySaleOrders.$inferInsert
export type InventorySaleOrderItem = typeof inventorySaleOrderItems.$inferSelect
export type NewInventorySaleOrderItem = typeof inventorySaleOrderItems.$inferInsert

export type InventoryTransferOrder = typeof inventoryTransferOrders.$inferSelect
export type NewInventoryTransferOrder = typeof inventoryTransferOrders.$inferInsert
export type InventoryTransferOrderItem =
  typeof inventoryTransferOrderItems.$inferSelect
export type NewInventoryTransferOrderItem =
  typeof inventoryTransferOrderItems.$inferInsert

export type InventoryScrapOrder = typeof inventoryScrapOrders.$inferSelect
export type NewInventoryScrapOrder = typeof inventoryScrapOrders.$inferInsert
export type InventoryScrapOrderItem = typeof inventoryScrapOrderItems.$inferSelect
export type NewInventoryScrapOrderItem = typeof inventoryScrapOrderItems.$inferInsert
