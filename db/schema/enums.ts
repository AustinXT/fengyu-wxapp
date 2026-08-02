import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 商品类型（product_skus.product_type / sale_items.product_type）—— 决定核销流程
 *
 * 2026-05-21 单品合并：原 3 值 [疗程卡, 单品, 家居产品] → 2 值。
 * 单品本质是 session_count=1 的疗程卡（消费引擎对两者零分支），故并入疗程卡：
 *   - 原 session_count=1 的单品 → 疗程卡（次数=1）
 *   - 原实物零售单品（session_count=null，如精华液/礼盒）→ 家居产品
 * 退款统一按 remaining_sessions（家居产品仍按 quantity−picked_up）；
 * 转换抵扣放开（remaining_sessions>0 即可抵，不再要求 is_experience）；
 * 单品 1 年有效期自动赋值已移除。详见 migration 0050。
 */
export const productTypeEnum = pgEnum("product_type", ["疗程卡", "家居产品"]);

export const orderStatusEnum = pgEnum("order_status", [
  "待支付",
  "已支付",
  "已完成",
  "已退款",
  "支付失败",
  "已关闭",
  "待审批",
  "部分支付",
  "未审核",
  "已作废",
]);

/**
 * 销售单据类型（sale_orders.sale_order_type）
 *
 * 2026-04-26 sale-order-domain-refactor：5→3 值。
 * 回款单/退款单已下沉到 sale_order_payments（change_type='回款'/'退款'）。
 * 2026-05-18 新增"寄存单"：WorkFine 剩余次数初始化专用，不收钱、不入金额统计；
 * 但 sale_items 正常落 remaining_sessions 供 service_orders 核销。
 * 2026-05-19 新增"充值单"：充值卡退出 SKU 化，独立用 sale_order_type 区分；
 * 充值单不写 sale_items，total_amount=面值、payable_amount=实付，
 * 入账识别从 sale_items.is_recharge_card 改为本枚举值。
 */
export const saleOrderTypeEnum = pgEnum("sale_order_type", ["销售单", "内部单", "转换单", "寄存单", "充值单"]);

export const allocationStatusEnum = pgEnum("allocation_status", ["待分配", "已分配"]);

export const itemDirectionEnum = pgEnum("item_direction", ["购买", "转出", "转入", "退出"]);

export const paymentMethodEnum = pgEnum("payment_method", ["微信", "支付宝", "线下", "无", "储值卡"]);

/**
 * 款项流水类型（sale_order_payments.change_type）
 *
 * 首次支付：订单创建那一刻的第一笔收款，至多 1 行/订单
 * 回款：订单存活期内多次补款
 * 退款：Ticket 3 写入，amount 为负
 * 储值卡抵扣：下单时使用储值卡抵扣，与"首次支付"同事务并行写 1 行（PR-3 开始启用）
 *
 * 与 order.ts saleOrderPayments 的 chk_sop_amount_sign CHECK 保持一致。
 */
export const paymentChangeTypeEnum = pgEnum("payment_change_type", [
  "首次支付",
  "回款",
  "退款",
  "储值卡抵扣",
]);

/**
 * 款项流水状态（sale_order_payments.status）
 *
 * 待支付：线上支付已发起未到账
 * 待审批：退款已发起、待店长 / 财务审批（2026-04-26 sale-order-domain-refactor 新增）
 * 已支付：到账（线下/储值卡直接落此状态；退款审批通过亦置此并 amount<0）
 * 已作废：创建后被取消（如超时/手动关闭触发；退款被驳回亦置此）
 * 已退款：首次支付/回款行整笔退款时置此（仅原行）
 */
export const paymentFlowStatusEnum = pgEnum("payment_flow_status", [
  "待支付",
  "待审批",
  "已支付",
  "已作废",
  "已退款",
]);

/**
 * 款项来源端（sale_order_payments.source_end）
 */
export const paymentSourceEndEnum = pgEnum("payment_source_end", [
  "client",
  "staff",
  "admin",
  "notify",
]);

export const serviceOrderStatusEnum = pgEnum("service_order_status", ["待服务", "服务中", "待客户确认", "已完成", "已取消"]);

export const serviceOrderTypeEnum = pgEnum("service_order_type", ["售前", "售后"]);

export const appointmentStatusEnum = pgEnum("appointment_status", ["待确认", "已确认", "已完成", "已取消", "已关闭"]);

