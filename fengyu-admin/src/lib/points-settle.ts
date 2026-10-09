import { getPointAccount, conversionSourceQuery, refreshConversionSources } from './conversion-sources'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { consumePointBatches, grantPointBatch } from '@/lib/points-batches'
type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
// 销售单扣除已交接基数；转换单结算本单旧积分责任与新增补款积分。
export const ORDER_TYPES_EARN_POINTS = new Set(['销售单', '转换单'])

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
 * @param originalSaleOrderId     - 当前责任账户 ID（销售单或转换单）；若当前业务触发点是派生单
 *                                  （回款/退款），传对应销售单或转换单 ID
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

  if (saleOrderType === '转换单') await refreshConversionSources(conversionSourceQuery(tx), originalSaleOrderId)
  const { expected, granted } = await getPointAccount(conversionSourceQuery(tx), originalSaleOrderId, saleOrderType)

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
      onlyOrder: saleOrderType === '转换单',
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
