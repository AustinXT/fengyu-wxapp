import { pgEnum } from "drizzle-orm/pg-core";

export const productKindEnum = pgEnum("product_kind", ["护理项目", "家居产品", "充值卡", "体验卡"]);

export const productTypeEnum = pgEnum("product_type", ["疗程卡", "单品", "院装产品"]);

export const orderStatusEnum = pgEnum("order_status", [
  "待支付",
  "待确认收款",
  "已支付",
  "已完成",
  "支付失败",
  "已关闭",
  "待审批",
]);

export const saleOrderTypeEnum = pgEnum("sale_order_type", ["销售单", "内部单", "回款单", "转换单", "退款单"]);

export const allocationStatusEnum = pgEnum("allocation_status", ["待分配", "已分配"]);

export const itemDirectionEnum = pgEnum("item_direction", ["购买", "转出", "转入", "退出"]);

export const paymentMethodEnum = pgEnum("payment_method", ["微信", "支付宝", "线下", "无"]);

export const serviceOrderStatusEnum = pgEnum("service_order_status", ["待服务", "服务中", "已完成", "已取消"]);

export const serviceOrderTypeEnum = pgEnum("service_order_type", ["售前", "售后"]);

export const appointmentStatusEnum = pgEnum("appointment_status", ["待确认", "已确认", "已完成", "已取消", "已关闭"]);

export const storeUnbindRequestStatusEnum = pgEnum("store_unbind_request_status", [
  "待处理",
  "已通过",
  "已拒绝",
  "已取消",
]);

export const salesCategoryEnum = pgEnum("sales_category", ["自采自销", "他销自耗", "他销他耗", "生态合作"]);

export const couponTypeEnum = pgEnum("coupon_type", ["现金券", "品项券", "折扣券"]);

export const couponStatusEnum = pgEnum("coupon_status", ["未使用", "已使用", "已过期"]);

export const orgNodeTypeEnum = pgEnum("org_node_type", ["总部", "市场", "门店", "部门"]);

export const messageRecipientTypeEnum = pgEnum("message_recipient_type", ["客户", "员工"]);

export const cardTransactionTypeEnum = pgEnum("card_transaction_type", ["充值", "扣款"]);

export const positionScopeEnum = pgEnum("position_scope", ["总部", "市场", "门店"]);

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
  "预警沉睡",
  "冰冻",
  "休眠",
]);
