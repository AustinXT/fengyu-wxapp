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

/**
 * 订单主表（四种单据统一模型）
 *
 * sale_orders + sale_items + sale_allocations 覆盖销售单、回款单、转换单、退款单，
 * 通过 sale_order_type 区分。回款/转换/退款通过 ref_sale_order_id 引用原销售单。
 */
export const saleOrders = pgTable(
  "sale_orders",
  {
    saleOrderId: varchar("sale_order_id", { length: 30 }).primaryKey(),
    status: orderStatusEnum("status").notNull().default("待支付"),
    saleOrderType: saleOrderTypeEnum("sale_order_type").notNull().default("销售单"),
    /** 销售单据类型：售前（非会员客）/ 售后（会员客 or 金额达标） */
    documentType: documentTypeEnum("document_type"),
    /** 回款/退款引用的原销售单，销售单为 null */
    refSaleOrderId: varchar("ref_sale_order_id", { length: 30 }).references((): any => saleOrders.saleOrderId),
    /** 所属市场（快照） */
    marketName: varchar("market_name", { length: 100 }).notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => stores.storeId),
    saleOrderDatetime: timestamp("sale_order_datetime").notNull(),
    clientUserId: text("client_user_id").references(() => clientWechatUsers.userId),
    clientPhone: varchar("client_phone", { length: 30 }),
    customerName: varchar("customer_name", { length: 50 }),
    /** 订单总金额；退款为负数，转换=补差价，回款=本次回款金额 */
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    /** 储值卡抵扣金额（抵扣项，不计入实付） */
    prepaidCardAmount: numeric("prepaid_card_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    /** 应付实金金额 = total_amount - prepaid_card_amount；创建订单时计算并冻结，作为冗余列便于前端/报表筛选 */
    payableAmount: numeric("payable_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    /**
     * 实收金额（走 payment_method 指定通道）；received = 0 ⇔ payment_method = '无'。
     * 本字段是 sale_order_payments 表中 change_type ∈ (首次支付/回款/储值卡抵扣) 且 status='已支付' 行的 amount 之和的冗余快照，
     * 由应用层每次 payments 变更后同事务双写维护。
     *
     * 2026-04-26 sale-order-domain-refactor：
     *   - 原 paid_amount 列与 received 重复，已 DROP；统一改用 received
     *   - 原 wechat_transaction_id / alipay_transaction_id 列已 DROP，三方流水号下沉到 sale_order_payments.external_txn_id
     */
    received: numeric("received", { precision: 10, scale: 2 }).notNull().default("0"),
    /**
     * 已退款金额（聚合 sale_order_payments[change_type='退款',status='已支付'].amount 取负值）。
     * 由应用层每次退款审批通过后同事务双写维护。
     */
    refundedAmount: numeric("refunded_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    openedBy: varchar("opened_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    preferredEmployeeId: varchar("preferred_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    paidAt: timestamp("paid_at"),
    offlineConfirmedBy: varchar("offline_confirmed_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    offlineConfirmedAt: timestamp("offline_confirmed_at"),
    allocationStatus: allocationStatusEnum("allocation_status"),
    /** 使用的券实例ID（关系由 user_coupons.used_sale_order_id 维护，不设反向 FK 避免循环引用） */
    couponId: text("coupon_id"),
    /** 券抵扣总金额 */
    couponDiscount: numeric("coupon_discount", { precision: 10, scale: 2 }).default("0"),
    /** 订单备注（员工端开单时填写） */
    remark: text("remark"),
    // —— 退款专用字段（sale_order_type='退款' 时使用）——
    /** 退款原因 */
    refundReason: text("refund_reason"),
    /** 手续费/折算扣费 */
    handlingFee: numeric("handling_fee", { precision: 10, scale: 2 }),
    /** 审批人（店长） */
    approvedBy: varchar("approved_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    /** 审批时间 */
    approvedAt: timestamp("approved_at"),
    /** 驳回原因（审批不通过时填写） */
    rejectedReason: text("rejected_reason"),
    /** 退款单专用：因会员等级跌档扣除的超额权益价值（元） */
    overdraftDeduction: numeric("overdraft_deduction", { precision: 10, scale: 2 }).default("0"),
    /** 退款单专用：超额权益扣除明细，审计用 */
    overdraftDeductionDetail: jsonb("overdraft_deduction_detail"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_sale_orders_client_pending")
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL`),
    uniqueIndex("uq_sale_orders_phone_pending")
      .on(table.clientPhone, table.storeId)
      .where(sql`status = '待支付' AND client_user_id IS NULL`),
    index("idx_sale_orders_store_status").on(table.storeId, table.status),
    index("idx_sale_orders_ref").on(table.refSaleOrderId),
  ],
);

/**
 * 销售明细
 *
 * 同时用于销售、回款、转换、退款四种单据的明细行。
 * item_direction 标识行的方向语义。
 * 疗程卡并发扣减须使用原子 UPDATE remaining_sessions。
 */
export const saleItems = pgTable(
  "sale_items",
  {
    saleItemId: varchar("sale_item_id", { length: 30 }).primaryKey(),
    saleOrderId: varchar("sale_order_id", { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId),
    /**
     * 所属门店（销售时快照，回款/转换/退款继承原销售行）。
     * 用于强制"一张卡只能在购买门店核销/提货"的业务规则，
     * 与 sale_orders.store_id 始终一致；冗余字段以避免核销/提货热路径
     * 在事务内 JOIN sale_orders。
     */
    storeId: text("store_id")
      .notNull()
      .references(() => stores.storeId),
    itemDirection: itemDirectionEnum("item_direction").notNull().default("购买"),
    /** convert_out/refund_out 引用原购买行，其他为 null */
    refSaleItemId: varchar("ref_sale_item_id", { length: 30 }).references((): any => saleItems.saleItemId),
    skuId: text("sku_id").references(() => productSkus.skuId),
    /** 商品名称快照（开单时持久化，防止商品改名后历史订单显示错误） */
    productName: text("product_name"),
    /** 规格名称快照 */
    skuSpecName: text("sku_spec_name"),
    /** 商品类型快照（疗程卡/单品/家居产品） */
    productType: productTypeEnum("product_type"),
    sessionCount: integer("session_count"),
    remainingSessions: integer("remaining_sessions"),
    /** 原价快照（开单时持久化） */
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** 优惠后单价金额 */
    unitRealPrice: numeric("unit_real_price", { precision: 10, scale: 2 }).notNull(),
    saleAmount: numeric("sale_amount", { precision: 10, scale: 2 }).notNull(),
    /** 实收金额（convert_out/refund_out 行为负数） */
    received: numeric("received", { precision: 10, scale: 2 }).notNull(),
    expireDate: date("expire_date"),
    /** 已提货数量（家居产品用，原子累加，可提 = quantity - picked_up_quantity） */
    pickedUpQuantity: integer("picked_up_quantity").default(0),
    remark: text("remark"),
    salesCategory: salesCategoryEnum("sales_category"),
    /** 固定手工费快照（开单时从 product_skus.service_fee × quantity 持久化，用于服务完成时计算固定手工费部分的服务提成） */
    serviceFee: numeric("service_fee", { precision: 10, scale: 2 }).notNull().default("0"),
    /** 生美标志快照（开单时从 product_skus.is_shengmei 拷贝，不随 sku 后续修改变动） */
    isShengmei: boolean("is_shengmei"),
    /**
     * 体验卡快照（开单时从 product_skus.is_experience 拷贝）。
     * 客户分类跃迁判定：order_non_trial_amount = SUM(received WHERE is_experience=false)，
     * order_trial_amount = SUM(received WHERE is_experience=true)。混合订单按非体验部分判跃迁。
     * 与 unit_price/unit_real_price 同属价格快照族，admin 后续修改 product_skus.is_experience 不影响历史订单。
     */
    isExperience: boolean("is_experience").notNull().default(false),
    /**
     * 充值卡快照（开单时从 product_skus.is_recharge_card 拷贝）。
     * payNotify 充值入账触发依据；跃迁规则中 is_recharge_card=true 计入"非体验金额"参与会员客判定（D1=A）。
     * 与 isExperience 互斥（product_skus 层有 CHECK 约束；sale_items 应用层校验严格独立 D4）。
     */
    isRechargeCard: boolean("is_recharge_card").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sale_items_order_id").on(table.saleOrderId),
    index("idx_sale_items_sku_id").on(table.skuId),
    index("idx_sale_items_ref").on(table.refSaleItemId),
    index("idx_sale_items_store_order").on(table.storeId, table.saleOrderId),
    check("chk_item_unit_price", sql`${table.unitPrice} >= 0`),
    check("chk_item_unit_real_price", sql`${table.unitRealPrice} >= 0`),
    check("chk_item_remaining", sql`${table.remainingSessions} IS NULL OR ${table.remainingSessions} >= 0`),
    check("chk_item_quantity", sql`${table.quantity} > 0`),
    check("chk_item_service_fee", sql`${table.serviceFee} >= 0`),
  ],
);

/**
 * 营业额分配
 *
 * 同时用于销售、回款、转换、退款四种单据的业绩分配。
 * 退款业绩 total_amount 为负数，转换/回款保持正数。
 */
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
    /** 员工角色类型（美容师/养生师/推广师） */
    roleType: varchar("role_type", { length: 20 }).notNull(),
    /** 部门名称快照（用于按部门分组展示） */
    departmentName: varchar("department_name", { length: 100 }),
    /** 该员工最终分配金额（退款为负数） */
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    isVoid: boolean("is_void").notNull().default(false),
    voidedAt: timestamp("voided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_sale_alloc_item_emp_role")
      .on(table.saleItemId, table.employeeId, table.roleType)
      .where(sql`is_void = false`),
    index("idx_sale_alloc_employee_id").on(table.employeeId),
  ],
);

/**
 * 订单款项流水（款项权威源）
 *
 * 承载首次支付、回款、退款、储值卡抵扣四类款项动作；sale_orders.received / refunded_amount /
 * prepaid_card_amount 为本表的冗余快照，由应用层同事务双写。
 *
 * 2026-04-26 sale-order-domain-refactor 重构：
 *   - operator_employee_id / note 下沉到 sale_order_payment_details（子表 1:1）
 *   - status 新增 '待审批' 值（退款审批流：发起 → 审批 → 已支付/已作废）
 *   - 新增 partial unique uq_sop_status_audit 防同一原单出现多笔 in-flight 退款审批
 *
 * 不变量（应用层保障，DB CHECK 覆盖符号/字段一致性）：
 *   sale_orders.received            = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
 *   sale_orders.refunded_amount     = -Σ(amount WHERE status='已支付' AND change_type='退款')
 *   sale_orders.prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
 */
export const saleOrderPayments = pgTable(
  "sale_order_payments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    saleOrderId: varchar("sale_order_id", { length: 30 })
      .notNull()
      .references(() => saleOrders.saleOrderId, { onDelete: "restrict" }),
    changeType: paymentChangeTypeEnum("change_type").notNull(),
    /** 资金方向 × 金额：正=流入商家，负=退还顾客（退款行为负） */
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /** 微信/支付宝三方交易号；线下/储值卡为 NULL */
    externalTxnId: text("external_txn_id"),
    status: paymentFlowStatusEnum("status").notNull(),
    sourceEnd: paymentSourceEndEnum("source_end").notNull(),
    /**
     * 2026-04-26 sale-order-domain-refactor：
     *   operator_employee_id / note 已下沉到 sale_order_payment_details 子表。
     *   migration 0019 已 DROP 这两列。
     */
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** status 翻 '已支付' 的时间；线下/储值卡与 created_at 一致 */
    paidAt: timestamp("paid_at"),
  },
  (table) => [
    index("idx_sop_order").on(table.saleOrderId),
    index("idx_sop_status_created").on(table.status, table.createdAt),
    /** 同订单同通道同三方流水号唯一：支付回调幂等键 */
    uniqueIndex("uq_sop_txn")
      .on(table.saleOrderId, table.paymentMethod, table.externalTxnId)
      .where(sql`external_txn_id IS NOT NULL`),
    /**
     * 同一原销售单只能有一笔 in-flight 退款审批（change_type='退款' AND status='待审批'）。
     * 防 TOCTOU：审批流并发提交时由 DB 兜底。
     */
    uniqueIndex("uq_sop_status_audit")
      .on(table.saleOrderId, table.changeType)
      .where(sql`change_type = '退款' AND status = '待审批'`),
    /** 符号一致性：首次支付/回款/储值卡抵扣正数，退款负数 */
    check(
      "chk_sop_amount_sign",
      sql`(${table.changeType} IN ('首次支付','回款','储值卡抵扣') AND ${table.amount} > 0)
          OR (${table.changeType} = '退款' AND ${table.amount} < 0)`,
    ),
    /**
     * 线上支付必须携带 external_txn_id。
     * 等价写法：NOT IN ('微信','支付宝') 代替枚举新值列举，避免 ADD VALUE 同事务引用问题
     */
    check(
      "chk_sop_method_txn",
      sql`${table.paymentMethod} NOT IN ('微信','支付宝') OR ${table.externalTxnId} IS NOT NULL`,
    ),
  ],
);

/**
 * 订单款项流水详情（子表，1:1 主表 sale_order_payments）
 *
 * 2026-04-26 sale-order-domain-refactor 新建。
 * 设计原则（用户原话）："saleOrder 只记录汇总的结果和状态" —— 所有付款细节下沉到本表，
 * 主表 sale_order_payments 仅留资金流水核心字段。
 *
 * payment_id 既是 PK 也是 FK。仅当 payment 行需要详情（操作人/备注/退款审批等）时才有子表行；
 * 实际几乎所有 payment 行都有 details 行。
 */
export const salePaymentDetails = pgTable(
  "sale_order_payment_details",
  {
    paymentId: bigint("payment_id", { mode: "number" })
      .primaryKey()
      .references(() => saleOrderPayments.id, { onDelete: "restrict" }),

    // ── 操作人 / 备注（从主表下沉）──
    operatorEmployeeId: varchar("operator_employee_id", { length: 32 }).references(
      () => staffWechatUsers.employeeId,
    ),
    note: text("note"),

    // ── 退款专属 ──
    /** 退款原因（发起人填） */
    refundReason: text("refund_reason"),
    /** 关联具体 sale_item（部分退款） */
    refSaleItemId: varchar("ref_sale_item_id", { length: 30 }).references(() => saleItems.saleItemId),
    /** 退疗程卡时的次数 */
    sessionCount: integer("session_count"),

    // ── 审批专属 ──
    /** 审批人 */
    auditEmployeeId: varchar("audit_employee_id", { length: 32 }).references(
      () => staffWechatUsers.employeeId,
    ),
    /** 审批时间 */
    auditAt: timestamp("audit_at"),
    /** 审批备注 / 拒绝原因 */
    auditRemark: text("audit_remark"),

    // ── 第三方回调原始 payload（拉卡拉对接后用） ──
    rawPayload: jsonb("raw_payload"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sopd_operator").on(table.operatorEmployeeId),
    index("idx_sopd_audit_employee").on(table.auditEmployeeId),
    index("idx_sopd_ref_sale_item").on(table.refSaleItemId),
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
export type SalePaymentDetail = typeof salePaymentDetails.$inferSelect;
export type NewSalePaymentDetail = typeof salePaymentDetails.$inferInsert;
