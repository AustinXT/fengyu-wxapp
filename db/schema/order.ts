import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  allocationStatusEnum,
  documentTypeEnum,
  itemDirectionEnum,
  orderStatusEnum,
  paymentChangeTypeEnum,
  paymentFlowStatusEnum,
  paymentMethodEnum,
  paymentSourceEndEnum,
  productTypeEnum,
  saleOrderTypeEnum,
  salesCategoryEnum,
} from "./enums";
import { stores } from "./org";
import { productSkus } from "./product";
import { clientWechatUsers, staffWechatUsers } from "./user";


export const saleOrders = pgTable(
  "sale_orders",
  {
    saleOrderId: varchar("sale_order_id", { length: 30 }).primaryKey(),
    status: orderStatusEnum("status").notNull().default("待支付"),
    saleOrderType: saleOrderTypeEnum("sale_order_type").notNull().default("销售单"),
    
    documentType: documentTypeEnum("document_type"),
    
    refSaleOrderId: varchar("ref_sale_order_id", { length: 30 }).references((): any => saleOrders.saleOrderId),
    
    marketName: varchar("market_name", { length: 100 }).notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => stores.storeId),
    
    storeName: varchar("store_name", { length: 100 }),
    saleOrderDatetime: timestamp("sale_order_datetime", { withTimezone: true }).notNull(),
    clientUserId: text("client_user_id").references(() => clientWechatUsers.userId),
    clientPhone: varchar("client_phone", { length: 30 }),
    customerName: varchar("customer_name", { length: 50 }),
    
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    
    prepaidCardAmount: numeric("prepaid_card_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    
    payableAmount: numeric("payable_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    
    received: numeric("received", { precision: 10, scale: 2 }).notNull().default("0"),
    
    refundedAmount: numeric("refunded_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    
    firstPaymentAmount: numeric("first_payment_amount", { precision: 10, scale: 2 }),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    openedBy: varchar("opened_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    preferredEmployeeId: varchar("preferred_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    offlineConfirmedBy: varchar("offline_confirmed_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    offlineConfirmedAt: timestamp("offline_confirmed_at", { withTimezone: true }),
    
    lakalaOutOrderNo: text("lakala_out_order_no"),
    allocationStatus: allocationStatusEnum("allocation_status"),
    
    couponId: text("coupon_id"),
    
    couponDiscount: numeric("coupon_discount", { precision: 10, scale: 2 }).default("0"),
    
    remark: text("remark"),
    
    isActivity: boolean("is_activity").notNull().default(false),
    
    isMembershipUpgrade: boolean("is_membership_upgrade").notNull().default(false),
    
    legacySource: text("legacy_source"),
    
    legacyCustomerId: text("legacy_customer_id"),
    
    legacyRawSnapshot: jsonb("legacy_raw_snapshot"),
    
    auditedAt: timestamp("audited_at", { withTimezone: true }),
    
    auditedBy: varchar("audited_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex("uq_sale_orders_client_pending")
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL AND opened_by IS NULL`),
    uniqueIndex("uq_sale_orders_phone_pending")
      .on(table.clientPhone, table.storeId)
      .where(sql`status = '待支付' AND client_user_id IS NULL`),
    index("idx_sale_orders_store_status").on(table.storeId, table.status),
    index("idx_sale_orders_ref").on(table.refSaleOrderId),
    index("idx_sale_orders_client_user_id")
      .on(table.clientUserId)
      .where(sql`client_user_id IS NOT NULL`),
    
    index("idx_legacy_source_phone")
      .on(table.legacySource, table.clientPhone)
      .where(sql`legacy_source IS NOT NULL`),
    
    index("idx_legacy_source_status")
      .on(table.legacySource, table.status)
      .where(sql`legacy_source IS NOT NULL`),
    
    check(
      "chk_first_payment_amount",
      sql`${table.firstPaymentAmount} IS NULL OR (${table.firstPaymentAmount} > 0 AND ${table.firstPaymentAmount} <= ${table.payableAmount})`,
    ),
  ],
);


export const saleItems = pgTable(
  "sale_items",
  {
    saleItemId: varchar("sale_item_id", { length: 30 }).primaryKey(),
    saleOrderId: varchar("sale_order_id", { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId),
    
    storeId: text("store_id")
      .notNull()
      .references(() => stores.storeId),
    itemDirection: itemDirectionEnum("item_direction").notNull().default("购买"),
    
    refSaleItemId: varchar("ref_sale_item_id", { length: 30 }).references((): any => saleItems.saleItemId),
    skuId: text("sku_id").references(() => productSkus.skuId),
    
    productName: text("product_name"),
    
    productType: productTypeEnum("product_type"),
    
    sessionCount: integer("session_count"),
    remainingSessions: integer("remaining_sessions"),
    
    paidSessions: integer("paid_sessions"),
    
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    
    quantity: integer("quantity").notNull().default(1),
    
    unitRealPrice: numeric("unit_real_price", { precision: 10, scale: 2 }).notNull(),
    
    saleAmount: numeric("sale_amount", { precision: 10, scale: 2 }).notNull(),
    
    received: numeric("received", { precision: 10, scale: 2 }).notNull(),
    
    pendingReceived: numeric("pending_received", { precision: 10, scale: 2 }).notNull().default("0"),
    expireDate: date("expire_date"),
    
    pickedUpQuantity: integer("picked_up_quantity").default(0),
    remark: text("remark"),
    salesCategory: salesCategoryEnum("sales_category"),
    
    serviceFee: numeric("service_fee", { precision: 10, scale: 2 }).notNull().default("0"),
    
    isShengmei: boolean("is_shengmei"),
    
    isExperience: boolean("is_experience").notNull().default(false),
    
    isManagerSpecial: boolean("is_manager_special").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index("idx_sale_items_order_id").on(table.saleOrderId),
    index("idx_sale_items_sku_id").on(table.skuId),
    index("idx_sale_items_ref").on(table.refSaleItemId),
    index("idx_sale_items_store_order").on(table.storeId, table.saleOrderId),
    check("chk_item_unit_price", sql`${table.unitPrice} >= 0`),
    check("chk_item_unit_real_price", sql`${table.unitRealPrice} >= 0`),
    check("chk_item_remaining", sql`${table.remainingSessions} IS NULL OR ${table.remainingSessions} >= 0`),
    check(
      "chk_item_paid_sessions",
      sql`${table.paidSessions} IS NULL OR (${table.paidSessions} >= 0 AND ${table.paidSessions} <= ${table.sessionCount})`,
    ),
    check("chk_item_quantity", sql`${table.quantity} > 0`),
    check("chk_item_service_fee", sql`${table.serviceFee} >= 0`),
  ],
);


export const saleAllocations = pgTable(
  "sale_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    saleItemId: varchar("sale_item_id", { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    employeeId: varchar("employee_id", { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    allocationRatio: numeric("allocation_ratio", { precision: 5, scale: 2 }).notNull(),
    
    roleType: varchar("role_type", { length: 20 }).notNull(),
    
    departmentName: varchar("department_name", { length: 100 }),
    
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    
    commissionRate: numeric("commission_rate", { precision: 5, scale: 4 }),
    
    commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }),
    
    salePaymentId: bigint("sale_payment_id", { mode: "number" }).references(() => saleOrderPayments.id),
    isVoid: boolean("is_void").notNull().default(false),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    
    uniqueIndex("uq_sale_alloc_item_emp_role_payment")
      .on(table.saleItemId, table.employeeId, table.roleType, table.salePaymentId)
      .where(sql`is_void = false`),
    index("idx_sale_alloc_employee_id").on(table.employeeId),
    index("idx_sale_alloc_payment").on(table.salePaymentId),
    check(
      "chk_sale_alloc_ratio",
      sql`${table.allocationRatio} IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00)`,
    ),
  ],
);


export const saleOrderPayments = pgTable(
  "sale_order_payments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    saleOrderId: varchar("sale_order_id", { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId, { onDelete: "restrict" }),
    changeType: paymentChangeTypeEnum("change_type").notNull(),
    
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    
    externalTxnId: text("external_txn_id"),
    
    externalTradeInfo: jsonb("external_trade_info"),
    status: paymentFlowStatusEnum("status").notNull(),
    sourceEnd: paymentSourceEndEnum("source_end").notNull(),
    
    operatorEmployeeId: varchar("operator_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    
    note: text("note"),
    
    refundReason: text("refund_reason"),
    
    refSaleItemId: varchar("ref_sale_item_id", { length: 30 }).references(() => saleItems.saleItemId),
    
    sessionCount: integer("session_count"),
    
    auditEmployeeId: varchar("audit_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    
    auditAt: timestamp("audit_at", { withTimezone: true }),
    
    auditRemark: text("audit_remark"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    
    paidAt: timestamp("paid_at", { withTimezone: true }),
    
    allocationStatus: allocationStatusEnum("allocation_status"),
  },
  (table) => [
    index("idx_sop_order").on(table.saleOrderId),
    
    index("idx_sop_alloc_status")
      .on(table.allocationStatus)
      .where(sql`allocation_status IS NOT NULL`),
    index("idx_sop_status_created").on(table.status, table.createdAt),
    
    uniqueIndex("uq_sop_txn")
      .on(table.saleOrderId, table.paymentMethod, table.externalTxnId)
      .where(sql`external_txn_id IS NOT NULL`),
    
    uniqueIndex("uq_sop_status_audit")
      .on(table.saleOrderId, table.changeType)
      .where(sql`change_type = '退款' AND status = '待审批'`),
    
    uniqueIndex("uq_sop_first_payment")
      .on(table.saleOrderId)
      .where(sql`change_type = '首次支付' AND status = '已支付'`),
    
    check(
      "chk_sop_amount_sign",
      sql`(${table.changeType} IN ('首次支付','回款','储值卡抵扣') AND ${table.amount} > 0)
          OR (${table.changeType} = '退款' AND ${table.amount} < 0)`,
    ),
    
    check(
      "chk_sop_method_txn",
      sql`${table.paymentMethod} NOT IN ('微信','支付宝') OR ${table.externalTxnId} IS NOT NULL`,
    ),
  ],
);


export const salePaymentAllocatableItems = pgTable(
  "sale_payment_allocatable_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    salePaymentId: bigint("sale_payment_id", { mode: "number" })
      .notNull()
      .references(() => saleOrderPayments.id),
    saleOrderId: varchar("sale_order_id", { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId),
    saleItemId: varchar("sale_item_id", { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    
    salesCategory: salesCategoryEnum("sales_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_spai_payment_item").on(table.salePaymentId, table.saleItemId),
    index("idx_spai_order").on(table.saleOrderId),
    
    
    
    index("idx_spai_order_item").on(table.saleOrderId, table.saleItemId),
  ],
);

export type SaleOrder = typeof saleOrders.$inferSelect;
export type NewSaleOrder = typeof saleOrders.$inferInsert;
export type SaleItem = typeof saleItems.$inferSelect;
export type NewSaleItem = typeof saleItems.$inferInsert;
export type SaleAllocation = typeof saleAllocations.$inferSelect;
export type NewSaleAllocation = typeof saleAllocations.$inferInsert;
export type SaleOrderPayment = typeof saleOrderPayments.$inferSelect;
export type NewSaleOrderPayment = typeof saleOrderPayments.$inferInsert;
export type SalePaymentAllocatableItem = typeof salePaymentAllocatableItems.$inferSelect;
export type NewSalePaymentAllocatableItem = typeof salePaymentAllocatableItems.$inferInsert;
