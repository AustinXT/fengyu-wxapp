/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：净已支付金额按比例可换到的次数，**行级**比例 floor。
 * 公式：paid_sessions = floor( min(1, (item.received - item_refund_share) / item.sale_amount) × session_count )
 *   - item_refund_share = order.refunded × item.sale_amount / order.total （订单级退款按 sale_amount 按比例下分到行）
 *     之所以按订单级而非行级是因为目前没有行级退款追踪
 *   - sale_items.received 已含 '储值卡抵扣' change_type 行
 *     （admin confirmOfflinePayment / recordPayment SUM 公式跨端对齐 staff/order.js），不重复计 prepaid_card_amount
 *   - sale_items.sale_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）
 *   - session_count IS NULL → paid_sessions = NULL（非次数卡）
 *
 * D3=A 退款扣减：order.refunded 增加 → 行下分 refund_share 增加 → item_settled 下降 → paid_sessions 自动倒退；
 * 若新 paid_sessions < 已消费次数(session_count - remaining_sessions)，
 * recalcPaidSessionsForOrder 抛 CONFLICT 阻止退款，保护"已消费次数不可撤销"不变量。
 *
 * 同时维护两个出口：
 *   1) computePaidSessionsForItem(...) — JS 纯函数，order.create 写入新行时使用
 *   2) PAID_SESSIONS_RECALC_SQL — SQL 模板（字面量供 snapshot 守护），执行时用 sql tagged template 模板插值
 *
 * 跨端字节同义守护：__tests__/routes/cross-end-sql-snapshot.test.js（normalizeSql 后比对）
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function computePaidSessionsForItem({
  itemReceived,
  itemSaleAmount,
  itemSessionCount,
  orderTotal,
  orderRefunded,
}: {
  itemReceived: number | string
  itemSaleAmount: number | string
  itemSessionCount: number | null
  orderTotal: number | string
  orderRefunded?: number | string
}): number | null {
  if (itemSessionCount == null) return null
  const sa = Number(itemSaleAmount) || 0
  if (sa <= 0) return Number(itemSessionCount)
  const tot = Number(orderTotal) || 0
  if (tot <= 0) return Number(itemSessionCount)
  const itemRefundShare = tot > 0 ? (Number(orderRefunded) || 0) * sa / tot : 0
  const itemSettled = Math.max(0, (Number(itemReceived) || 0) - itemRefundShare)
  const ratio = Math.min(1, itemSettled / sa)
  return Math.max(0, Math.min(Number(itemSessionCount), Math.floor(ratio * Number(itemSessionCount))))
}

/**
 * SQL 模板字面量（pg 风格 $1 = saleOrderId）— 仅供跨端 snapshot 比对，
 * 实际执行走 sql tagged template 模板插值。三端 cloudfunction 副本字面量与此完全一致。
 */
export const PAID_SESSIONS_RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(LEAST(1, GREATEST(0, sale_items.received::numeric - (op.refunded_amount::numeric * sale_items.sale_amount::numeric / NULLIF(op.total_amount::numeric, 0))) / sale_items.sale_amount::numeric) * sale_items.session_count)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount, COALESCE(refunded_amount, 0) AS refunded_amount FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`

/**
 * 在 Drizzle 事务内重算指定订单的所有 sale_items.paid_sessions。
 * D3=A 退款守护：若重算后 (session_count - remaining_sessions) > paid_sessions，
 * 抛 CONFLICT，提示调用方先取消已生成的服务单。
 */
export async function recalcPaidSessionsForOrder(tx: AdminTx, saleOrderId: string): Promise<void> {
  // STEP 1: 定向回款落到指定行 + 其余按剩余产能比例摊到 sale_items.received
  // 「定向 + 剩余产能比例」混合（ticket 2026-05-21 按子项定向回款）：
  //   targeted_i = Σ(已支付 payments ref_sale_item_id=i, change_type∈首次支付/回款/储值卡抵扣)（退款排除）；
  //   untargeted = order.received - Σtargeted；cap_i = sale_amount_i - targeted_i；
  //   received_i = targeted_i + untargeted × cap_i / Σcap。
  // 无定向时（ref 仅退款写 → targeted=0）退化为按 sale_amount 比例 = 旧 STEP 1，向后兼容。
  // 保证 sum(sale_items.received) = sale_orders.received。与三端 cloudfunction 副本字节同义。
  await tx.execute(sql`
    WITH tg AS (
      SELECT ref_sale_item_id, SUM(amount) AS targeted
      FROM sale_order_payments
      WHERE sale_order_id = ${saleOrderId} AND status = '已支付'
        AND change_type IN ('首次支付','回款','储值卡抵扣') AND ref_sale_item_id IS NOT NULL
      GROUP BY ref_sale_item_id
    ),
    caps AS (
      SELECT si.sale_item_id,
             GREATEST(0, si.sale_amount::numeric - COALESCE(tg.targeted, 0)::numeric) AS cap,
             COALESCE(tg.targeted, 0)::numeric AS targeted
      FROM sale_items si
      LEFT JOIN tg ON tg.ref_sale_item_id = si.sale_item_id
      WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
    ),
    agg AS (
      SELECT GREATEST(0, (SELECT received FROM sale_orders WHERE sale_order_id = ${saleOrderId})::numeric - COALESCE((SELECT SUM(targeted) FROM tg), 0)::numeric) AS untargeted,
             COALESCE(SUM(cap), 0)::numeric AS cap_total
      FROM caps
    )
    UPDATE sale_items si
    SET received = CASE
          WHEN agg.cap_total > 0
            THEN caps.targeted + ROUND(agg.untargeted * caps.cap / agg.cap_total, 2)
          ELSE caps.targeted
        END,
        updated_at = NOW()
    FROM caps, agg
    WHERE si.sale_item_id = caps.sale_item_id
  `)

  // STEP 2: 按行级公式重算 paid_sessions（公式守 cross-end-sql-snapshot，不改字面）
  await tx.execute(sql`
    UPDATE sale_items
    SET paid_sessions = CASE
      WHEN sale_items.session_count IS NULL THEN NULL
      WHEN op.total_amount <= 0 THEN sale_items.session_count
      WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
      ELSE LEAST(sale_items.session_count, FLOOR(LEAST(1, GREATEST(0, sale_items.received::numeric - (op.refunded_amount::numeric * sale_items.sale_amount::numeric / NULLIF(op.total_amount::numeric, 0))) / sale_items.sale_amount::numeric) * sale_items.session_count)::integer)
    END,
    updated_at = NOW()
    FROM (SELECT total_amount, COALESCE(refunded_amount, 0) AS refunded_amount FROM sale_orders WHERE sale_order_id = ${saleOrderId}) op
    WHERE sale_items.sale_order_id = ${saleOrderId}
  `)
  const violation = await tx.execute(sql`
    SELECT sale_item_id, session_count, remaining_sessions, paid_sessions
      FROM sale_items
     WHERE sale_order_id = ${saleOrderId}
       AND session_count IS NOT NULL
       AND paid_sessions IS NOT NULL
       AND (session_count - remaining_sessions) > paid_sessions
     LIMIT 1
  `)
  const rows = violation == null
    ? []
    : ((violation as unknown as { rows?: Array<Record<string, unknown>> }).rows
       ?? (violation as unknown as Array<Record<string, unknown>>))
  if (Array.isArray(rows) && rows.length > 0) {
    const r = rows[0] as { sale_item_id?: string; session_count?: number; remaining_sessions?: number; paid_sessions?: number }
    // 真实 violation 必须含 sale_item_id；mock 默认 {} 时跳过守护（避免单元测试误触发）
    if (r && r.sale_item_id) {
      throw new Error(
        `CONFLICT: PAID_SESSIONS_UNDERFLOW: 订单行 ${r.sale_item_id} 退款后已支付次数(${r.paid_sessions})低于已消费次数(${Number(r.session_count) - Number(r.remaining_sessions)})，请先取消相关服务单回滚消费再退款`,
      )
    }
  }
}
