import {
  bigint,
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
  productTypeEnum,
  storeInventoryDocStatusEnum,
  storeInventoryDocTypeEnum,
  storeInventoryMovementDirectionEnum,
} from './enums'
import { orgNodes, stores } from './org'
import { productSkus } from './product'
import { clientWechatUsers, staffWechatUsers } from './user'
import { saleItems, saleOrders } from './order'

/**
 * 门店库存域 v1（2026-05-19 落地）
 *
 * 8 种 WorkFine 库存单据迁到 PG 后按业务方向归类为 4 对表：
 *   procurement — 院报货 / 院入库 / 退货出库     （与供应商互动）
 *   sale         — 销售出库 / 顾客退货             （与顾客互动）
 *   transfer    — 调拨出库 / 调拨入库（单条物理记录 + is_dispatcher 方向位）
 *   scrap       — 报损出库                          （异常损耗）
 *
 * 全部表都是门店级实体：store_id NOT NULL FK stores.storeId。
 * 市场（market）通过 JOIN org_nodes 反查 store 的 parent 拿到，不冗余存储。
 *
 * 写入入口：admin 后台 Server Actions；员工端小程序只读。
 * WorkFine 桌面端上线即弃用；PG 是唯一真理源；不导历史数据。
 */

// ──────────────────────────────────────────────────────────────────────
// 采购入库类（procurement）
// 涵盖：院报货 / 院入库 / 退货出库
// ──────────────────────────────────────────────────────────────────────

export const inventoryProcurementOrders = pgTable(
  'inventory_procurement_orders',
  {
    /** 内部主键 / 单据号，如 'PROC-202605-0001' */
    id: text('id').primaryKey(),
    docSubtype: inventoryProcurementSubtypeEnum('doc_subtype').notNull(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    /** 院报货是否完成（WorkFine UDF_S_3684 语义） */
    isCompleted: boolean('is_completed').notNull().default(false),
    /** 院入库的市场配货日期（UDF_S_6240） */
    sourceDate: date('source_date'),
    /** 院入库的市场配货数量合计（UDF_S_15470） */
    sourceQuantity: numeric('source_quantity', { precision: 12, scale: 2 }),
    /** 院入库的签字图 URL（UDF_S_19043，19% 有值） */
    signatureUrl: text('signature_url'),
    /** 院入库引用的市场出库单号（SCCKD-xxx，UDF_S_3685） */
    relatedDocNo: text('related_doc_no'),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
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
    /** 操作时该 SKU+批号 的库存快照 */
    stockOnHand: numeric('stock_on_hand', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    /** 院报货明细的报货数量（UDF_M_1893） */
    requestQuantity: numeric('request_quantity', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_proc_items_order').on(table.orderId),
    index('idx_inv_proc_items_product').on(table.productCode),
    index('idx_inv_proc_items_batch').on(table.batchNo),
    check('chk_inv_proc_items_quantity', sql`${table.quantity} > 0`),
  ],
)

// ──────────────────────────────────────────────────────────────────────
// 销售出库类（sale）
// 涵盖：销售出库 / 顾客退货（出库为正向，退货数量记负或用 docSubtype 区分）
// ──────────────────────────────────────────────────────────────────────

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
    /** 顾客身份（销售出库 / 顾客退货均需要） */
    clientUserId: text('client_user_id').references(
      () => clientWechatUsers.userId,
    ),
    /** 顾客姓名快照（即使 client 删除也保留） */
    customerName: varchar('customer_name', { length: 50 }),
    /** 引用的销售单（销售出库可引用 sale_orders；UDF_S_9176） */
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
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
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
    /** 销售出库特有：销售流水号（UDF_M_17672，约 20% 有值） */
    saleFlowNo: text('sale_flow_no'),
    /** 销售出库特有：顾客剩余可领取（UDF_M_17685） */
    customerRemaining: numeric('customer_remaining', { precision: 12, scale: 2 }),
    /** 销售出库特有：验证产品名称（UDF_M_18917） */
    verificationName: text('verification_name'),
    /** 销售出库特有：验证产品编号（UDF_M_18918） */
    verificationCode: text('verification_code'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_sale_items_order').on(table.orderId),
    index('idx_inv_sale_items_product').on(table.productCode),
    index('idx_inv_sale_items_batch').on(table.batchNo),
    check('chk_inv_sale_items_quantity', sql`${table.quantity} > 0`),
  ],
)

// ──────────────────────────────────────────────────────────────────────
// 调拨类（transfer）
// 涵盖：调拨出库 / 调拨入库
// 物理：单条记录 + is_dispatcher 方向位 + counterpart_store_id
// store_id = 当前操作门店；counterpart_store_id = 对方门店
// 接收方确认收货通过 confirmed_at + receive_quantity 体现
// ──────────────────────────────────────────────────────────────────────

export const inventoryTransferOrders = pgTable(
  'inventory_transfer_orders',
  {
    id: text('id').primaryKey(),
    docSubtype: inventoryTransferSubtypeEnum('doc_subtype').notNull(),
    status: inventoryDocStatusEnum('status').notNull().default('已完成'),
    /** 发起门店（调拨出库方） */
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    /** 接收门店（调拨入库方） */
    counterpartStoreId: text('counterpart_store_id')
      .notNull()
      .references(() => stores.storeId),
    /** 当前操作门店是否为发起方（true=出库方/发起方；false=接收方记录视图） */
    isDispatcher: boolean('is_dispatcher').notNull().default(true),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 }),
    /** 接收确认的实际收货数量（UDF_S_13030，可能与发起数量不同） */
    receiveQuantity: numeric('receive_quantity', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 接收方确认人 */
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    /** 接收方确认收货时间（NULL 表示尚未确认收货） */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_transfer_items_order').on(table.orderId),
    index('idx_inv_transfer_items_product').on(table.productCode),
    index('idx_inv_transfer_items_batch').on(table.batchNo),
    check('chk_inv_transfer_items_quantity', sql`${table.quantity} > 0`),
  ],
)

// ──────────────────────────────────────────────────────────────────────
// 报损类（scrap）
// 涵盖：报损出库
// 独立字段体系（WorkFine UDF_M_5172-5181）
// ──────────────────────────────────────────────────────────────────────

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
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
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
    /** 报损原因（UDF_M_5181，100% 有值，如 "店用"/"客用"/"顾客xxx"） */
    scrapReason: text('scrap_reason').notNull(),
    /** 用途细分（保留扩展） */
    itemUsage: text('item_usage'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inv_scrap_items_order').on(table.orderId),
    index('idx_inv_scrap_items_product').on(table.productCode),
    index('idx_inv_scrap_items_batch').on(table.batchNo),
    check('chk_inv_scrap_items_quantity', sql`${table.quantity} > 0`),
  ],
)

