
import { sql } from 'drizzle-orm'
import { db } from '@/db'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]



export const ORDER_TYPES_EARN_POINTS = new Set(['销售单'])

export interface SettleResult {
  delta: number
  expected: number
  granted: number
  skipped?: string
  error?: string
}


export async function settlePointsForOrder(
  tx: AdminTx,
  originalSaleOrderId: string,
): Promise<SettleResult> {
  if (!originalSaleOrderId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'no-original-id' }
  }

  
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

  
  
  
  const sumRes = await tx.execute(sql`
    SELECT COALESCE(SUM(COALESCE(received,0) - COALESCE(refunded_amount,0)), 0)::numeric AS net_settled
      FROM sale_orders
     WHERE sale_order_id = ${originalSaleOrderId}
        OR ref_sale_order_id = ${originalSaleOrderId}
  `)
  const sumRows = sumRes as unknown as Array<{ net_settled: string | number }>
  const netSettled = Number(sumRows[0]?.net_settled ?? 0)

  
  const expected = Math.floor(Math.max(0, netSettled) / 100)

  
  const grantedRes = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::int AS granted
      FROM point_transactions
     WHERE ref_order_id = ${originalSaleOrderId}
  `)
  const grantedRows = grantedRes as unknown as Array<{ granted: string | number }>
  const granted = Number(grantedRows[0]?.granted ?? 0)

  
  const delta = expected - granted
  if (delta === 0) {
    return { delta: 0, expected, granted }
  }

  const type = delta > 0 ? '消费赠送' : '消费冲销'
  
  
  
  await tx.execute(sql`
    INSERT INTO point_transactions (user_id, type, amount, ref_order_id, created_at)
    VALUES (${userId}, ${type}, ${delta}, ${originalSaleOrderId}, NOW())
    ON CONFLICT (user_id, ref_order_id, type)
      WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
    DO UPDATE SET amount = point_transactions.amount + EXCLUDED.amount,
                  created_at = NOW()
  `)
  await tx.execute(sql`
    UPDATE client_wechat_users
       SET points_balance    = COALESCE(points_balance, 0) + ${delta},
           points_updated_at = NOW()
     WHERE user_id = ${userId}
  `)

  return { delta, expected, granted }
}


export async function settlePointsSafe(
  tx: AdminTx,
  originalSaleOrderId: string,
  triggerSource: string,
): Promise<SettleResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { delta: 0, expected: 0, granted: 0, skipped: 'feature-flag-disabled' }
  }
  try {
    
    
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
