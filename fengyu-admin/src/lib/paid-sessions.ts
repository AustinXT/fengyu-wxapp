/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：行级**净实收**按比例可换到的次数，**行级**比例 floor。
 * 公式：paid_sessions = min( session_count, floor( item.received × session_count / item.sale_amount ) )
 *   先乘后除（D9=A 整数精度）：避免先除产生 0.13333…×15=1.9999… 被 FLOOR 误舍成 1（应为 2）；封顶交给外层 LEAST(session_count)
 *   - item.received 已是**净额**：新 receipt 覆盖订单优先按 sale_payment_item_receipts 有符号金额重建；
 *     旧数据无完整 receipt 时回退瀑布 + note.items[].refundAmount 扣减。
 *   - sale_items.received 已含 '储值卡抵扣' change_type 行
 *     （admin confirmOfflinePayment / recordPayment SUM 公式跨端对齐 staff/order.js），不重复计 prepaid_card_amount
 *   - sale_items.sale_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）；若退款 note 标记该 0 元 item 全退，后置覆盖为 0
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
import { saleItems } from '@db/order'

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

export const FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL = `WITH full_refund_zero_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
        AND LOWER(COALESCE(elem ->> 'isFullItemRefund', 'false')) = 'true'
    )
    UPDATE sale_items si
    SET paid_sessions = 0,
        updated_at = NOW()
    WHERE si.sale_order_id = $1
      AND si.item_direction = '购买'
      AND si.session_count IS NOT NULL
      AND si.sale_amount <= 0
      AND EXISTS (
        SELECT 1 FROM full_refund_zero_items fri WHERE fri.sale_item_id = si.sale_item_id
      )`

/**
 * STEP 1.6：转换单转入行按已兑现价值重建 received。
 * 已兑现价值 = 转出旧卡价值 + 本单净到账，且封顶转入总价；多行按 sale_amount
 * 权重分摊，最后一行吸收分币尾差。这样待支付/部分支付转换单不会因创建时写入
 * 完整转入金额而提前解锁全部次数，结清时又恰好恢复完整转入价值。
 */
export const CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL = `WITH conversion_order AS (
      SELECT so.sale_order_type,
             GREATEST(0, so.received::numeric - so.refunded_amount::numeric) AS net_received,
             COALESCE((
               SELECT SUM(GREATEST(0, -out_item.received::numeric))
               FROM sale_items out_item
               WHERE out_item.sale_order_id = $1 AND out_item.item_direction = '转出'
             ), 0)::numeric AS converted_value,
             COALESCE((
               SELECT SUM(in_item.sale_amount::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = $1 AND in_item.item_direction = '转入'
                 AND in_item.sale_amount::numeric > 0
             ), 0)::numeric AS in_total
      FROM sale_orders so
      WHERE so.sale_order_id = $1
    ),
    ranked AS (
      SELECT si.sale_item_id,
             si.sale_amount::numeric AS item_sale_amount,
             conversion_order.in_total,
             LEAST(conversion_order.in_total,
                   conversion_order.converted_value + conversion_order.net_received) AS target_received,
             ROW_NUMBER() OVER (ORDER BY si.sale_item_id) AS rn,
             COUNT(*) OVER () AS item_count
      FROM sale_items si
      CROSS JOIN conversion_order
      WHERE conversion_order.sale_order_type = '转换单'
        AND si.sale_order_id = $1
        AND si.item_direction = '转入'
        AND si.sale_amount::numeric > 0
    ),
    provisional AS (
      SELECT ranked.*,
             ROUND(target_received * item_sale_amount / in_total, 2) AS provisional_received
      FROM ranked
      WHERE in_total > 0
    ),
    allocated AS (
      SELECT sale_item_id,
             CASE WHEN rn = item_count
                    THEN target_received - COALESCE(SUM(provisional_received) FILTER (WHERE rn < item_count) OVER (), 0)
                  ELSE provisional_received
             END::numeric(10, 2) AS item_received
      FROM provisional
    )
    UPDATE sale_items si
    SET received = allocated.item_received,
        updated_at = NOW()
    FROM allocated
    WHERE si.sale_item_id = allocated.sale_item_id`

/**
 * 已付未用次数（可用次数）派生表达式 —— 查询侧只读派生（与上方 RECALC 写入对照）。
 * admin 单源：卡包列表/详情（cards.ts）+ 订单导出 + 营业额分配导出（orders.ts）复用。
 *   - paid_sessions IS NULL（migration 0041 前历史行未回填）→ 退回物理剩余 remaining_sessions，避免误显「已耗尽」
 *   - 否则 max(paid − used, 0)，used = max(session_count − remaining, 0)（clamp 防脏数据 remaining>session_count 时负值）
 * 口径须与 client/staff 前端 paidUnusedSessions 派生一致（cross-end-sql-snapshot.test.js 守护 JS 派生口径）。
 */
