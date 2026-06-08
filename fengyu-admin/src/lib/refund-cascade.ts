/**
 * 退款级联回滚（cascadeRefund）—— 逐 item + 语义收敛
 *
 * 2026-04-26 sale-order-domain-refactor 新建；2026-06-08 重构（Bug Q/M）：
 *   - 改为按本次退款明细逐 item 级联（params.items），不再用单 saleItemId / null 整单分支；
 *     修复「多项退真子集误走整单分支清掉未退明细的分配/提成/券/提货」（Bug Q）。
 *   - 通道 1/2（分配/提成）仅作废「被全退」的 item（isFullItemRefund），部分次数退款不动二者（Bug M 语义收敛）。
 *   - 通道 3（券）仅整单全退（isWholeOrderRefund）才回滚。
 *
 * 在退款审批通过（approveRefund）的同事务内调用。
 *
 * **修改本文件必须同步 fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js**
 * （独立副本设计，用户 veto cloudfunctions-shared 抽取；漂移由
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * `'SUMMARY v3 §2 #14'` describe 块的 5 通道 keyword 守护捕获）。
 */

import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'

export type TransactionLike = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CascadeRefundItem {
  saleItemId: string
  /** 退疗程卡/家居的数量；NULL 时通道 5 跳过 */
  sessionCount: number | null
  /** 该 item 本次是否被全退（控制通道 1/2 是否作废其分配/提成） */
  isFullItemRefund: boolean
}

export interface CascadeRefundParams {
  /** 被退款的原销售单 ID */
  saleOrderId: string
  /** 本次退款涉及的明细行 */
  items: CascadeRefundItem[]
  /** 是否整单全退（所有购买项全退）→ 控制 user_coupons 回滚 */
  isWholeOrderRefund: boolean
  /** 退款原因；写入 voided_reason */
  refundReason: string
}

export interface CascadeRefundResult {
  voidedAllocations: number
  voidedCommissions: number
  refundedCoupons: number
  reversedPoints: number
  rolledBackPickups: number
}

export async function cascadeRefund(
  tx: TransactionLike,
  params: CascadeRefundParams,
): Promise<CascadeRefundResult> {
  const { saleOrderId, items, isWholeOrderRefund, refundReason } = params
  const reason = `退款审批通过：${refundReason ?? ''}`.slice(0, 500)

  // 兜底：items 为空（老退款行 / 整单退无明细）→ 查所有购买项视为全退（兼容历史数据）
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await tx.execute(sql`
      SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
    `)
    const rows = (r as unknown as Array<{ sale_item_id: string }>) ?? []
    effItems = rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  // 仅「全退」的 item 才作废分配/提成（Bug M 语义收敛）
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  // ── 1) sale_allocations 软删（仅全退 item） ──────────────────────────
  let voidedAllocations = 0
  if (fullItemIds.length > 0) {
    const res = await tx.execute(sql`
      UPDATE sale_allocations
         SET is_void = true,
             voided_at = NOW(),
             updated_at = NOW()
       WHERE sale_item_id = ANY(${fullItemIds})
         AND is_void = false
    `)
    voidedAllocations = rowsAffected(res)
  }

  // ── 2) service_commissions 软删（仅全退 item） ──────────────────────
  let voidedCommissions = 0
  if (fullItemIds.length > 0) {
    const res = await tx.execute(sql`
      UPDATE service_commissions
         SET voided_at = NOW(),
             voided_reason = ${reason},
             is_void = true,
             updated_at = NOW()
       WHERE service_item_id IN (
               SELECT si.service_item_id
               FROM service_items si
               WHERE si.sale_item_id = ANY(${fullItemIds})
             )
         AND voided_at IS NULL
    `)
    voidedCommissions = rowsAffected(res)
  }

  // ── 3) user_coupons 已用且未过期券恢复（仅整单全退） ──────────────
  let refundedCoupons = 0
  if (wholeOrder) {
    const res = await tx.execute(sql`
      UPDATE user_coupons
         SET status = '未使用',
             used_at = NULL,
             used_sale_order_id = NULL,
             updated_at = NOW()
       WHERE used_sale_order_id = ${saleOrderId}
         AND status = '已使用'
         AND expire_at > NOW()
    `)
    refundedCoupons = rowsAffected(res)
  }

  // ── 4) point_transactions 比例冲销 + client_wechat_users.points_balance 重算（订单级） ──
  let reversedPoints = 0
  {
    const giftRes = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
      FROM point_transactions
      WHERE ref_order_id = ${saleOrderId}
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0
    `)
    const giftRow = (giftRes as unknown as Array<{ g: unknown; user_id: unknown }>)[0]
    const grantedTotal = Number(giftRow?.g ?? 0)
    const pointUserId = giftRow?.user_id != null ? String(giftRow.user_id) : null

    if (grantedTotal > 0 && pointUserId) {
      const orderRes = await tx.execute(sql`
        SELECT received, COALESCE(refunded_amount, 0) AS refunded
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
      `)
      const orderRow = (orderRes as unknown as Array<{ received: unknown; refunded: unknown }>)[0]
      const received = Number(orderRow?.received ?? 0)
      const refunded = Number(orderRow?.refunded ?? 0)
      const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
      await tx.execute(sql`
        INSERT INTO point_transactions (
          user_id, ref_order_id, type, amount, created_at
        )
        VALUES (${pointUserId}, ${saleOrderId}, '消费冲销', ${-target}, NOW())
        ON CONFLICT (user_id, ref_order_id, type)
          WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
        DO UPDATE SET amount = EXCLUDED.amount
      `)
      reversedPoints = target
      await tx.execute(sql`
        UPDATE client_wechat_users c
           SET points_balance = COALESCE((
                 SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = c.user_id
               ), 0),
               updated_at = NOW()
         WHERE c.user_id = ${pointUserId}
      `)
    }
  }

  // ── 5) sale_items.picked_up_quantity 反向恢复（逐被退家居 item，按 sessionCount） ──
  // 仅作用于本次被退的 item（Bug Q：不再整单清掉未退 item 的提货账）；sessionCount 为空跳过。
  // 家居提货账与退款的完整厘清（neuter + 已退数量追踪）见 follow-up；当前金额门已封顶防超退。
  let rolledBackPickups = 0
  for (const it of effItems) {
    const qty = it.sessionCount && Number(it.sessionCount) > 0 ? Number(it.sessionCount) : null
    if (!qty) continue
    const res = await tx.execute(sql`
      UPDATE sale_items
         SET picked_up_quantity = GREATEST(0, COALESCE(picked_up_quantity, 0) - ${qty}),
             updated_at = NOW()
       WHERE sale_item_id = ${it.saleItemId}
         AND product_type = '家居产品'
         AND COALESCE(picked_up_quantity, 0) > 0
    `)
    rolledBackPickups += rowsAffected(res)
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    rolledBackPickups,
  }
}
