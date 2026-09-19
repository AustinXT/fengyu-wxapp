import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes, stores } from './org'
import { productSkus } from './product'
import { clientWechatUsers, staffWechatUsers } from './user'
import { saleItems, saleOrders } from './order'

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
    /**
     * 供应商名称，由 `supplier_id` 关联的档案派生写入。
     *
     * **是同步维护的冗余名，不是历史快照**：档案改名时 `updateInventorySupplier`
     * 会把所有关联 SKU 的本列一起改过来。真正的历史快照是
     * `inventory_doc_items.supplier` 与 `inventory_stock_lots.supplier`，它们在
     * 建单 / 建批次那一刻冻结、之后不再变。
     *
     * 保留本列的理由：`ensureLotFromSku` 建批次时取的就是它；存量里匹配不上档案的
     * 旧文本也靠它留存（`supplier_id` 为 NULL 时）。
     */
    supplier: text('supplier'),
    /** 供应商档案关联。存量文本按名称精确匹配回填，匹配不上的保留文本、本列为 NULL。 */
    supplierId: text('supplier_id').references(() => inventorySuppliers.supplierId),
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
    /** 供应链 SKU 的市场进货价来源；非供应链 SKU 不使用该字段。 */
    marketPurchasePriceMode: text('market_purchase_price_mode'),
    /** 手工覆盖公式价时必填，历史/接口操作同时写入操作日志。 */
    marketPurchasePriceOverrideReason: text('market_purchase_price_override_reason'),
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
    index('idx_inventory_skus_supplier').on(table.supplierId),
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
    check(
      'chk_inventory_skus_market_price_mode',
      sql`(
        ${table.sourceType} = '供应链'
        AND ${table.marketPurchasePriceMode} IN ('公式','手工覆盖')
      ) OR (
        ${table.sourceType} <> '供应链'
        AND ${table.marketPurchasePriceMode} IS NULL
        AND ${table.marketPurchasePriceOverrideReason} IS NULL
      )`,
    ),
    check(
      'chk_inventory_skus_market_price_override',
      sql`${table.marketPurchasePriceMode} <> '手工覆盖'
        OR (
          ${table.marketPurchasePrice} IS NOT NULL
          AND NULLIF(BTRIM(${table.marketPurchasePriceOverrideReason}), '') IS NOT NULL
        )`,
    ),
    check(
      'chk_inventory_skus_market_price_formula',
      sql`${table.marketPurchasePriceMode} <> '公式'
        OR (
          ${table.marketPurchasePriceOverrideReason} IS NULL
          AND (
            ${table.accountingPrice} IS NULL
            OR ${table.marketPurchaseDiscount} IS NULL
            OR ${table.marketPurchasePrice} = ROUND(
              ${table.accountingPrice} * CASE
                WHEN ${table.marketPurchaseDiscount} > 1
                  THEN ${table.marketPurchaseDiscount} / 100
                ELSE ${table.marketPurchaseDiscount}
              END,
              2
            )
          )
        )`,
    ),
  ],
)

/**
 * 销售 SKU 的库存组成明细。
 *
 * 销售目录与进销存目录使用不同 SKU 主数据：前者承载定价与服务语义，后者承载
 * 采购与库存核算语义。本表定义每 1 件家居产品销售 SKU 固定包含的库存 SKU
 * 及数量；提货时按组成整套扣减，不允许由操作人任选其一。
 */
export const inventorySkuProductSkuMappings = pgTable(
  'inventory_sku_product_sku_mappings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    productSkuId: text('product_sku_id')
      .notNull()
      .references(() => productSkus.skuId),
    inventorySkuId: text('inventory_sku_id')
      .notNull()
      .references(() => inventorySkus.skuId),
    /** 每提货 1 件销售 SKU 需要扣减的库存 SKU 数量。 */
    quantityPerSaleUnit: integer('quantity_per_sale_unit').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
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
    uniqueIndex('uq_inventory_product_sku_mapping').on(
      table.productSkuId,
      table.inventorySkuId,
    ),
    index('idx_inventory_product_sku_mappings_product').on(table.productSkuId),
    index('idx_inventory_product_sku_mappings_inventory').on(table.inventorySkuId),
    index('idx_inventory_product_sku_mappings_active')
      .on(table.productSkuId)
      .where(sql`${table.isActive} = true`),
    check(
      'chk_inventory_product_sku_mapping_quantity',
      sql`${table.quantityPerSaleUnit} > 0`,
    ),
  ],
)

