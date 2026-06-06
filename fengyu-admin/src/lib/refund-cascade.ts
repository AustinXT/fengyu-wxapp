/**
 * 退款 5 通道全量回滚（cascadeRefund）
 *
 * 2026-04-26 sale-order-domain-refactor 新建。
 *
 * 在退款审批通过（approveRefund）的同事务内调用，把退款关联的衍生数据全部冲销。
 * 5 个通道（与 ticket §1.5 / §4.2 对齐）：
 *   1. sale_allocations          — 软删（is_void=true / voided_at=NOW）
 *   2. service_commissions       — 软删（is_void=true / voided_at=NOW / voided_reason）
 *   3. user_coupons              — 已用且未过期券恢复未使用
 *   4. point_transactions        — 写反向流水 + 重算 client_wechat_users.points_balance
 *   5. sale_items.picked_up_quantity — 反向恢复（按 sessionCount，不删 pickup_records 历史行）
 *
 * 调用方必须传入完整的事务对象 tx；本函数只在 tx 边界内做 5 通道写入，不开启新事务。
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

export interface CascadeRefundParams {
  /** 被退款的原销售单 ID（对应 sale_orders.sale_order_id） */
  saleOrderId: string
  /** 部分退款时关联的具体 sale_item（来自 saleOrderPayments.refSaleItemId）；NULL = 整单退款 */
  saleItemId: string | null
  /** 退疗程卡时的次数（来自 saleOrderPayments.sessionCount）；NULL 时按 1 处理 */
  sessionCount: number | null
  /** 退款原因；写入 voided_reason 用于审计 */
  refundReason: string
}

export interface CascadeRefundResult {
  voidedAllocations: number
  voidedCommissions: number
  refundedCoupons: number
  reversedPoints: number
  rolledBackPickups: number
}

/**
 * 在事务内级联冲销 5 通道。
 *
 * 设计要点：
 * - 当 saleItemId 不为 null（部分退款）：仅冲销该 sale_item 关联的 sa / sc / pickup 反向
 * - 当 saleItemId 为 null（整单退款）：冲销原单下所有 sale_items 关联的 sa / sc / pickup
 * - user_coupons 与 point_transactions 始终按 saleOrderId 维度处理（券/积分挂在订单上）
 *
 * 所有写入的 voided_reason / note 均包含 refundReason，便于排查。
 */
export async function cascadeRefund(
  tx: TransactionLike,
  params: CascadeRefundParams,
): Promise<CascadeRefundResult> {
  const { saleOrderId, saleItemId, sessionCount } = params
  const reason = `退款审批通过：${params.refundReason ?? ''}`.slice(0, 500)

  // ── 1) sale_allocations 软删 ──────────────────────────────────────
  let voidedAllocations = 0
  {
    const res = saleItemId
      ? await tx.execute(sql`
          UPDATE sale_allocations
             SET is_void = true,
                 voided_at = NOW(),
                 updated_at = NOW()
           WHERE sale_item_id = ${saleItemId}
             AND is_void = false
        `)
      : await tx.execute(sql`
          UPDATE sale_allocations
             SET is_void = true,
                 voided_at = NOW(),
                 updated_at = NOW()
           WHERE sale_item_id IN (
                   SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
                 )
             AND is_void = false
        `)
    voidedAllocations = rowsAffected(res)
  }

  // ── 2) service_commissions 软删（voided_at + voided_reason + is_void） ──
  let voidedCommissions = 0
  {
    const res = saleItemId
      ? await tx.execute(sql`
          UPDATE service_commissions
             SET voided_at = NOW(),
                 voided_reason = ${reason},
                 is_void = true,
                 updated_at = NOW()
           WHERE service_item_id IN (
                   SELECT si.service_item_id
                   FROM service_items si
                   WHERE si.sale_item_id = ${saleItemId}
                 )
             AND voided_at IS NULL
        `)
      : await tx.execute(sql`
          UPDATE service_commissions
             SET voided_at = NOW(),
                 voided_reason = ${reason},
                 is_void = true,
                 updated_at = NOW()
           WHERE service_item_id IN (
                   SELECT si.service_item_id
                   FROM service_items si
                   JOIN sale_items s ON s.sale_item_id = si.sale_item_id
                   WHERE s.sale_order_id = ${saleOrderId}
                 )
             AND voided_at IS NULL
        `)
    voidedCommissions = rowsAffected(res)
  }

  // ── 3) user_coupons 已用且未过期券恢复（部分退款不退券） ──────────
  // 部分退款（saleItemId 非 null）：券挂在订单维度无法精确到行，整单退才退券。
  let refundedCoupons = 0
  if (!saleItemId) {
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

  // ── 4) point_transactions 比例冲销 + client_wechat_users.points_balance 重算 ──
  // 部分退款按"本次累计退款额 / 整单实收"比例冲销赠送积分；整单退款 → refunded=received → 全额冲销。
  let reversedPoints = 0
  {
    // 1) 查整单原赠送总额 G + 归属顾客 user_id（一个订单的赠送都属同一顾客）
    const giftRes = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
      FROM point_transactions
      WHERE ref_order_id = ${saleOrderId}
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0
    `)
    const giftRow = (giftRes as { rows?: Array<{ g: unknown; user_id: unknown }> }).rows?.[0]
    const grantedTotal = Number(giftRow?.g ?? 0)
    const pointUserId = giftRow?.user_id != null ? String(giftRow.user_id) : null

    if (grantedTotal > 0 && pointUserId) {
      // 2) 取整单 received + refunded_amount（approveRefund 已先累加 refunded_amount，含本次）
      const orderRes = await tx.execute(sql`
        SELECT received, COALESCE(refunded_amount, 0) AS refunded
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
      `)
      const orderRow = (orderRes as { rows?: Array<{ received: unknown; refunded: unknown }> }).rows?.[0]
      const received = Number(orderRow?.received ?? 0)
      const refunded = Number(orderRow?.refunded ?? 0)
      // 3) 目标冲销额：按退款占实收比例（received<=0 兜底全冲）；整数积分
      const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
      // 4) 写单笔目标态消费冲销：DO UPDATE 目标态（非 DO NOTHING），解多次部分退款累加单调增长
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
      // 5) 重算该顾客的 client_wechat_users.points_balance（缓存列，权威源是 point_transactions）
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

  // ── 5) sale_items.picked_up_quantity 反向恢复 ─────────────────────
  // 退款不删除 pickup_records 历史行（审计保留），仅按 sessionCount 反向减少 sale_items 累计列。
  // 家居产品：sessionCount 通常 = 退款数量；疗程卡走 remaining_sessions（不在此处理）
  let rolledBackPickups = 0
  {
    const qty = sessionCount && sessionCount > 0 ? sessionCount : 1
    const res = saleItemId
      ? await tx.execute(sql`
          UPDATE sale_items
             SET picked_up_quantity = GREATEST(0, COALESCE(picked_up_quantity, 0) - ${qty}),
                 updated_at = NOW()
           WHERE sale_item_id = ${saleItemId}
             AND product_type = '家居产品'
             AND COALESCE(picked_up_quantity, 0) > 0
        `)
      : await tx.execute(sql`
          UPDATE sale_items
             SET picked_up_quantity = 0,
                 updated_at = NOW()
           WHERE sale_order_id = ${saleOrderId}
             AND product_type = '家居产品'
             AND COALESCE(picked_up_quantity, 0) > 0
        `)
    rolledBackPickups = rowsAffected(res)
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    rolledBackPickups,
  }
}