export const storeUnbindRequestStatusEnum = pgEnum("store_unbind_request_status", [
  "待处理",
  "已通过",
  "已拒绝",
  "已取消",
]);

export const salesCategoryEnum = pgEnum("sales_category", ["自销自耗", "他销自耗", "他销他耗", "生态合作"]);

export const couponTypeEnum = pgEnum("coupon_type", ["现金券", "品项券", "折扣券"]);

export const couponStatusEnum = pgEnum("coupon_status", ["未使用", "已使用", "已过期"]);

export const orgNodeTypeEnum = pgEnum("org_node_type", ["总部", "市场", "门店", "部门"]);

export const messageRecipientTypeEnum = pgEnum("message_recipient_type", ["客户", "员工"]);

export const cardTransactionTypeEnum = pgEnum("card_transaction_type", ["充值", "扣款"]);

export const memberLevelEnum = pgEnum("member_level", ["初钻", "星钻", "粉钻", "金钻", "黑钻"]);

export const customerSourceEnum = pgEnum("customer_source", [
  "美团",
  "抖音",
  "小程序",
  "推带新",
  "地推卡",
  "拓客卡",
  "老带新",
  "转让店",
  "自进店",
  "内部员工或家属",
]);

export const customerTypeEnum = pgEnum("customer_type", ["流量客", "体验客", "小美客", "会员客"]);

export const documentTypeEnum = pgEnum("document_type", ["售前", "售后"]);

export const spendingTierEnum = pgEnum("spending_tier", ["10W+", "6-10W", "3-6W", "1-3W", "1990-1W", "<1990"]);

export const monthlyActivityEnum = pgEnum("monthly_activity", ["二次客活", "一次客活", "0次客活"]);

export const customerStatusEnum = pgEnum("customer_status", [
  "保有会员-稳定",
  "保有会员-有效",
  "沉睡",
  "冰冻",
  "休眠",
]);

/**
 * 库存单据通用状态（4 张主表共用）
 */
export const inventoryDocStatusEnum = pgEnum("inventory_doc_status", [
  "草稿",
  "已完成",
  "已取消",
]);

/**
 * 采购入库类子类型（inventory_procurement_orders.doc_subtype）
 *
 * 院报货：店内向供应链/市场提需求
 * 院入库：实际收货入库（可能引用对应的院报货 / 市场出库单 SCCKD）
 * 退货出库：店内退货回供应商（库存减少；归在采购域因为是与供应商互动）
 */
export const inventoryProcurementSubtypeEnum = pgEnum(
  "inventory_procurement_subtype",
  ["院报货", "院入库", "退货出库"],
);

/**
 * 销售出库类子类型（inventory_sale_orders.doc_subtype）
 *
 * 销售出库：顾客领取家居产品（库存减少）
 * 顾客退货：顾客退回家居产品（库存增加；负向出库）
 */
export const inventorySaleSubtypeEnum = pgEnum("inventory_sale_subtype", [
  "销售出库",
  "顾客退货",
]);

/**
 * 调拨类子类型（inventory_transfer_orders.doc_subtype）
 *
 * 调拨出库：本门店发出货物给对方门店
 * 调拨入库：本门店从对方门店接收货物
 *
 * 物理上同一条调拨单两端视图通过 is_dispatcher 区分；不同视图可生成两条业务记录或共享同一条。
 */
export const inventoryTransferSubtypeEnum = pgEnum(
  "inventory_transfer_subtype",
  ["调拨出库", "调拨入库"],
);

/**
 * 门店库存 v2 统一单据类型。
 *
 * 会议确认的 8 个业务流程在 UI 上保留，但底层不再拆 4 组主从表；
 * 所有库存填报都围绕 store_inventory_stocks（门店库存表）生成统一单据和库存流水。
 */
export const storeInventoryDocTypeEnum = pgEnum("store_inventory_doc_type", [
  "院报货",
  "院入库",
  "院顾客退货",
  "院顾客产品出库",
  "院退货",
  "院产品报损",
  "分院调货出库",
  "分院调货入库",
  "期初库存",
]);

export const storeInventoryDocStatusEnum = pgEnum("store_inventory_doc_status", [
  "草稿",
  "待审批",
  "待收货",
  "已完成",
  "已驳回",
  "已取消",
]);

export const storeInventoryMovementDirectionEnum = pgEnum(
  "store_inventory_movement_direction",
  ["入库", "出库", "调整"],
);