// ──────────────────────────────────────────────────────────────────────
// 类型导出
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// 门店库存域 v2（2026-07-24 会议改造）
// ──────────────────────────────────────────────────────────────────────

/**
 * 门店库存表：库存模块的中心事实表。
 *
 * 所有填报单据都必须从本表的一行库存出发，或先由 SKU 初始化/入库生成库存行。
 * 明细表只记录本次操作快照，当前余额以本表为准；store_inventory_movements 保存可审计流水。
 */
export const storeInventoryStocks = pgTable(
  'store_inventory_stocks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    skuId: text('sku_id')
      .notNull()
      .references(() => productSkus.skuId),
    skuName: text('sku_name').notNull(),
    productType: productTypeEnum('product_type').notNull().default('家居产品'),
    batchNo: text('batch_no').notNull().default(''),
    expiryDate: date('expiry_date'),
    /** NULL 无法参与唯一约束等值，应用层用空串归一化唯一键。 */
    expiryDateKey: text('expiry_date_key').notNull().default(''),
    quantityOnHand: numeric('quantity_on_hand', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    lastUnitPrice: numeric('last_unit_price', { precision: 12, scale: 2 }),
    lastAmount: numeric('last_amount', { precision: 12, scale: 2 }),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_store_inventory_stock').on(
      table.storeId,
      table.skuId,
      table.batchNo,
      table.expiryDateKey,
    ),
    index('idx_store_inventory_stock_store').on(table.storeId),
    index('idx_store_inventory_stock_sku').on(table.skuId),
    check('chk_store_inventory_stock_qty', sql`${table.quantityOnHand} >= 0`),
  ],
)

