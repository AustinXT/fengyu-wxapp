/**
 * 疗程卡「持卡权益」判定的单一真源（#371 从 actions/cards.ts 抽出）。
 *
 * 卡包列表 / 卡详情（/cards）、持卡折抵候选（getCustomerHeldCards）与数据中心「顾客剩余卡项清单」
 * 共用这里，保证「哪些行算一张卡」「哪些卡已退完」三处同口径。
 *
 * 条件均引用 drizzle 列（渲染为 "sale_items"."col" / "sale_orders"."col"），
 * 原生 SQL 调用方须以**不带别名**的 `sale_items` / `sale_orders` 作为 FROM 表。
 */
import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm'
import { saleItems, saleOrders } from '@db/order'

/** 持卡权益的订单状态：甲方 2026-09-14 拍板订单级「部分支付」也算（#125） */
export const CARD_ENTITLEMENT_ORDER_STATUSES = ['已支付', '部分支付', '已完成'] as const

/** 权益方向：购买行，或转换单的转入行 */
export function cardEntitlementDirectionCondition(): SQL | undefined {
  return or(
    eq(saleItems.itemDirection, '购买'),
    and(
      eq(saleOrders.saleOrderType, '转换单'),
      eq(saleItems.itemDirection, '转入'),
    ),
  )
}

/**
 * 疗程卡基础集（不含 scope）：权益方向 + 有效订单状态 + 疗程卡 + 余次不为空。
 * issue #122：不按次数过滤——欠款卡（可用 0）也在集内，「是否已用完」交给调用方。
 */
export function cardBaseConditions(): (SQL | undefined)[] {
  return [
    cardEntitlementDirectionCondition(),
    inArray(saleOrders.status, [...CARD_ENTITLEMENT_ORDER_STATUSES]),
    eq(saleItems.productType, '疗程卡'),
    isNotNull(saleItems.remainingSessions),
  ]
}

/**
 * 「未退完」守卫：仅当订单存在已审批退款时，按 paid_sessions 有效余量判定（不影响无退款的分期卡）。
 * 家居产品不适用（已退数量落 refunded_quantity，未结算件数天然已扣除），恒放行。
 */
export function cardNotFullyRefundedCondition(): SQL {
  return sql`(${saleItems.productType} <> '疗程卡' OR NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付') OR ${saleItems.paidSessions} IS NULL OR ${saleItems.paidSessions} > (${saleItems.sessionCount} - ${saleItems.remainingSessions}))`
}
