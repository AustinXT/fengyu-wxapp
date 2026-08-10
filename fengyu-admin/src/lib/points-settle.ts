/**
 * 积分发放工具 — admin 端实现（链净额差值法）
 *
 * 三端独立维护副本之一（与 fengyu-staff/cloudfunctions/staffApi/utils/points.js
 * + fengyu-client/cloudfunctions/clientApi/utils/points.js
 * + fengyu-client/cloudfunctions/payNotify/points.js 算法字节同义）。
 *
 * 修改 SQL 时必须同步另外三端，由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
 * 守护一致性。
 *
 * 触发点（修复 audit-15 P0-15-01）：
 *   - confirmOfflinePayment — 管理后台确认线下收款
 *   - recordPayment         — 管理后台录入回款
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { consumePointBatches, grantPointBatch } from '@/lib/points-batches'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// 参与积分发放的订单类型（决策 D1：内部单不发；回款/转换/退款单不是原始发放点，
// 它们引用的原销售单才发，通过 ref_sale_order_id 传递给 settle）
export const ORDER_TYPES_EARN_POINTS = new Set(['销售单'])

export interface SettleResult {
  delta: number
  expected: number
  granted: number
  skipped?: string
  error?: string
}

/**
 * 结算某条订单链的积分
 *
 * @param tx                      - Drizzle 事务上下文（调用方必须在 db.transaction 内调用）
 * @param originalSaleOrderId     - 原销售单 ID；若当前业务触发点是派生单
 *                                  （回款/退款/转换），传 ref_sale_order_id
 */
export async function settlePointsForOrder(
  tx: AdminTx,
  originalSaleOrderId: string,
): Promise<SettleResult> {
  if (!originalSaleOrderId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'no-original-id' }
  }

  // 1. 取原单顾客归属 + 类型；FOR UPDATE 串行化并发回款/退款
  const origRes = await tx.execute(sql`
    SELECT client_user_id, sale_order_type
      FROM sale_orders
     WHERE sale_order_id = ${originalSaleOrderId}
     FOR UPDATE
  `)
  const origRows = origRes as unknown as Array<{
    client_user_id: string | null
    sale_order_type: string
  }>
  if (origRows.length === 0) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'order-not-found' }
  }
  const userId = origRows[0].client_user_id
  const saleOrderType = origRows[0].sale_order_type
  if (!userId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'anonymous-order' }
  }
  if (!ORDER_TYPES_EARN_POINTS.has(saleOrderType)) {
    return {
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: `order-type-${saleOrderType}`,
    }
  }

  // 2. 汇总整条订单链的已到账净额（原单 + 全部派生单）
  //    2026-04-26 sale-order-domain-refactor: paid_amount 已 DROP，改用 received - refunded_amount
  //    退款单 refunded_amount 为正，回款单 received 为正；累加得链净额
  const sumRes = await tx.execute(sql`
    SELECT COALESCE(SUM(COALESCE(received,0) - COALESCE(refunded_amount,0)), 0)::numeric AS net_settled
      FROM sale_orders
     WHERE sale_order_id = ${originalSaleOrderId}
        OR ref_sale_order_id = ${originalSaleOrderId}
  `)
  const sumRows = sumRes as unknown as Array<{ net_settled: string | number }>
  const netSettled = Number(sumRows[0]?.net_settled ?? 0)

  // 3. 目标积分（决策 D3：不允许负余额，expected 下界为 0）
  const expected = Math.floor(Math.max(0, netSettled) / 100)

  // 4. 已发积分合计（按 ref_order_id 聚合，等级升级/兑换等非本链流水自然排除）
  const grantedRes = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::bigint AS granted
      FROM point_transactions
     WHERE ref_order_id = ${originalSaleOrderId}
       AND type IN ('消费赠送','消费冲销')
  `)
  const grantedRows = grantedRes as unknown as Array<{ granted: string | number }>
  const granted = Number(grantedRows[0]?.granted ?? 0)

  // 5. 差值判断 — delta=0 天然幂等
  const delta = expected - granted
  if (delta === 0) {
    return { delta: 0, expected, granted }
  }

  const type = delta > 0 ? '消费赠送' : '消费冲销'
  // partial unique uq_point_txn_order_user_type (user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
  // 分次回款/退款累加：同 (user,order,type) 已有行时把增量 delta 累加进唯一行（granted=SUM 口径不变），
  // 避免裸 INSERT 撞唯一索引导致整事务回滚。四端字面同义，由 cross-end-sql-snapshot 守护。
  const inserted = (await tx.execute(sql`
    INSERT INTO point_transactions (user_id, type, amount, ref_order_id, created_at)
    VALUES (${userId}, ${type}, ${delta}, ${originalSaleOrderId}, NOW())
    ON CONFLICT (user_id, ref_order_id, type)
      WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
    DO UPDATE SET amount = point_transactions.amount + EXCLUDED.amount,
                  created_at = NOW()
    RETURNING id
  `)) as unknown as Array<{ id: number }>

  const pointTransactionId = Number(inserted[0]?.id ?? 0)
  if (delta > 0 && pointTransactionId) {
    await grantPointBatch(tx, {
      userId,
      pointTransactionId,
      type,
      amount: delta,
      refOrderId: originalSaleOrderId,
    })
  } else if (delta < 0) {
    await consumePointBatches(tx, {
      userId,
      amount: delta,
      refOrderId: originalSaleOrderId,
    })
  }

  await tx.execute(sql`
    UPDATE client_wechat_users c
       SET points_balance    = COALESCE((
             SELECT SUM(pb.remaining_amount)
             FROM point_batches pb
             WHERE pb.user_id = c.user_id
               AND pb.expire_at > NOW()
           ), 0),
           points_updated_at = NOW()
     WHERE c.user_id = ${userId}
  `)

  return { delta, expected, granted }
}

/**
 * 触发点安全封装：把 settle 失败隔离成 operation_logs 告警
 * 资金状态已写入不应被积分失败回滚（决策：资金正确优先，由 cronTask 兜底重算）
 *
 * @param tx              - Drizzle 事务上下文
 * @param originalSaleOrderId - 原销售单 id
 * @param triggerSource   - 调用方标识，写入日志便于定位（如 'admin.confirmOffline'）
 */
export async function settlePointsSafe(
  tx: AdminTx,
  originalSaleOrderId: string,
  triggerSource: string,
): Promise<SettleResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { delta: 0, expected: 0, granted: 0, skipped: 'feature-flag-disabled' }
  }
  try {
    // SAVEPOINT 真隔离：drizzle 嵌套 transaction = SAVEPOINT，积分发放报错只回滚子事务，
    // 外层资金事务不受影响（决策：资金正确优先，积分失败仅告警，由 cronTask 兜底重算）。
    return await tx.transaction(async (sp) => settlePointsForOrder(sp, originalSaleOrderId))
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    try {
      await tx.execute(sql`
        INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
        VALUES (
          'points.settleFailed',
          'sale_order',
          ${originalSaleOrderId},
          ${JSON.stringify({ error: errMessage, triggerSource })}::jsonb,
          ${triggerSource || 'admin'},
          NOW()
        )
      `)
    } catch {
      // log 写入失败不影响主事务
    }
    return {
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: 'settle-failed',
      error: errMessage,
    }
  }
}
