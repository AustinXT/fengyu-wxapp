import { pgEnum } from "drizzle-orm/pg-core";


export const productTypeEnum = pgEnum("product_type", ["疗程卡", "家居产品"]);

export const orderStatusEnum = pgEnum("order_status", [
  "待支付",
  "已支付",
  "已完成",
  "支付失败",
  "已关闭",
  "待审批",
  "部分支付",
  "未审核",
  "已作废",
]);


export const saleOrderTypeEnum = pgEnum("sale_order_type", ["销售单", "内部单", "转换单", "寄存单", "充值单"]);

export const allocationStatusEnum = pgEnum("allocation_status", ["待分配", "已分配"]);

export const itemDirectionEnum = pgEnum("item_direction", ["购买", "转出", "转入", "退出"]);

export const paymentMethodEnum = pgEnum("payment_method", ["微信", "支付宝", "线下", "无", "储值卡"]);


export const paymentChangeTypeEnum = pgEnum("payment_change_type", [
  "首次支付",
  "回款",
  "退款",
  "储值卡抵扣",
]);


export const paymentFlowStatusEnum = pgEnum("payment_flow_status", [
  "待支付",
  "待审批",
  "已支付",
  "已作废",
  "已退款",
]);


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


export const inventoryDocStatusEnum = pgEnum("inventory_doc_status", [
  "草稿",
  "已完成",
  "已取消",
]);


export const inventoryProcurementSubtypeEnum = pgEnum(
  "inventory_procurement_subtype",
  ["院报货", "院入库", "退货出库"],
);


export const inventorySaleSubtypeEnum = pgEnum("inventory_sale_subtype", [
  "销售出库",
  "顾客退货",
]);


export const inventoryTransferSubtypeEnum = pgEnum(
  "inventory_transfer_subtype",
  ["调拨出库", "调拨入库"],
);

