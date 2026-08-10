import { sql } from 'drizzle-orm'
import { db } from '@/db'

export const POINTS_EXPIRY_DAYS = 365

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = Pick<AdminTx, 'execute'>

export interface GrantPointBatchInput {
  userId: string
  pointTransactionId: number
  type: string
  amount: number
  refOrderId?: string | null
}

export interface ConsumePointBatchInput {
  userId: string
  amount: number
  refOrderId?: string | null
}

export async function grantPointBatch(
  tx: Executor,
  input: GrantPointBatchInput,
): Promise<void> {
  if (!input.amount || input.amount <= 0) return

  await tx.execute(sql`
    INSERT INTO point_batches (
      user_id,
      source_transaction_id,
      source_type,
      ref_order_id,
      original_amount,
      remaining_amount,
      earned_at,
      expire_at,
      created_at,
      updated_at
    )
    SELECT
      ${input.userId},
      ${input.pointTransactionId},
      ${input.type},
      ${input.refOrderId ?? null},
      ${input.amount},
      ${input.amount},
      pt.created_at,
      pt.created_at + INTERVAL '365 days',
      NOW(),
      NOW()
    FROM point_transactions pt
    WHERE pt.id = ${input.pointTransactionId}
  `)
}

export async function consumePointBatches(
  tx: Executor,
  input: ConsumePointBatchInput,
): Promise<void> {
  const amount = Math.abs(input.amount)
  if (!amount) return

  await tx.execute(sql`
    WITH locked_batches AS (
      SELECT
        id,
        ref_order_id,
        expire_at,
        remaining_amount
      FROM point_batches
      WHERE user_id = ${input.userId}
        AND remaining_amount > 0
        AND expire_at > NOW()
      ORDER BY
        CASE
          WHEN ${input.refOrderId ?? null} IS NOT NULL
               AND ref_order_id = ${input.refOrderId ?? null}
            THEN 0
          ELSE 1
        END,
        expire_at,
        id
      FOR UPDATE
    ),
    prioritized AS (
      SELECT
        id,
        remaining_amount,
        SUM(remaining_amount) OVER (
          ORDER BY
            CASE
              WHEN ${input.refOrderId ?? null} IS NOT NULL
                   AND ref_order_id = ${input.refOrderId ?? null}
                THEN 0
              ELSE 1
            END,
            expire_at,
            id
        ) AS running
      FROM locked_batches
    ),
    allocation AS (
      SELECT
        id,
        LEAST(
          remaining_amount,
          GREATEST(0, ${amount} - (running - remaining_amount))
        ) AS consume_amount
      FROM prioritized
      WHERE running - remaining_amount < ${amount}
    )
    UPDATE point_batches pb
       SET remaining_amount = pb.remaining_amount - allocation.consume_amount,
           updated_at = NOW()
      FROM allocation
     WHERE pb.id = allocation.id
       AND allocation.consume_amount > 0
  `)
}
