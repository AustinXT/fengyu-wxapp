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
  pgView,
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
 * sale_orders + sale_items + sale_order_payments 覆盖销售单、回款、转换、退款。
 * 营业额分配由 sale_payment_item_receipts / sale_payment_item_allocations 按款项行实收承载。
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
    /** 所属门店名称（快照，与 market_name 一致；门店改名后历史订单仍显示下单时名称） */
    storeName: varchar("store_name", { length: 100 }),
    saleOrderDatetime: timestamp("sale_order_datetime", { withTimezone: true }).notNull(),
    /**
     * 业绩归属日期（上海自然日）。仅首次业绩事件按本字段归集；后续回款/退款仍按各自 paid_at。
     * 原始订单时间 sale_order_datetime 始终保留真实业务事实，不因经营周期调整而改写。
     */
    performanceAttributionDate: date("performance_attribution_date")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`),
    /** 首次人工调整时间；非 NULL 即表示该订单的一次修改机会已使用。 */
    performanceAttributionAdjustedAt: timestamp("performance_attribution_adjusted_at", { withTimezone: true }),
    /** 首次人工调整人；员工删除后置空，完整审计仍由 operation_logs 保留。 */
    performanceAttributionAdjustedBy: varchar("performance_attribution_adjusted_by", { length: 30 })
      .references(() => staffWechatUsers.employeeId, { onDelete: "set null" }),
    clientUserId: text("client_user_id").references(() => clientWechatUsers.userId),
    clientPhone: varchar("client_phone", { length: 30 }),
    customerName: varchar("customer_name", { length: 50 }),
    /** 订单总金额；商品价格之和，扣除优惠券 */
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    /**
     * 已结算储值卡实付净额。
     * 权威来源：已支付的「储值卡抵扣」正向流水 + payment_method='储值卡' 的已支付退款负向流水。
     * 未实际扣卡的预选金额只写 pending_prepaid_card_amount，不得提前进入本字段。
     */
    prepaidCardAmount: numeric("prepaid_card_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    /** 尚未结算的储值卡预选/混合支付意向金额；结算后原子转入 prepaid_card_amount。 */
    pendingPrepaidCardAmount: numeric("pending_prepaid_card_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    /**
     * 订单约定现金应付额。
     * 销售/内部/转换单 = total_amount - prepaid_card_amount - pending_prepaid_card_amount；
     * 充值单仍为档位实付、寄存单仍为 0。
     */
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
    /**
     * 首次收款金额上限（分期/转换单部分支付场景使用，nullable）。
     *
     * 语义：admin 开单时若 paymentMethod ∈ {微信, 支付宝} 且实付 < 应付，
     * 把"本次 QR 应收金额"写入此字段。scan-pay 读取后传给 order.pay() 的 payAmount，
     * 让微信/支付宝 QR 只收首付额；payNotify 回调入账后清空此字段（=NULL）。
     *
     * 普通转换单在首次收款尚未确认时也使用该字段冻结本次应收上限；线上回调或线下确认后清空。
     *
     * 不变量：first_payment_amount IS NULL OR (0 < first_payment_amount <= payable_amount)
     */
    firstPaymentAmount: numeric("first_payment_amount", { precision: 10, scale: 2 }),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    openedBy: varchar("opened_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    preferredEmployeeId: varchar("preferred_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    offlineConfirmedBy: varchar("offline_confirmed_by", { length: 30 }).references(() => staffWechatUsers.employeeId),
    offlineConfirmedAt: timestamp("offline_confirmed_at", { withTimezone: true }),
    /**
     * 最近一次发起拉卡拉收银台支付时用的商户订单号（out_order_no，含时间戳后缀，与 sale_order_id 不同）。
     * 收银台「查询/关单」接口按此寻单：order.cancel 关单防迟到支付、order.queryLakalaStatus 轮询兜底。
     * 仅线上微信/支付宝走拉卡拉时写入；线下/储值卡为 NULL。
     */
    lakalaOutOrderNo: text("lakala_out_order_no"),
    allocationStatus: allocationStatusEnum("allocation_status"),
    /** 使用的券实例ID（关系由 user_coupons.used_sale_order_id 维护，不设反向 FK 避免循环引用） */
    couponId: text("coupon_id"),
    /** 券抵扣总金额 */
    couponDiscount: numeric("coupon_discount", { precision: 10, scale: 2 }).default("0"),
    /** 订单备注（员工端开单时填写） */
    remark: text("remark"),
    /** 活动单标记（纯标识，不影响金额/提成/营收口径；admin/staff 开单时勾选） */
    isActivity: boolean("is_activity").notNull().default(false),
    /** 体验转换标记；仅转换单可为 true，金额由系统按旧卡划卡价值强制定价 */
    isExperienceConversion: boolean("is_experience_conversion").notNull().default(false),
    /** 会员升级单标记（该订单触发顾客首次跃迁为会员客；由 recalcCustomerType 在首次跃迁时自动打标，非手动勾选） */
    isMembershipUpgrade: boolean("is_membership_upgrade").notNull().default(false),
    /**
     * 历史订单来源标记。NULL=系统原生订单；'workfine'=WorkFine 历史导入（默认 status='未审核'）。
     * 由 db/scripts/import-workfine-legacy.js 写入；admin /legacy-orders 页按此筛选。
     */
    legacySource: text("legacy_source"),
    /** WorkFine 顾客编号原值（核对辅助；与 client_user_id 并存） */
    legacyCustomerId: text("legacy_customer_id"),
    /** 抓取时的原始 4 字段快照 {legacy_order_no, phone, store_name, amount, sale_date, customer_id, customer_name} */
    legacyRawSnapshot: jsonb("legacy_raw_snapshot"),
    /** 历史订单核对通过时间 */
    auditedAt: timestamp("audited_at", { withTimezone: true }),
    /** 历史订单核对人 */
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
    index("idx_sale_orders_performance_date_store").on(table.performanceAttributionDate, table.storeId),
    index("idx_sale_orders_experience_conversion_audit")
      .on(table.storeId, table.saleOrderDatetime)
      .where(sql`is_experience_conversion = true`),
    index("idx_sale_orders_ref").on(table.refSaleOrderId),
    index("idx_sale_orders_client_user_id")
      .on(table.clientUserId)
      .where(sql`client_user_id IS NOT NULL`),
    /** 历史订单按手机号筛选热路径（admin /legacy-orders 主筛选） */
    index("idx_legacy_source_phone")
      .on(table.legacySource, table.clientPhone)
      .where(sql`legacy_source IS NOT NULL`),
    /** 历史订单按状态聚合（COUNT 未审核数） */
    index("idx_legacy_source_status")
      .on(table.legacySource, table.status)
      .where(sql`legacy_source IS NOT NULL`),
    /** first_payment_amount 不变量：NULL 或 0 < v <= payable_amount */
    check(
      "chk_first_payment_amount",
      sql`${table.firstPaymentAmount} IS NULL OR (${table.firstPaymentAmount} > 0 AND ${table.firstPaymentAmount} <= ${table.payableAmount})`,
    ),
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
    /**
     * 逻辑购买行分组号。寄存单将疗程卡/家居产品逐张逐件落库时，同一原始购买行
     * 的子明细共享该值；仅供展示聚合与批量操作展开，不参与金额或库存计算。
     * 不建外键：历史拆分后原聚合 sale_item 会被删除，分组号需继续保留其可追溯性。
     */
    saleItemGroupId: varchar("sale_item_group_id", { length: 30 }),
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
    /** 商品类型快照（疗程卡/家居产品） */
    productType: productTypeEnum("product_type"),
    /** 该行总次数（疗程卡：sku.session_count × quantity；非次数卡为 NULL）。是"行总次数"口径，已含 quantity。 */
    sessionCount: integer("session_count"),
    remainingSessions: integer("remaining_sessions"),
    /**
     * 已支付次数（按 (received - refunded_amount) / total_amount × session_count 取 floor）。
     * 其中 sale_orders.received 已含 '储值卡抵扣' change_type 流水（与三端 paid-sessions.js / admin paid-sessions.ts 跨端字节同义）。
     * 每次 sale_orders.received 变化（首次支付/回款/储值卡抵扣/退款/微信回调）后必须重算。
     * 业务不变量（应用层守护）：(session_count - remaining_sessions) <= paid_sessions。
     * NULL 表示非次数卡（单品/家居等 session_count 为 NULL 的行）。
     */
    paidSessions: integer("paid_sessions"),
    /**
     * 单次售价标价快照（per-session，开单时持久化）。
     * 疗程卡：= round(标价行总额 / session_count, 2)（标价行总额 = sku.price × quantity）；
     * 非次数卡：= round(标价行总额 / quantity, 2)（即 per-unit 原价）。
     * 取整张卡/整行标价请用 unit_price × session_count（卡）/ × quantity（非卡）。
     */
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    /** 该 sale_item 购买数量（卡张数 / 件数）。 */
    quantity: integer("quantity").notNull().default(1),
    /**
     * 单次优惠后价（per-session，"一次疗程的价"）。
     * 疗程卡：= round(sale_amount / session_count, 2)；非次数卡：= round(sale_amount / quantity, 2)。
     * 是"价"非"实收"（实收看 received）。提成 per_session 直接取此值；service_items.unit_real_price 是它的快照。
     */
    unitRealPrice: numeric("unit_real_price", { precision: 10, scale: 2 }).notNull(),
    /**
     * 该行应付金额（摊券后的权威行总额）。恒等式：疗程卡 sale_amount = unit_real_price × session_count；
     * 非卡 sale_amount = unit_real_price × quantity。unit_price/unit_real_price 均由 sale_amount 派生。
     */
    saleAmount: numeric("sale_amount", { precision: 10, scale: 2 }).notNull(),
    /**
     * 行级**净实收**（毛实收 − 该行被退；convert_out/refund_out 行为负数）。
     * 由 recalcPaidSessionsForOrder 两步重算：
     *   STEP 1「定向 + 两段式瀑布」从 sale_orders.received 摊**毛额**（无定向额先按 pending_received 铺满、
     *   溢出再按 sale_amount 余量铺开；pending=0 或 =sale_amount 时退化为旧比例）；
     *   STEP 1.5 按已支付退款流水 note.items[].refundAmount 逐项扣退款 → 转**净额**（2026-06-08 退款侧）。
     * 效果：被退项 received 单独减少、SUM(购买行 received)=净实收（统计方便）。
     * Σ(购买行) = sale_orders.received − Σ逐项退款（不再恒等毛额 received）。**不是行单价**（行价看 sale_amount）。
     */
    received: numeric("received", { precision: 10, scale: 2 }).notNull(),
    /**
     * 储值卡实付分摊。按本单所有 sale_items.received 的有符号净额比例分摊订单
     * prepaid_card_amount；最后一个非零实收项用减法吸收分币尾差。分母为 0 时全部置 0。
     */
    prepaidCardReceived: numeric("prepaid_card_received", { precision: 10, scale: 2 }).notNull().default("0"),
    /** 现金实付分摊，数据库生成列，恒等于 received - prepaid_card_received。 */
    cashReceived: numeric("cash_received", { precision: 10, scale: 2 })
      .generatedAlwaysAs(sql`received - prepaid_card_received`),
    /**
     * 逐行实付草稿（开单首付 UI 填的单次每项实付金额快照，行级）。
     * 作为 STEP 1 两段式瀑布的「第一段产能」权重：无定向额（首付/无 items 回款）优先按 pending_received
     * 分摊到各行 received（2026-06-08 组合套餐逐行实付累加），但**本身不增加 received 总额**——
     * 资金铁律不变：受款额只认 status='已支付' 流水（pending_received 仅作 STEP1 分摊权重，不进受款）。
     * 待支付订单：received=0、paid_sessions=0（不可消费），pending_received 保留约定值；
     * 同时供订单详情展示「约定实付」+ 确认收款时作 confirmAmount 预填/入账参考。
     */
    pendingReceived: numeric("pending_received", { precision: 10, scale: 2 }).notNull().default("0"),
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
     * 店长特别优惠快照（开单时从 product_skus.is_manager_special 拷贝）。
     * 标识该行应付金额是店长用「店长特别优惠」权限手动改的价（仅销售单 + 普通商品）。
     * 与价格快照族同属，admin 后续修改 product_skus.is_manager_special 不影响历史订单。仅供审计/详情标注。
     */
    isManagerSpecial: boolean("is_manager_special").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index("idx_sale_items_order_id").on(table.saleOrderId),
    index("idx_sale_items_group_id").on(table.saleItemGroupId),
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

/**
 * @deprecated 历史营业额分配表，仅作为旧数据迁移来源保留。
 *
 * 新运行时统一使用 sale_payment_item_receipts +
 * sale_payment_item_allocations；不要在新业务代码中读写本表。
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
    allocationRatio: numeric("allocation_ratio", { precision: 5, scale: 3 }).notNull(),
    /** 员工角色类型（美容师/养生师/推广师） */
    roleType: varchar("role_type", { length: 20 }).notNull(),
    /** 部门名称快照（用于按部门分组展示） */
    departmentName: varchar("department_name", { length: 100 }),
    /** 该员工最终分配金额 = 营业额份额（退款为负数；销售提成的计算基数） */
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    /**
     * 销售提成率快照（保存分配时从 commission_rate_matrix 按市场×角色×销售类别×金额档位固化，
     * 历史提成不随后续改费率而变化；与 service_commissions.commission_rate 同源同语义）。
     * NULL = 未回填的历史行 / 无匹配费率配置。
     */
    commissionRate: numeric("commission_rate", { precision: 5, scale: 4 }),
    /**
     * 真实销售提成额 = round(total_amount × commission_rate, 2)（退款为负数）。
     * 绩效页「销售提成」/ 数据看板「员工收入」销售部分读此列（落地 staff.pr.spec §3.15 双维度模型）。
     */
    commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }),
    /** 历史回款事件主流水行；新模型通过 sale_payment_item_receipts.sale_payment_id 关联。 */
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
    // 唯一性下沉到回款维度：一项一员工一角色一回款仅一条活跃分配（按回款逐笔分配）
    uniqueIndex("uq_sale_alloc_item_emp_role_payment")
      .on(table.saleItemId, table.employeeId, table.roleType, table.salePaymentId)
      .where(sql`is_void = false`),
    index("idx_sale_alloc_employee_id").on(table.employeeId),
    index("idx_sale_alloc_payment").on(table.salePaymentId),
    check(
      "chk_sale_alloc_ratio",
      sql`${table.allocationRatio} >= 0 AND ${table.allocationRatio} <= 1`,
    ),
  ],
);

/**
 * 订单款项流水（款项权威源）
 *
 * 承载首次支付、回款、退款、储值卡抵扣四类款项动作；sale_orders.received / refunded_amount /
 * prepaid_card_amount 为本表的冗余快照，由应用层同事务双写。
 *
 * 2026-05-03 子表 sale_order_payment_details 回收：操作人/备注/退款/审批字段全部并入主表，
 * 子表删除。raw_payload 字段同步移除（未使用）。详见 notes/tickets/。
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
    /** 微信/支付宝三方交易号；线下/储值卡为 NULL。拉卡拉场景=收银台 pay_order_no */
    externalTxnId: text("external_txn_id"),
    /**
     * 拉卡拉回调 order_trade_info 原始快照（acc_trade_no/log_no/trade_no/pay_mode 等）。
     * 退款（/v3/rfd/refund_front/refund）所需 origin_trade_no/origin_log_no 从此取，联调时按拉卡拉文档选定字段。
     * 仅拉卡拉线上支付回调写入；线下/储值卡为 NULL。
     */
    externalTradeInfo: jsonb("external_trade_info"),
    status: paymentFlowStatusEnum("status").notNull(),
    sourceEnd: paymentSourceEndEnum("source_end").notNull(),
    /** 操作人（开单/确认线下/抵扣/发起退款的员工） */
    operatorEmployeeId: varchar("operator_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    /** 备注 */
    note: text("note"),
    /** 退款原因（change_type='退款' 时由发起人填写） */
    refundReason: text("refund_reason"),
    /** 退款关联的具体 sale_item（部分退款时使用） */
    refSaleItemId: varchar("ref_sale_item_id", { length: 30 }).references(() => saleItems.saleItemId),
    /** 退疗程卡时的次数 */
    sessionCount: integer("session_count"),
    /** 审批人（退款审批流） */
    auditEmployeeId: varchar("audit_employee_id", { length: 30 }).references(() => staffWechatUsers.employeeId),
    /** 审批时间 */
    auditAt: timestamp("audit_at", { withTimezone: true }),
    /** 审批备注 / 拒绝原因 */
    auditRemark: text("audit_remark"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** status 翻 '已支付' 的时间；线下/储值卡与 created_at 一致 */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /**
     * 营业额分配状态（仅"回款事件主流水行"有值；储值卡抵扣从行 / 退款 / 待支付行为 NULL）。
     * 待分配＝该笔回款待店长/后台逐笔分配；已分配＝已分配或线上自动分配完成。
     * 按回款逐笔分配的状态下沉位；sale_orders.allocation_status 为其汇总位。
     */
    allocationStatus: allocationStatusEnum("allocation_status"),
  },
  (table) => [
    index("idx_sop_order").on(table.saleOrderId),
    /** 待分配回款列表查询：仅命中带 allocation_status 的主流水行 */
    index("idx_sop_alloc_status")
      .on(table.allocationStatus)
      .where(sql`allocation_status IS NOT NULL`),
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
    /**
     * 同一销售单只能有一笔成功的"首次支付"；后续付款必须落 change_type='回款'。
     * 防 TOCTOU：confirmOffline / payNotify 并发回调时由 DB 兜底。
     */
    uniqueIndex("uq_sop_first_payment")
      .on(table.saleOrderId)
      .where(sql`change_type = '首次支付' AND status = '已支付'`),
    /** 符号一致性：首次支付/回款/储值卡抵扣正数，退款允许 0 或负数（0 元退项扣次数） */
    check(
      "chk_sop_amount_sign",
      sql`(${table.changeType} IN ('首次支付','回款','储值卡抵扣') AND ${table.amount} > 0)
          OR (${table.changeType} = '退款' AND ${table.amount} <= 0)`,
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
 * @deprecated 历史回款逐项可分配额表，仅作为旧数据迁移来源保留。
 *
 * 新运行时统一使用 sale_payment_item_receipts 记录每笔款项 × 商品子项的
 * 有符号行实收金额。
 */
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
    /** 本次回款落到该 item 的可分配金额（营业额分配基数；正数） */
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    /** 销售类别快照（提成率查找用；与 sale_items.sales_category 同源） */
    salesCategory: salesCategoryEnum("sales_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_spai_payment_item").on(table.salePaymentId, table.saleItemId),
    index("idx_spai_order").on(table.saleOrderId),
    // 历史索引；新 paid_sessions 分支 A 走 sale_payment_item_receipts。
    index("idx_spai_order_item").on(table.saleOrderId, table.saleItemId),
  ],
);

/**
 * 款项商品子项实收明细（营业额分配事实父表）
 *
 * 一行 = 一笔款项 × 一个商品子项。amount 为有符号行实收：
 *   - 首次支付 / 回款 / 储值卡抵扣：购买/转入为正，转换转出为负；
 *   - 退款：按被退商品子项写负数。
 *
 * 员工营业额分配必须挂到本表 id，避免再次出现订单级分配。
 */
export const salePaymentItemReceipts = pgTable(
  "sale_payment_item_receipts",
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
    uniqueIndex("uq_spir_payment_item").on(table.salePaymentId, table.saleItemId),
    index("idx_spir_payment").on(table.salePaymentId),
    index("idx_spir_order").on(table.saleOrderId),
    index("idx_spir_order_item").on(table.saleOrderId, table.saleItemId),
  ],
);

/**
 * 款项商品子项营业额分配（营业额分配结果子表）
 *
 * 一行 = 一条 receipt × 一个员工 × 一个角色/技能标签。
 * allocated_amount / commission_amount 均由后端按 receipt.amount 和当前比例重算。
 */
export const salePaymentItemAllocations = pgTable(
  "sale_payment_item_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    salePaymentItemReceiptId: bigint("sale_payment_item_receipt_id", { mode: "number" })
      .notNull()
      .references(() => salePaymentItemReceipts.id),
    employeeId: varchar("employee_id", { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    roleType: varchar("role_type", { length: 20 }).notNull(),
    departmentName: varchar("department_name", { length: 100 }),
    allocationRatio: numeric("allocation_ratio", { precision: 5, scale: 3 }).notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 10, scale: 2 }).notNull(),
    commissionRate: numeric("commission_rate", { precision: 5, scale: 4 }),
    commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }),
    isVoid: boolean("is_void").notNull().default(false),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex("uq_spia_receipt_emp_role")
      .on(table.salePaymentItemReceiptId, table.employeeId, table.roleType)
      .where(sql`is_void = false`),
    index("idx_spia_receipt").on(table.salePaymentItemReceiptId),
    index("idx_spia_employee").on(table.employeeId),
    check(
      "chk_spia_ratio",
      sql`${table.allocationRatio} > 0 AND ${table.allocationRatio} <= 1`,
    ),
  ],
);

const saleOrderPerformanceEventsQuery = sql`
  WITH classified AS (
    SELECT
      sop.id AS sale_payment_id,
      sop.sale_order_id,
      so.store_id,
      so.sale_order_type,
      so.legacy_source,
      sop.change_type,
      sop.payment_method,
      sop.status,
      sop.amount,
      sop.paid_at,
      so.performance_attribution_date,
      (
        sop.status = '已支付'
        AND sop.amount::numeric > 0
        AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
        AND NOT EXISTS (
          SELECT 1
          FROM sale_order_payments prior
          WHERE prior.sale_order_id = sop.sale_order_id
            AND prior.status = '已支付'
            AND prior.amount::numeric > 0
            AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
            AND (
              COALESCE(prior.paid_at, prior.created_at),
              prior.id
            ) < (
              COALESCE(sop.paid_at, sop.created_at),
              sop.id
            )
        )
      ) AS is_initial_event
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
  )
  SELECT
    sale_payment_id,
    sale_order_id,
    store_id,
    sale_order_type,
    legacy_source,
    change_type,
    payment_method,
    status,
    amount,
    paid_at,
    CASE
      WHEN is_initial_event THEN performance_attribution_date
      ELSE (COALESCE(paid_at, CURRENT_TIMESTAMP) AT TIME ZONE 'Asia/Shanghai')::date
    END AS performance_date,
    is_initial_event
  FROM classified