/**
 * 库存主体：总部 / 市场 / 门店。
 *
 * 库存余额仍以 location_id 作为内部主键；org_node_id 是单据、权限和页面接口
 * 使用的统一组织节点标识。总部、市场、门店库存主体必须一一对应组织节点。
 */
export const inventoryLocations = pgTable(
  'inventory_locations',
  {
    locationId: text('location_id').primaryKey(),
    locationType: text('location_type').notNull(),
    name: text('name').notNull(),
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    storeId: text('store_id').references(() => stores.storeId),
    parentLocationId: text('parent_location_id').references(
      (): any => inventoryLocations.locationId,
    ),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_inventory_locations_type').on(table.locationType),
    uniqueIndex('uq_inventory_locations_org').on(table.orgNodeId),
    index('idx_inventory_locations_store').on(table.storeId),
    check(
      'chk_inventory_locations_type',
      sql`${table.locationType} IN ('总部','市场','门店')`,
    ),
    check(
      'chk_inventory_locations_parent_not_self',
      sql`${table.parentLocationId} IS NULL OR ${table.parentLocationId} <> ${table.locationId}`,
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
    /** 单品阶梯按单 SKU 取价；组合规则要求同一张市场报货同时满足全部产品条件。 */
    ruleType: text('rule_type').notNull().default('单品阶梯'),
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
    index('idx_inventory_promotion_rule_type').on(table.ruleType),
    check('chk_inventory_promotion_rule_type', sql`${table.ruleType} IN ('单品阶梯','组合')`),
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
 * lot_key 由应用层按 SKU、批号、效期、赠送标记、真实单价、供应商和来源单据生成，
 * 用于同批不同价格或供应来源的分层管理。
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
    supplierId: text('supplier_id').references(() => inventorySuppliers.supplierId),
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
    sourceDocId: text('source_doc_id').references((): any => inventoryDocs.id),
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
    index('idx_inventory_stock_lots_supplier').on(table.supplierId),
    index('idx_inventory_stock_lots_source_doc').on(table.sourceDocId),
    check('chk_inventory_stock_lots_qty', sql`${table.quantityOnHand} >= 0`),
  ],
)

export const inventoryDocs = pgTable(
  'inventory_docs',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    status: text('status').notNull().default('草稿'),
    /** 实际发起/出库组织节点；外部供应商或顾客侧不写入此字段。 */
    sourceOrgNodeId: text('source_org_node_id').references(
      () => inventoryLocations.orgNodeId,
    ),
    /** 实际接收/入库组织节点；外部供应商或顾客侧不写入此字段。 */
    targetOrgNodeId: text('target_org_node_id').references(
      () => inventoryLocations.orgNodeId,
    ),
    /** 业务所属市场；不以文本名称推导，确保跨层单据可以按市场隔离。 */
    marketId: text('market_id').references(() => orgNodes.id),
    supplierId: text('supplier_id').references(() => inventorySuppliers.supplierId),
    docDate: date('doc_date').notNull(),
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
    /** 市场财务提交的品项公司发货撤回申请；审批后保留作为审计记录。 */
    cancellationRequestReason: text('cancellation_request_reason'),
    cancellationRequestedBy: varchar('cancellation_requested_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
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
    index('idx_inventory_docs_source_org_node').on(table.sourceOrgNodeId),
    index('idx_inventory_docs_target_org_node').on(table.targetOrgNodeId),
    index('idx_inventory_docs_market').on(table.marketId),
    index('idx_inventory_docs_supplier').on(table.supplierId),
    check(
      'chk_inventory_docs_status',
      sql`${table.status} IN ('草稿','待审批','待收货','已完成','已驳回','已取消')`,
    ),
    check(
      'chk_inventory_docs_type',
      sql`${table.docType} IN (
        '门店报货','市场报货','市场报货汇总','品项公司报货需求','采购订单',
        '供应链采购入库','品项公司发货','市场采购入库','自采产品入库','分院配货',
        '院入库','分院调货出库','分院调货入库','市场间调货出库','市场间调货入库',
        '员工购出库','供应链员工购出库','内部领用','非凤御市场出库','市场退货','市场退货入库',
        '供应链退货入库','院退货','院顾客产品出库','院顾客退货','市场产品报损',
        '院产品报损','市场产品盘溢','市场库存盘点','分院库存盘点','库存转换出库',
        '库存转换入库','期初库存'
      )`,
    ),
    check(
      'chk_inventory_docs_org_endpoint',
      sql`${table.sourceOrgNodeId} IS NOT NULL OR ${table.targetOrgNodeId} IS NOT NULL`,
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
    /**
     * 行级供应商档案关联。
     *
     * 采购订单一次汇总多张报货单后，一张单里的商品可能分属不同供应商，单头的
     * `inventory_docs.supplier_id` 不再够用（#194）。建单时由 `inventory_skus.supplier_id`
     * 带出，与上面的 `supplier` 名称快照并存：本列是关联、`supplier` 是冻结的历史名。
     */
    supplierId: text('supplier_id').references(() => inventorySuppliers.supplierId),
    /**
     * 行级市场归属。NULL = 品项公司自用行（走供应链采购入库），非 NULL = 市场行（走品项公司发货）。
     *
     * 采购订单收敛成单一 doc_type 后，下游链路分流不再看单据类型而是看本列（#194）。
     */
    marketId: text('market_id').references(() => orgNodes.id),
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
    /** 市场报货命中的福利方案；方案删除时仅清 FK，以下快照继续保留历史语义。 */
    promotionPlanId: text('promotion_plan_id').references(
      () => inventoryPromotionPlans.id,
      { onDelete: 'set null' },
    ),
    promotionPlanNoSnapshot: text('promotion_plan_no_snapshot'),
    promotionPlanNameSnapshot: text('promotion_plan_name_snapshot'),
    promotionRuleTypeSnapshot: text('promotion_rule_type_snapshot'),
    promotionSelectionMode: text('promotion_selection_mode'),
    reason: text('reason'),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_inventory_doc_items_doc').on(table.docId),
    index('idx_inventory_doc_items_lot').on(table.lotId),
    index('idx_inventory_doc_items_sku').on(table.skuId),
    index('idx_inventory_doc_items_supplier').on(table.supplierId),
    index('idx_inventory_doc_items_market').on(table.marketId),
    index('idx_inventory_doc_items_promotion').on(table.promotionPlanId),
    uniqueIndex('uq_inventory_doc_items_id_doc').on(table.id, table.docId),
    check('chk_inventory_doc_items_qty', sql`${table.quantity} > 0`),
    check(
      'chk_inventory_doc_items_promotion_rule_type',
      sql`${table.promotionRuleTypeSnapshot} IS NULL OR ${table.promotionRuleTypeSnapshot} IN ('单品阶梯','组合')`,
    ),
    check(
      'chk_inventory_doc_items_promotion_selection_mode',
      sql`${table.promotionSelectionMode} IS NULL OR ${table.promotionSelectionMode} IN ('系统推荐','人工选择')`,
    ),
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
    foreignKey({
      name: 'inventory_doc_links_from_item_doc_fk',
      columns: [table.fromItemId, table.fromDocId],
      foreignColumns: [inventoryDocItems.id, inventoryDocItems.docId],
    }),
    foreignKey({
      name: 'inventory_doc_links_to_item_doc_fk',
      columns: [table.toItemId, table.toDocId],
      foreignColumns: [inventoryDocItems.id, inventoryDocItems.docId],
    }),
    check(
      'chk_inventory_doc_links_distinct_docs',
      sql`${table.fromDocId} <> ${table.toDocId}`,
    ),
    check(
      'chk_inventory_doc_links_quantity',
      sql`${table.quantity} IS NULL OR ${table.quantity} > 0`,
    ),
    check(
      'chk_inventory_doc_links_item_pair',
      sql`(${table.fromItemId} IS NULL) = (${table.toItemId} IS NULL)`,
    ),
    check(
      'chk_inventory_doc_links_quantity_shape',
      sql`(${table.fromItemId} IS NULL AND ${table.quantity} IS NULL)
        OR (${table.fromItemId} IS NOT NULL AND ${table.quantity} IS NOT NULL)`,
    ),
    check(
      'chk_inventory_doc_links_relation_type',
      sql`${table.relationType} IN (
        '门店报货汇总','市场报货汇总','市场报货采购订单','报货汇总采购订单','品项公司报货采购订单',
        '采购订单发货','采购订单赠送发货','发货收货','采购订单供应链采购入库',
        '门店报货配货','门店报货赠送配货','退货回库','库存转换','历史关联'
      )`,
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
/**
 * 一次性库存切流的持久化门禁。
 *
 * WorkFine 期初必须先导入、再核验，全部通过后才能开放常规库存业务写入。
 * 以 cutoverKey 预留未来其他库存来源的切流，不与 WorkFine 运行时耦合。
 */
export const inventoryCutoverStates = pgTable(
  'inventory_cutover_states',
  {
    cutoverKey: text('cutover_key').primaryKey(),
    status: text('status').notNull().default('待初始化'),
    asOfDate: date('as_of_date'),
    sourceRowCount: integer('source_row_count'),
    sourceQuantity: numeric('source_quantity', { precision: 14, scale: 2 }),
    importedDocCount: integer('imported_doc_count'),
    importedItemCount: integer('imported_item_count'),
    initializedBy: varchar('initialized_by', { length: 30 }).references(
      () => staffWechatUsers.employeeId,
    ),
    initializedAt: timestamp('initialized_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    check(
      'chk_inventory_cutover_states_status',
      sql`${table.status} IN ('待初始化','待核验','已初始化')`,
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
    foreignKey({
      name: 'inventory_movements_doc_item_doc_fk',
      columns: [table.docItemId, table.docId],
      foreignColumns: [inventoryDocItems.id, inventoryDocItems.docId],
    }),
    check(
      'chk_inventory_movements_direction',
      sql`${table.direction} IN ('入库','出库','调整')`,
    ),
    check('chk_inventory_movements_delta', sql`${table.quantityDelta} <> 0`),
    check(
      'chk_inventory_movements_direction_delta',
      sql`(${table.direction} = '入库' AND ${table.quantityDelta} > 0)
        OR (${table.direction} = '出库' AND ${table.quantityDelta} < 0)
        OR (${table.direction} = '调整' AND ${table.quantityDelta} <> 0)`,
    ),
    check(
      'chk_inventory_movements_balance',
      sql`${table.quantityAfter} = ${table.quantityBefore} + ${table.quantityDelta}`,
    ),
    check(
      'chk_inventory_movements_doc_item_pair',
      sql`(${table.docItemId} IS NULL) = (${table.docId} IS NULL)`,
    ),
    check('chk_inventory_movements_after', sql`${table.quantityAfter} >= 0`),
  ],
)

export type InventorySku = typeof inventorySkus.$inferSelect
export type NewInventorySku = typeof inventorySkus.$inferInsert
export type InventorySkuProductSkuMapping = typeof inventorySkuProductSkuMappings.$inferSelect
export type NewInventorySkuProductSkuMapping = typeof inventorySkuProductSkuMappings.$inferInsert
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
export type InventoryCutoverState = typeof inventoryCutoverStates.$inferSelect
export type NewInventoryCutoverState = typeof inventoryCutoverStates.$inferInsert
export type InventoryMovement = typeof inventoryMovements.$inferSelect
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert
