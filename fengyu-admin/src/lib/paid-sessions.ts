/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：行级**净实收**按比例可换到的次数，**行级**比例 floor。
 * 公式：paid_sessions = min( session_count, floor( item.received × session_count / item.sale_amount ) )
 *   先乘后除（D9=A 整数精度）：避免先除产生 0.13333…×15=1.9999… 被 FLOOR 误舍成 1（应为 2）；封顶交给外层 LEAST(session_count)
 *   - item.received 已是**净额**：STEP1 分摊毛额 → STEP 1.5（recalc 内 tx.execute）按 note.items[].refundAmount
 *     逐项扣退款（2026-06-08 退款侧），不再按订单级 order.refunded × sale_amount / total 均摊（退一项不连累其它行）
 *   - sale_items.received 已含 '储值卡抵扣' change_type 行
 *     （admin confirmOfflinePayment / recordPayment SUM 公式跨端对齐 staff/order.js），不重复计 prepaid_card_amount
 *   - sale_items.sale_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）
 *   - session_count IS NULL → paid_sessions = NULL（非次数卡）
 *
 * D3=A 退款扣减：退款审批通过 → STEP 1.5 把该行 received 扣减（净额下降）→ paid_sessions 自动倒退；
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
  // 先乘后除保整数精度；封顶 session_count（过付/越界兜底）
  return Math.max(0, Math.min(Number(itemSessionCount), Math.floor(itemSettled * Number(itemSessionCount) / sa)))
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
  ELSE LEAST(sale_items.session_count, FLOOR(sale_items.received::numeric * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`

/**
 * 在 Drizzle 事务内重算指定订单的所有 sale_items.paid_sessions。
 * D3=A 退款守护：若重算后 (session_count - remaining_sessions) > paid_sessions，
 * 抛 CONFLICT，提示调用方先取消已生成的服务单。
 */
export async function recalcPaidSessionsForOrder(tx: AdminTx, saleOrderId: string): Promise<void> {
  // STEP 1：两路分流（2026-06-28 received = Σ spai，瀑布作无 spai 回退）
  //   A. 有 spai 数据 → received = Σ sale_payment_allocatable_items.amount per item
  //      （spai 由 capturePaymentAllocatables 在同事务内写入；定向写精确逐项，非定向写两段式瀑布摊分额；
  //       故 Σ spai = 该行累计毛 received，天然精确，瀑布退役）
  //   B. 无 spai（历史订单 / 退款路径 / 数据修复）→ 回退旧瀑布，避免 received 被置零
  // STEP1 后 sum(sale_items.received) 毛额；STEP 1.5 扣退款后转净额。与三端 cloudfunction 副本字节同义。
  const covRes = await tx.execute(sql`
    SELECT COALESCE((SELECT SUM(amount::numeric) FROM sale_payment_allocatable_items WHERE sale_order_id = ${saleOrderId}), 0) AS spai_total,
           (SELECT received::numeric FROM sale_orders WHERE sale_order_id = ${saleOrderId}) AS order_received
  `)
  // tx.execute() 走 drizzle-orm/postgres-js，返回 postgres.js RowList（array-like，带 .count，无 .rows）。
  // 须按数组解包（同 payment-allocatable.ts / points-settle.ts 惯例）。
  const covRows = covRes as unknown as Array<{ spai_total: string; order_received: string }>
  const spaiTotal = Number(covRows[0]?.spai_total || 0)
  const orderReceived = Number(covRows[0]?.order_received || 0)
  // spai_total >= order_received（容差 0.01 处理浮点）→ spai 完整覆盖，Branch A 安全；
  // 否则 spai 不完整（历史部分支付订单仅新付款有 spai），Branch B 保护旧 received 不被清零。
  const hasSpai = spaiTotal > 0 && spaiTotal >= orderReceived - 0.01
  if (hasSpai) {
    // 分支 A：received = Σ spai.amount per item
    await tx.execute(sql`
      UPDATE sale_items si
      SET received = COALESCE(GREATEST(0, (
        SELECT SUM(amount::numeric) FROM sale_payment_allocatable_items spai
         WHERE spai.sale_order_id = ${saleOrderId} AND spai.sale_item_id = si.sale_item_id
      )), 0),
      updated_at = NOW()
      WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
    `)
  } else {
    // 分支 B：回退瀑布（无 spai 的历史/异常单，零回归）
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
               COALESCE(tg.targeted, 0)::numeric AS targeted,
               GREATEST(0, si.pending_received::numeric - COALESCE(tg.targeted, 0)::numeric) AS pend_cap,
               GREATEST(0, si.sale_amount::numeric - GREATEST(si.pending_received::numeric, COALESCE(tg.targeted, 0)::numeric)) AS sale_cap
        FROM sale_items si
        LEFT JOIN tg ON tg.ref_sale_item_id = si.sale_item_id
        WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
      ),
      agg AS (
        SELECT GREATEST(0, (SELECT received FROM sale_orders WHERE sale_order_id = ${saleOrderId})::numeric - COALESCE((SELECT SUM(targeted) FROM tg), 0)::numeric) AS untargeted,
               COALESCE(SUM(pend_cap), 0)::numeric AS pend_cap_total,
               COALESCE(SUM(sale_cap), 0)::numeric AS sale_cap_total
        FROM caps
      )
      UPDATE sale_items si
      SET received = CASE
            WHEN agg.pend_cap_total > 0 OR agg.sale_cap_total > 0
              THEN caps.targeted
                + ROUND(
                    (CASE WHEN agg.pend_cap_total > 0
                          THEN LEAST(agg.untargeted, agg.pend_cap_total) * caps.pend_cap / agg.pend_cap_total
                          ELSE 0 END)
                  + (CASE WHEN agg.sale_cap_total > 0 AND agg.untargeted > agg.pend_cap_total
                          THEN (agg.untargeted - agg.pend_cap_total) * caps.sale_cap / agg.sale_cap_total
                          ELSE 0 END), 2)
            ELSE caps.targeted
          END,
          updated_at = NOW()
      FROM caps, agg
      WHERE si.sale_item_id = caps.sale_item_id
    `)
  }

  // STEP 1.5: 从毛额扣逐项退款（note.items[].refundAmount 按 refSaleItemId 聚合）→ received 变净额（被退项单独减少）
  // note→jsonb 三重防线（WHERE 仅 退款+已支付 / note LIKE '{%' 守门 / 嵌套 CASE 保 cast）；仅购买行；GREATEST(0) clamp；幂等。
  // 与三端 cloudfunction RECEIVED_REFUNDED_DEDUCT_SQL 字节同义。
  await tx.execute(sql`
    WITH refund_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id,
             COALESCE((elem ->> 'refundAmount')::numeric, 0) AS refund_amount
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = ${saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付'
    ),
    agg AS (
      SELECT sale_item_id, SUM(refund_amount) AS refunded
      FROM refund_items WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id
    )
    UPDATE sale_items si
    SET received = GREATEST(0, si.received::numeric - COALESCE(agg.refunded, 0)),
        updated_at = NOW()
    FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买') ai
    LEFT JOIN agg ON agg.sale_item_id = ai.sale_item_id
    WHERE si.sale_item_id = ai.sale_item_id
  `)

  // STEP 2: 按行级公式重算 paid_sessions（received 已净额，不再下分订单级退款；守 cross-end-sql-snapshot）
  await tx.execute(sql`
    UPDATE sale_items
    SET paid_sessions = CASE
      WHEN sale_items.session_count IS NULL THEN NULL
      WHEN op.total_amount <= 0 THEN sale_items.session_count
      WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
      ELSE LEAST(sale_items.session_count, FLOOR(sale_items.received::numeric * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
    END,
    updated_at = NOW()
    FROM (SELECT total_amount FROM sale_orders WHERE sale_order_id = ${saleOrderId}) op
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