`;

/**
 * 订单款项业绩事件视图。
 *
 * - 每单按支付时间、创建时间、ID 排序的首笔成功正向款项使用订单业绩归属日期；
 * - 后续回款、后续储值卡抵扣和退款使用各自真实 paid_at 的上海自然日；
 * - 视图保留全部状态，报表必须继续限定 status='已支付'。
 */
export const saleOrderPerformanceEvents = pgView(
  "sale_order_performance_events",
  {
    salePaymentId: bigint("sale_payment_id", { mode: "number" }).notNull(),
    saleOrderId: varchar("sale_order_id", { length: 30 }).notNull(),
    storeId: text("store_id").notNull(),
    saleOrderType: saleOrderTypeEnum("sale_order_type").notNull(),
    legacySource: text("legacy_source"),
    changeType: paymentChangeTypeEnum("change_type").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    status: paymentFlowStatusEnum("status").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    performanceDate: date("performance_date").notNull(),
    isInitialEvent: boolean("is_initial_event").notNull(),
  },
).as(saleOrderPerformanceEventsQuery);

/**
 * 商品子项业绩事件视图。
 *
 * 新数据逐笔读取 sale_payment_item_receipts；历史缺失部分以
 * sale_items.received - SUM(已支付 receipt.amount) 形成归属日残差事件。
 * 因此任意时点按 sale_item 汇总本视图，结果恒等于 sale_items.received。
 */
export const saleItemPerformanceEvents = pgView(
  "sale_item_performance_events",
  {
    eventKey: text("event_key").notNull(),
    receiptId: bigint("receipt_id", { mode: "number" }),
    salePaymentId: bigint("sale_payment_id", { mode: "number" }),
    saleOrderId: varchar("sale_order_id", { length: 30 }).notNull(),
    saleItemId: varchar("sale_item_id", { length: 30 }).notNull(),
    storeId: text("store_id").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    salesCategory: salesCategoryEnum("sales_category"),
    changeType: paymentChangeTypeEnum("change_type").notNull(),
    performanceDate: date("performance_date").notNull(),
    isInitialEvent: boolean("is_initial_event").notNull(),
    isLegacyResidual: boolean("is_legacy_residual").notNull(),
  },
).as(sql`
  WITH performance_events AS (
    ${saleOrderPerformanceEventsQuery}
  ),
  paid_receipts AS (
    SELECT
      spir.id,
      spir.sale_payment_id,
      spir.sale_order_id,
      spir.sale_item_id,
      spir.amount,
      spir.sales_category,
      spe.store_id,
      spe.change_type,
      spe.performance_date,
      spe.is_initial_event
    FROM sale_payment_item_receipts spir
    JOIN performance_events spe
      ON spe.sale_payment_id = spir.sale_payment_id
     AND spe.status = '已支付'
  ),
  receipt_totals AS (
    SELECT sale_item_id, SUM(amount)::numeric(10, 2) AS amount
    FROM paid_receipts
    GROUP BY sale_item_id
  ),
  residuals AS (
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      so.store_id,
      ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2)::numeric(10, 2) AS amount,
      si.sales_category,
      so.performance_attribution_date
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    LEFT JOIN receipt_totals rt ON rt.sale_item_id = si.sale_item_id
    WHERE ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2) <> 0
  )
  SELECT
    'receipt:' || pr.id::text AS event_key,
    pr.id AS receipt_id,
    pr.sale_payment_id,
    pr.sale_order_id,
    pr.sale_item_id,
    pr.store_id,
    pr.amount,
    pr.sales_category,
    pr.change_type,
    pr.performance_date,
    pr.is_initial_event,
    false AS is_legacy_residual
  FROM paid_receipts pr
  UNION ALL
  SELECT
    'residual:' || r.sale_item_id AS event_key,
    NULL::bigint AS receipt_id,
    NULL::bigint AS sale_payment_id,
    r.sale_order_id,
    r.sale_item_id,
    r.store_id,
    r.amount,
    r.sales_category,
    '首次支付'::payment_change_type AS change_type,
    r.performance_attribution_date AS performance_date,
    true AS is_initial_event,
    true AS is_legacy_residual
  FROM residuals r
`);

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
export type SalePaymentItemReceipt = typeof salePaymentItemReceipts.$inferSelect;
export type NewSalePaymentItemReceipt = typeof salePaymentItemReceipts.$inferInsert;
export type SalePaymentItemAllocation = typeof salePaymentItemAllocations.$inferSelect;
export type NewSalePaymentItemAllocation = typeof salePaymentItemAllocations.$inferInsert;
export type SaleOrderPerformanceEvent = typeof saleOrderPerformanceEvents.$inferSelect;
export type SaleItemPerformanceEvent = typeof saleItemPerformanceEvents.$inferSelect;