export const paidUnusedSessionsExpr = sql<number>`CASE WHEN ${saleItems.paidSessions} IS NULL THEN ${saleItems.remainingSessions} ELSE GREATEST(COALESCE(${saleItems.paidSessions}, 0) - GREATEST(${saleItems.sessionCount} - ${saleItems.remainingSessions}, 0), 0) END`.as('paid_unused_sessions')

/**
 * 在 Drizzle 事务内重算指定订单的所有 sale_items.paid_sessions。
 * D3=A 退款守护：若重算后 (session_count - remaining_sessions) > paid_sessions，
 * 抛 CONFLICT，提示调用方先取消已生成的服务单。
 */
export async function recalcPaidSessionsForOrder(tx: AdminTx, saleOrderId: string): Promise<void> {
  // STEP 0：款项流水是 actual 储值卡金额的权威源；pending 仅代表尚未扣卡意向。
  await tx.execute(sql`
    WITH card_totals AS (
      SELECT GREATEST(0, COALESCE(SUM(amount::numeric) FILTER (
               WHERE status = '已支付'
                 AND (change_type = '储值卡抵扣' OR (change_type = '退款' AND payment_method = '储值卡'))
             ), 0))::numeric(10, 2) AS settled_prepaid
      FROM sale_order_payments
      WHERE sale_order_id = ${saleOrderId}
    )
    UPDATE sale_orders so
    SET prepaid_card_amount = card_totals.settled_prepaid,
        payable_amount = CASE
          WHEN so.sale_order_type IN ('销售单','内部单','转换单')
            THEN GREATEST(0, so.total_amount::numeric - card_totals.settled_prepaid - so.pending_prepaid_card_amount::numeric)
          ELSE so.payable_amount
        END,
        updated_at = NOW()
    FROM card_totals
    WHERE so.sale_order_id = ${saleOrderId}
  `)

  // STEP 1：两路分流
  //   A. 正向 receipt 覆盖订单毛实收 → received = Σ 有符号 sale_payment_item_receipts.amount per item；
  //      退款 receipt 为负数，天然得到净额，不再额外扣 note.items[]。
  //   B. 无完整 receipt（历史订单 / 数据修复）→ 回退旧瀑布，再按 note.items[] 扣退款，避免 received 被置零。
  // 与三端 cloudfunction 副本字节同义。
  const covRes = await tx.execute(sql`
    SELECT COALESCE((
             SELECT SUM(cov_spir.amount::numeric)
               FROM sale_payment_item_receipts cov_spir
               JOIN sale_order_payments sop ON sop.id = cov_spir.sale_payment_id
              WHERE cov_spir.sale_order_id = ${saleOrderId}
                AND sop.status = '已支付'
                AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
           ), 0) AS receipt_positive_total,
           (SELECT received::numeric FROM sale_orders WHERE sale_order_id = ${saleOrderId}) AS order_received
  `)
  // tx.execute() 走 drizzle-orm/postgres-js，返回 postgres.js RowList（array-like，带 .count，无 .rows）。
  // 须按数组解包（同 payment-allocatable.ts / points-settle.ts 惯例）。
  const covRows = covRes as unknown as Array<{ receipt_positive_total: string; order_received: string }>
  const receiptPositiveTotal = Number(covRows[0]?.receipt_positive_total || 0)
  const orderReceived = Number(covRows[0]?.order_received || 0)
  // 仅正向 receipt 总额 >= order_received（容差 0.01）→ receipt 完整覆盖，Branch A 安全；
  // 否则 receipt 不完整（历史部分支付订单仅新付款有 receipt），Branch B 保护旧 received 不被清零。
  const hasReceipts = receiptPositiveTotal > 0 && receiptPositiveTotal >= orderReceived - 0.01
  if (hasReceipts) {
    // 分支 A：received = Σ receipt.amount per item（包含退款负数）
    await tx.execute(sql`
      UPDATE sale_items si
      SET received = COALESCE(GREATEST(0, (
        SELECT SUM(spir.amount::numeric) FROM sale_payment_item_receipts spir
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
         WHERE spir.sale_order_id = ${saleOrderId} AND spir.sale_item_id = si.sale_item_id
           AND sop.status = '已支付'
           AND sop.change_type IN ('首次支付','回款','储值卡抵扣','退款')
      )), 0),
      updated_at = NOW()
      WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
    `)
  } else {
    // 分支 B：回退瀑布（无完整 receipt 的历史/异常单，零回归）
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

    // STEP 1.5：回退分支没有完整正向 receipt 覆盖，须按 note.items[].refundAmount 扣减。
    // 分支 A 已由负数 receipt 得到净额，故不在 A 中执行本扣减。
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
  }

  // STEP 1.6：转换单转入价值随旧卡折抵 + 实际到账逐步解锁，禁止部分付款提前释放全部次数。
  await tx.execute(sql`
    WITH conversion_order AS (
      SELECT so.sale_order_type,
             GREATEST(0, so.received::numeric - so.refunded_amount::numeric) AS net_received,
             COALESCE((
               SELECT SUM(GREATEST(0, -out_item.received::numeric))
               FROM sale_items out_item
               WHERE out_item.sale_order_id = ${saleOrderId} AND out_item.item_direction = '转出'
             ), 0)::numeric AS converted_value,
             COALESCE((
               SELECT SUM(in_item.sale_amount::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = ${saleOrderId} AND in_item.item_direction = '转入'
                 AND in_item.sale_amount::numeric > 0
             ), 0)::numeric AS in_total
      FROM sale_orders so
      WHERE so.sale_order_id = ${saleOrderId}
    ),
    ranked AS (
      SELECT si.sale_item_id,
             si.sale_amount::numeric AS item_sale_amount,
             conversion_order.in_total,
             LEAST(conversion_order.in_total,
                   conversion_order.converted_value + conversion_order.net_received) AS target_received,
             ROW_NUMBER() OVER (ORDER BY si.sale_item_id) AS rn,
             COUNT(*) OVER () AS item_count
      FROM sale_items si
      CROSS JOIN conversion_order
      WHERE conversion_order.sale_order_type = '转换单'
        AND si.sale_order_id = ${saleOrderId}
        AND si.item_direction = '转入'
        AND si.sale_amount::numeric > 0
    ),
    provisional AS (
      SELECT ranked.*,
             ROUND(target_received * item_sale_amount / in_total, 2) AS provisional_received
      FROM ranked
      WHERE in_total > 0
    ),
    allocated AS (
      SELECT sale_item_id,
             CASE WHEN rn = item_count
                    THEN target_received - COALESCE(SUM(provisional_received) FILTER (WHERE rn < item_count) OVER (), 0)
                  ELSE provisional_received
             END::numeric(10, 2) AS item_received
      FROM provisional
    )
    UPDATE sale_items si
    SET received = allocated.item_received,
        updated_at = NOW()
    FROM allocated
    WHERE si.sale_item_id = allocated.sale_item_id
  `)

  // STEP 1.75：received 已成为最终有符号净额，用累计边界差分摊 actual 储值卡/现金通道。
  await tx.execute(sql`
    WITH order_amounts AS (
      SELECT prepaid_card_amount::numeric AS prepaid_total
      FROM sale_orders
      WHERE sale_order_id = ${saleOrderId}
    ),
    ranked AS (
      SELECT si.sale_item_id,
             si.received::numeric AS item_received,
             oa.prepaid_total,
             SUM(si.received::numeric) OVER () AS received_total,
             SUM(si.received::numeric) OVER (
               ORDER BY si.sale_item_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_received
      FROM sale_items si
      CROSS JOIN order_amounts oa
      WHERE si.sale_order_id = ${saleOrderId} AND si.received::numeric <> 0
    ),
    allocated AS (
      SELECT sale_item_id,
             (
               ROUND(prepaid_total * cumulative_received / received_total, 2)
               - ROUND(prepaid_total * (cumulative_received - item_received) / received_total, 2)
             )::numeric(10, 2) AS prepaid_share
      FROM ranked
      WHERE received_total <> 0 AND prepaid_total <> 0
    ),
    targets AS (
      SELECT si.sale_item_id, COALESCE(allocated.prepaid_share, 0)::numeric(10, 2) AS prepaid_share
      FROM sale_items si
      LEFT JOIN allocated ON allocated.sale_item_id = si.sale_item_id
      WHERE si.sale_order_id = ${saleOrderId}
    )
    UPDATE sale_items si
    SET prepaid_card_received = targets.prepaid_share,
        updated_at = NOW()
    FROM targets
    WHERE si.sale_item_id = targets.sale_item_id
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
  // STEP 2.5：0 元 item 若已随退款全退，覆盖 paid_sessions=0（否则 sale_amount<=0 兜底会保留满次数）
  await tx.execute(sql`
    WITH full_refund_zero_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = ${saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付'
        AND LOWER(COALESCE(elem ->> 'isFullItemRefund', 'false')) = 'true'
    )
    UPDATE sale_items si
    SET paid_sessions = 0,
        updated_at = NOW()
    WHERE si.sale_order_id = ${saleOrderId}
      AND si.item_direction = '购买'
      AND si.session_count IS NOT NULL
      AND si.sale_amount <= 0
      AND EXISTS (
        SELECT 1 FROM full_refund_zero_items fri WHERE fri.sale_item_id = si.sale_item_id
      )
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