export const storeInventoryDocs = pgTable(
  'store_inventory_docs',
  {
    id: text('id').primaryKey(),
    docType: storeInventoryDocTypeEnum('doc_type').notNull(),
    status: storeInventoryDocStatusEnum('status').notNull().default('草稿'),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    counterpartStoreId: text('counterpart_store_id').references(() => stores.storeId),
    docDate: date('doc_date').notNull(),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    requestDocId: text('request_doc_id').references((): any => storeInventoryDocs.id),
    relatedSaleOrderId: varchar('related_sale_order_id', { length: 30 }).references(
      () => saleOrders.saleOrderId,
    ),
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    customerName: varchar('customer_name', { length: 50 }),
    receiptAttachmentUrl: text('receipt_attachment_url'),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    approvedBy: varchar('approved_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: varchar('rejected_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    auditRemark: text('audit_remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_store_inventory_docs_store_date').on(table.storeId, table.docDate),
    index('idx_store_inventory_docs_type').on(table.docType),
    index('idx_store_inventory_docs_status').on(table.status),
    index('idx_store_inventory_docs_request').on(table.requestDocId),
    index('idx_store_inventory_docs_sale_order').on(table.relatedSaleOrderId),
    index('idx_store_inventory_docs_client').on(table.clientUserId),
    check(
      'chk_store_inventory_docs_transfer_store',
      sql`${table.counterpartStoreId} IS NULL OR ${table.storeId} <> ${table.counterpartStoreId}`,
    ),
  ],
)

export const storeInventoryDocItems = pgTable(
  'store_inventory_doc_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    docId: text('doc_id')
      .notNull()
      .references(() => storeInventoryDocs.id, { onDelete: 'cascade' }),
    stockId: bigint('stock_id', { mode: 'number' }).references(
      () => storeInventoryStocks.id,
    ),
    skuId: text('sku_id')
      .notNull()
      .references(() => productSkus.skuId),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(
      () => saleItems.saleItemId,
    ),
    skuName: text('sku_name').notNull(),
    batchNo: text('batch_no').notNull().default(''),
    expiryDate: date('expiry_date'),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    stockSnapshot: numeric('stock_snapshot', { precision: 12, scale: 2 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    requestQuantity: numeric('request_quantity', { precision: 12, scale: 2 }),
    fulfilledQuantity: numeric('fulfilled_quantity', { precision: 12, scale: 2 }),
    scrapReason: text('scrap_reason'),
    itemUsage: text('item_usage'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_store_inventory_doc_items_doc').on(table.docId),
    index('idx_store_inventory_doc_items_stock').on(table.stockId),
    index('idx_store_inventory_doc_items_sku').on(table.skuId),
    index('idx_store_inventory_doc_items_sale_item').on(table.saleItemId),
    check('chk_store_inventory_doc_items_qty', sql`${table.quantity} > 0`),
  ],
)

export const storeInventoryMovements = pgTable(
  'store_inventory_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    movementKey: text('movement_key').notNull(),
    stockId: bigint('stock_id', { mode: 'number' })
      .notNull()
      .references(() => storeInventoryStocks.id),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    skuId: text('sku_id')
      .notNull()
      .references(() => productSkus.skuId),
    docId: text('doc_id').references(() => storeInventoryDocs.id),
    docItemId: bigint('doc_item_id', { mode: 'number' }).references(
      () => storeInventoryDocItems.id,
    ),
    saleOrderId: varchar('sale_order_id', { length: 30 }).references(
      () => saleOrders.saleOrderId,
    ),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(
      () => saleItems.saleItemId,
    ),
    direction: storeInventoryMovementDirectionEnum('direction').notNull(),
    quantityDelta: numeric('quantity_delta', { precision: 12, scale: 2 }).notNull(),
    quantityBefore: numeric('quantity_before', { precision: 12, scale: 2 }).notNull(),
    quantityAfter: numeric('quantity_after', { precision: 12, scale: 2 }).notNull(),
    createdBy: varchar('created_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_store_inventory_movement_key').on(table.movementKey),
    index('idx_store_inventory_movements_stock').on(table.stockId),
    index('idx_store_inventory_movements_store_created').on(
      table.storeId,
      table.createdAt,
    ),
    index('idx_store_inventory_movements_doc').on(table.docId),
    index('idx_store_inventory_movements_sale_item').on(table.saleItemId),
    check('chk_store_inventory_movement_delta', sql`${table.quantityDelta} <> 0`),
    check('chk_store_inventory_movement_after', sql`${table.quantityAfter} >= 0`),
  ],
)

export type StoreInventoryStock = typeof storeInventoryStocks.$inferSelect
export type NewStoreInventoryStock = typeof storeInventoryStocks.$inferInsert
export type StoreInventoryDoc = typeof storeInventoryDocs.$inferSelect
export type NewStoreInventoryDoc = typeof storeInventoryDocs.$inferInsert
export type StoreInventoryDocItem = typeof storeInventoryDocItems.$inferSelect
export type NewStoreInventoryDocItem = typeof storeInventoryDocItems.$inferInsert
export type StoreInventoryMovement = typeof storeInventoryMovements.$inferSelect
export type NewStoreInventoryMovement = typeof storeInventoryMovements.$inferInsert

// ──────────────────────────────────────────────────────────────────────
// 进销存通用域 v3（总部 / 市场 / 门店）
// ──────────────────────────────────────────────────────────────────────

/**
 * 独立库存 SKU。
 *
 * 库存商品资料不复用销售侧 product_skus：WorkFine 的进销存价格体系包含
 * 供应链采购价、市场进货价、门店进货价、员工购买价、核算价等字段，语义不同于销售开单 SKU。
 */
export const inventorySkus = pgTable(
  'inventory_skus',
  {
    skuId: text('sku_id').primaryKey(),
    productCode: text('product_code').notNull(),
    productName: text('product_name').notNull(),
    specName: text('spec_name'),
    supplier: text('supplier'),
    manufacturer: text('manufacturer'),
    brand: text('brand'),
    productSeries: text('product_series'),
    purchaseCategory: text('purchase_category'),
    sourceType: text('source_type').notNull().default('供应链'),
    ownerMarketId: text('owner_market_id').references(() => orgNodes.id),
    retailPrice: numeric('retail_price', { precision: 12, scale: 2 }),
    accountingPrice: numeric('accounting_price', { precision: 12, scale: 2 }),
    supplyChainPurchasePrice: numeric('supply_chain_purchase_price', {
      precision: 12,
      scale: 2,
    }),
    marketPurchasePrice: numeric('market_purchase_price', {
      precision: 12,
      scale: 2,
    }),
    storePurchasePrice: numeric('store_purchase_price', {
      precision: 12,
      scale: 2,
    }),
    marketStaffPurchasePrice: numeric('market_staff_purchase_price', {
      precision: 12,
      scale: 2,
    }),
    marketPurchaseDiscount: numeric('market_purchase_discount', {
      precision: 8,
      scale: 4,
    }),
    storePurchaseDiscount: numeric('store_purchase_discount', {
      precision: 8,
      scale: 4,
    }),
    staffPurchaseDiscount: numeric('staff_purchase_discount', {
      precision: 8,
      scale: 4,
    }),
    itemCompanyPurchasePrice: numeric('item_company_purchase_price', {
      precision: 12,
      scale: 2,
    }),
    isReportable: boolean('is_reportable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_inventory_skus_product_code').on(table.productCode),
    index('idx_inventory_skus_name').on(table.productName),
    index('idx_inventory_skus_series').on(table.productSeries),
    index('idx_inventory_skus_source').on(table.sourceType),
    index('idx_inventory_skus_owner_market').on(table.ownerMarketId),
    check(
      'chk_inventory_skus_source_type',
      sql`${table.sourceType} IN ('供应链','市场自采','转让店')`,
    ),
    check(
      'chk_inventory_skus_prices_nonnegative',
      sql`COALESCE(${table.retailPrice}, 0) >= 0
       AND COALESCE(${table.accountingPrice}, 0) >= 0
       AND COALESCE(${table.supplyChainPurchasePrice}, 0) >= 0
       AND COALESCE(${table.marketPurchasePrice}, 0) >= 0
       AND COALESCE(${table.storePurchasePrice}, 0) >= 0
       AND COALESCE(${table.marketStaffPurchasePrice}, 0) >= 0
       AND COALESCE(${table.itemCompanyPurchasePrice}, 0) >= 0`,
    ),
  ],
)

/**
 * 库存主体：总部 / 市场 / 门店。
 *
 * location_id 使用组织树节点或门店主键，便于直接承接现有权限 scope：
 * - 总部、市场：org_nodes.id
 * - 门店：stores.store_id
 */
export const inventoryLocations = pgTable(
  'inventory_locations',
  {
    locationId: text('location_id').primaryKey(),
    locationType: text('location_type').notNull(),
    name: text('name').notNull(),
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    storeId: text('store_id').references(() => stores.storeId),
    parentLocationId: text('parent_location_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inventory_locations_type').on(table.locationType),
    index('idx_inventory_locations_org').on(table.orgNodeId),
    index('idx_inventory_locations_store').on(table.storeId),
    check(
      'chk_inventory_locations_type',
      sql`${table.locationType} IN ('总部','市场','门店')`,
    ),
  ],
)

export const inventoryPromotionPlans = pgTable(
  'inventory_promotion_plans',
  {
    id: text('id').primaryKey(),
    planNo: text('plan_no').notNull(),
    name: text('name').notNull(),
    startsAt: date('starts_at').notNull(),
    endsAt: date('ends_at').notNull(),
    scopeMarketId: text('scope_market_id').references(() => orgNodes.id),
    scopeStoreId: text('scope_store_id').references(() => stores.storeId),
    status: text('status').notNull().default('启用'),
    remark: text('remark'),
    createdBy: varchar('created_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_inventory_promotion_plan_no').on(table.planNo),
    index('idx_inventory_promotion_scope_market').on(table.scopeMarketId),
    index('idx_inventory_promotion_scope_store').on(table.scopeStoreId),
    check('chk_inventory_promotion_status', sql`${table.status} IN ('启用','停用')`),
    check('chk_inventory_promotion_date', sql`${table.endsAt} >= ${table.startsAt}`),
  ],
)

export const inventoryPromotionPlanItems = pgTable(
  'inventory_promotion_plan_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => inventoryPromotionPlans.id, { onDelete: 'cascade' }),
    skuId: text('sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    marketBasePrice: numeric('market_base_price', { precision: 12, scale: 2 }),
    marketUnitDiscount: numeric('market_unit_discount', { precision: 12, scale: 2 }),
    marketActualPrice: numeric('market_actual_price', { precision: 12, scale: 2 }),
    storeBasePrice: numeric('store_base_price', { precision: 12, scale: 2 }),
    storeUnitDiscount: numeric('store_unit_discount', { precision: 12, scale: 2 }),
    storeActualPrice: numeric('store_actual_price', { precision: 12, scale: 2 }),
    reportMinQuantity: numeric('report_min_quantity', { precision: 12, scale: 2 }),
    reportMaxQuantity: numeric('report_max_quantity', { precision: 12, scale: 2 }),
    isTiered: boolean('is_tiered').notNull().default(false),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inventory_promotion_items_plan').on(table.planId),
    index('idx_inventory_promotion_items_sku').on(table.skuId),
    check(
      'chk_inventory_promotion_qty_range',
      sql`${table.reportMaxQuantity} IS NULL
        OR ${table.reportMinQuantity} IS NULL
        OR ${table.reportMaxQuantity} >= ${table.reportMinQuantity}`,
    ),
  ],
)

/**
 * 供应链、市场自采共用的供应商档案。
 *
 * 业务单据保存供应商名称快照，同时通过 supplier_id 维持可追溯关联；
 * 历史 WorkFine 数据没有可靠主键时可只保留名称快照。
 */
export const inventorySuppliers = pgTable(
  'inventory_suppliers',
  {
    supplierId: text('supplier_id').primaryKey(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: varchar('phone', { length: 30 }),
    address: text('address'),
    isActive: boolean('is_active').notNull().default(true),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_inventory_suppliers_name').on(table.name),
    index('idx_inventory_suppliers_active').on(table.isActive),
  ],
)

/**
 * 批次库存余额表。
 *
 * lot_key 由应用层按 SKU、批号、效期、赠送标记和真实单价生成，用于同批不同价格分层管理。
 */
export const inventoryStockLots = pgTable(
  'inventory_stock_lots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    locationId: text('location_id')
      .notNull()
      .references(() => inventoryLocations.locationId),
    skuId: text('sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    lotKey: text('lot_key').notNull(),
    skuName: text('sku_name').notNull(),
    specName: text('spec_name'),
    supplier: text('supplier'),
    productSeries: text('product_series'),
    batchNo: text('batch_no').notNull().default(''),
    expiryDate: date('expiry_date'),
    expiryDateKey: text('expiry_date_key').notNull().default(''),
    isGift: boolean('is_gift').notNull().default(false),
    quantityOnHand: numeric('quantity_on_hand', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    supplyChainUnitCost: numeric('supply_chain_unit_cost', {
      precision: 12,
      scale: 2,
    }),
    marketStandardUnitPrice: numeric('market_standard_unit_price', {
      precision: 12,
      scale: 2,
    }),
    marketUnitDiscount: numeric('market_unit_discount', {
      precision: 12,
      scale: 2,
    }),
    marketActualUnitPrice: numeric('market_actual_unit_price', {
      precision: 12,
      scale: 2,
    }),
    storeStandardUnitPrice: numeric('store_standard_unit_price', {
      precision: 12,
      scale: 2,
    }),
    storeUnitDiscount: numeric('store_unit_discount', {
      precision: 12,
      scale: 2,
    }),
    storeActualUnitPrice: numeric('store_actual_unit_price', {
      precision: 12,
      scale: 2,
    }),
    sourceDocId: text('source_doc_id'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_inventory_stock_lot').on(table.locationId, table.lotKey),
    index('idx_inventory_stock_lots_location').on(table.locationId),
    index('idx_inventory_stock_lots_sku').on(table.skuId),
    index('idx_inventory_stock_lots_batch').on(table.batchNo),
    check('chk_inventory_stock_lots_qty', sql`${table.quantityOnHand} >= 0`),
  ],
)

export const inventoryDocs = pgTable(
  'inventory_docs',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    status: text('status').notNull().default('草稿'),
    sourceLocationId: text('source_location_id').references(
      () => inventoryLocations.locationId,
    ),
    targetLocationId: text('target_location_id').references(
      () => inventoryLocations.locationId,
    ),
    /** 业务所属市场；不以文本名称推导，确保跨层单据可以按市场隔离。 */
    marketId: text('market_id').references(() => orgNodes.id),
    supplierId: text('supplier_id').references(() => inventorySuppliers.supplierId),
    docDate: date('doc_date').notNull(),
    relatedDocId: text('related_doc_id'),
    requestDocId: text('request_doc_id'),
    relatedSaleOrderId: varchar('related_sale_order_id', { length: 30 }).references(
      () => saleOrders.saleOrderId,
    ),
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    customerName: varchar('customer_name', { length: 50 }),
    employeeId: varchar('employee_id', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    employeeName: text('employee_name'),
    supplierName: text('supplier_name'),
    /** 内部领用、非凤御市场出库等非组织主体的对象名称快照。 */
    externalPartyName: text('external_party_name'),
    logisticsCompany: text('logistics_company'),
    trackingNo: text('tracking_no'),
    receiptAttachmentUrl: text('receipt_attachment_url'),
    totalQuantity: numeric('total_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
    remark: text('remark'),
    auditRemark: text('audit_remark'),
    createdBy: varchar('created_by', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    confirmedBy: varchar('confirmed_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    approvedBy: varchar('approved_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: varchar('rejected_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    cancelledBy: varchar('cancelled_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inventory_docs_type').on(table.docType),
    index('idx_inventory_docs_status').on(table.status),
    index('idx_inventory_docs_date').on(table.docDate),
    index('idx_inventory_docs_source').on(table.sourceLocationId),
    index('idx_inventory_docs_target').on(table.targetLocationId),
    index('idx_inventory_docs_market').on(table.marketId),
    index('idx_inventory_docs_supplier').on(table.supplierId),
    index('idx_inventory_docs_related').on(table.relatedDocId),
    check(
      'chk_inventory_docs_status',
      sql`${table.status} IN ('草稿','待审批','待收货','已完成','已驳回','已取消')`,
    ),
    check(
      'chk_inventory_docs_location_pair',
      sql`${table.sourceLocationId} IS NULL
        OR ${table.targetLocationId} IS NULL
        OR ${table.sourceLocationId} <> ${table.targetLocationId}`,
    ),
  ],
)

export const inventoryDocItems = pgTable(
  'inventory_doc_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    docId: text('doc_id')
      .notNull()
      .references(() => inventoryDocs.id, { onDelete: 'cascade' }),
    lotId: bigint('lot_id', { mode: 'number' }).references(
      () => inventoryStockLots.id,
    ),
    skuId: text('sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    saleItemId: varchar('sale_item_id', { length: 30 }).references(
      () => saleItems.saleItemId,
    ),
    skuName: text('sku_name').notNull(),
    specName: text('spec_name'),
    supplier: text('supplier'),
    productSeries: text('product_series'),
    batchNo: text('batch_no').notNull().default(''),
    expiryDate: date('expiry_date'),
    isGift: boolean('is_gift').notNull().default(false),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    stockSnapshot: numeric('stock_snapshot', { precision: 12, scale: 2 }),
    requestQuantity: numeric('request_quantity', { precision: 12, scale: 2 }),
    fulfilledQuantity: numeric('fulfilled_quantity', { precision: 12, scale: 2 }),
    standardUnitPrice: numeric('standard_unit_price', { precision: 12, scale: 2 }),
    unitDiscount: numeric('unit_discount', { precision: 12, scale: 2 }),
    actualUnitPrice: numeric('actual_unit_price', { precision: 12, scale: 2 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    supplyChainUnitCost: numeric('supply_chain_unit_cost', {
      precision: 12,
      scale: 2,
    }),
    marketStandardUnitPrice: numeric('market_standard_unit_price', {
      precision: 12,
      scale: 2,
    }),
    marketUnitDiscount: numeric('market_unit_discount', {
      precision: 12,
      scale: 2,
    }),
    marketActualUnitPrice: numeric('market_actual_unit_price', {
      precision: 12,
      scale: 2,
    }),
    storeStandardUnitPrice: numeric('store_standard_unit_price', {
      precision: 12,
      scale: 2,
    }),
    storeUnitDiscount: numeric('store_unit_discount', {
      precision: 12,
      scale: 2,
    }),
    storeActualUnitPrice: numeric('store_actual_unit_price', {
      precision: 12,
      scale: 2,
    }),
    reason: text('reason'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inventory_doc_items_doc').on(table.docId),
    index('idx_inventory_doc_items_lot').on(table.lotId),
    index('idx_inventory_doc_items_sku').on(table.skuId),
    check('chk_inventory_doc_items_qty', sql`${table.quantity} > 0`),
  ],
)

/**
 * 单据之间的业务血缘。一个市场报货可汇总多个门店报货，一张采购单也可分批发货/收货；
 * 不再依赖 related_doc_id/request_doc_id 两个自由文本字段承载一对多关系。
 */
export const inventoryDocLinks = pgTable(
  'inventory_doc_links',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fromDocId: text('from_doc_id')
      .notNull()
      .references(() => inventoryDocs.id, { onDelete: 'cascade' }),
    toDocId: text('to_doc_id')
      .notNull()
      .references(() => inventoryDocs.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(),
    fromItemId: bigint('from_item_id', { mode: 'number' }).references(
      () => inventoryDocItems.id,
      { onDelete: 'cascade' },
    ),
    toItemId: bigint('to_item_id', { mode: 'number' }).references(
      () => inventoryDocItems.id,
      { onDelete: 'cascade' },
    ),
    quantity: numeric('quantity', { precision: 12, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inventory_doc_links_from').on(table.fromDocId),
    index('idx_inventory_doc_links_to').on(table.toDocId),
    index('idx_inventory_doc_links_from_item').on(table.fromItemId),
    index('idx_inventory_doc_links_to_item').on(table.toItemId),
    index('idx_inventory_doc_links_relation').on(table.relationType),
    check(
      'chk_inventory_doc_links_distinct_docs',
      sql`${table.fromDocId} <> ${table.toDocId}`,
    ),
    check(
      'chk_inventory_doc_links_quantity',
      sql`${table.quantity} IS NULL OR ${table.quantity} > 0`,
    ),
  ],
)

/**
 * 待审批退货等尚未出库的数量预占，以及需求到发货的履约记录。
 *
 * 可用库存 = 批次余额 - 状态为“已预留”的未履约数量，避免同一批次被并发重复占用。
 */
export const inventoryStockReservations = pgTable(
  'inventory_stock_reservations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestDocId: text('request_doc_id')
      .notNull()
      .references(() => inventoryDocs.id, { onDelete: 'cascade' }),
    requestItemId: bigint('request_item_id', { mode: 'number' })
      .notNull()
      .references(() => inventoryDocItems.id, { onDelete: 'cascade' }),
    lotId: bigint('lot_id', { mode: 'number' })
      .notNull()
      .references(() => inventoryStockLots.id),
    locationId: text('location_id')
      .notNull()
      .references(() => inventoryLocations.locationId),
    skuId: text('sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    fulfilledQuantity: numeric('fulfilled_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    releasedQuantity: numeric('released_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    status: text('status').notNull().default('已预留'),
    createdBy: varchar('created_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inventory_stock_reservations_lot').on(table.lotId),
    index('idx_inventory_stock_reservations_request').on(table.requestDocId, table.requestItemId),
    index('idx_inventory_stock_reservations_location_sku').on(table.locationId, table.skuId),
    index('idx_inventory_stock_reservations_status').on(table.status),
    check('chk_inventory_stock_reservations_quantity', sql`${table.quantity} > 0`),
    check(
      'chk_inventory_stock_reservations_progress',
      sql`${table.fulfilledQuantity} >= 0
        AND ${table.releasedQuantity} >= 0
        AND ${table.fulfilledQuantity} + ${table.releasedQuantity} <= ${table.quantity}`,
    ),
    check(
      'chk_inventory_stock_reservations_status',
      sql`${table.status} IN ('已预留','已完成','已释放')`,
    ),
  ],
)

/** WorkFine 期初迁移的幂等与追溯键；运行时业务不会读取旧系统。 */
export const inventoryImportRefs = pgTable(
  'inventory_import_refs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    legacyTable: text('legacy_table').notNull(),
    legacyRid: text('legacy_rid').notNull(),
    legacyObyid: text('legacy_obyid').notNull(),
    legacyDocNo: text('legacy_doc_no'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_inventory_import_refs_legacy').on(
      table.entityType,
      table.legacyTable,
      table.legacyRid,
      table.legacyObyid,
    ),
    index('idx_inventory_import_refs_entity').on(table.entityType, table.entityId),
    index('idx_inventory_import_refs_doc_no').on(table.legacyDocNo),
    check('chk_inventory_import_refs_complete_identity', sql`${table.legacyObyid} <> ''`),
  ],
)

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    movementKey: text('movement_key').notNull(),
    lotId: bigint('lot_id', { mode: 'number' })
      .notNull()
      .references(() => inventoryStockLots.id),
    locationId: text('location_id')
      .notNull()
      .references(() => inventoryLocations.locationId),
    skuId: text('sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    docId: text('doc_id').references(() => inventoryDocs.id),
    docItemId: bigint('doc_item_id', { mode: 'number' }).references(
      () => inventoryDocItems.id,
    ),
    direction: text('direction').notNull(),
    quantityDelta: numeric('quantity_delta', { precision: 12, scale: 2 }).notNull(),
    quantityBefore: numeric('quantity_before', { precision: 12, scale: 2 }).notNull(),
    quantityAfter: numeric('quantity_after', { precision: 12, scale: 2 }).notNull(),
    createdBy: varchar('created_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_inventory_movement_key').on(table.movementKey),
    index('idx_inventory_movements_lot').on(table.lotId),
    index('idx_inventory_movements_location_created').on(
      table.locationId,
      table.createdAt,
    ),
    index('idx_inventory_movements_doc').on(table.docId),
    check(
      'chk_inventory_movements_direction',
      sql`${table.direction} IN ('入库','出库','调整')`,
    ),
    check('chk_inventory_movements_delta', sql`${table.quantityDelta} <> 0`),
    check('chk_inventory_movements_after', sql`${table.quantityAfter} >= 0`),
  ],
)

export type InventorySku = typeof inventorySkus.$inferSelect
export type NewInventorySku = typeof inventorySkus.$inferInsert
export type InventoryLocation = typeof inventoryLocations.$inferSelect
export type NewInventoryLocation = typeof inventoryLocations.$inferInsert
export type InventoryPromotionPlan = typeof inventoryPromotionPlans.$inferSelect
export type NewInventoryPromotionPlan = typeof inventoryPromotionPlans.$inferInsert
export type InventoryPromotionPlanItem =
  typeof inventoryPromotionPlanItems.$inferSelect
export type NewInventoryPromotionPlanItem =
  typeof inventoryPromotionPlanItems.$inferInsert
export type InventorySupplier = typeof inventorySuppliers.$inferSelect
export type NewInventorySupplier = typeof inventorySuppliers.$inferInsert
export type InventoryStockLot = typeof inventoryStockLots.$inferSelect
export type NewInventoryStockLot = typeof inventoryStockLots.$inferInsert
export type InventoryDoc = typeof inventoryDocs.$inferSelect
export type NewInventoryDoc = typeof inventoryDocs.$inferInsert
export type InventoryDocItem = typeof inventoryDocItems.$inferSelect
export type NewInventoryDocItem = typeof inventoryDocItems.$inferInsert
export type InventoryDocLink = typeof inventoryDocLinks.$inferSelect
export type NewInventoryDocLink = typeof inventoryDocLinks.$inferInsert
export type InventoryStockReservation = typeof inventoryStockReservations.$inferSelect
export type NewInventoryStockReservation = typeof inventoryStockReservations.$inferInsert
export type InventoryImportRef = typeof inventoryImportRefs.$inferSelect
export type NewInventoryImportRef = typeof inventoryImportRefs.$inferInsert
export type InventoryMovement = typeof inventoryMovements.$inferSelect
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert
