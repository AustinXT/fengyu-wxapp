import { sql } from 'drizzle-orm'
import type { DocumentType } from '@/lib/types'

type DocumentTypeTransaction = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>
}

const DOCUMENT_TYPE_FALLBACK: DocumentType = '售前一次'

/**
 * 在订单创建或首次进入有效支付状态前，按顾客既有达标单次数计算阶段快照。
 * advisory lock 必须独立成一条语句；等待锁后，下一条 SELECT 才能取得新的 READ COMMITTED 快照。
 */
export async function classifySaleOrderDocumentType(
  tx: DocumentTypeTransaction,
  clientUserId: string | null | undefined,
  saleOrderId: string,
): Promise<DocumentType> {
  if (!clientUserId) return DOCUMENT_TYPE_FALLBACK

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${'document-type:' + clientUserId})::bigint)
  `)

  const result = await tx.execute(sql`
    WITH cfg AS (
      SELECT COALESCE(
        (SELECT CASE
          WHEN value ~ '^\\s*[0-9]+(\\.[0-9]+)?\\s*$' AND value::numeric > 0 THEN value::numeric
          ELSE 1980::numeric
        END FROM system_configs WHERE key = 'new_member_threshold' LIMIT 1),
        1980::numeric
      ) AS threshold
    ), prior_hits AS (
      SELECT COUNT(*)::integer AS hit_count
      FROM sale_orders o CROSS JOIN cfg
      WHERE o.client_user_id = ${clientUserId}
        AND o.sale_order_id <> ${saleOrderId}
        AND o.status IN ('部分支付', '已支付', '已完成')
        AND (
          (o.sale_order_type = '销售单'
            AND GREATEST(o.received::numeric - o.refunded_amount::numeric, 0) >= cfg.threshold)
          OR
          (o.sale_order_type = '转换单'
            AND GREATEST(COALESCE((
              SELECT SUM(CASE
                WHEN sop.change_type IN ('首次支付', '回款') THEN sop.amount
                WHEN sop.change_type = '退款' AND sop.payment_method <> '储值卡' THEN sop.amount
                ELSE 0 END)
              FROM sale_order_payments sop
              WHERE sop.sale_order_id = o.sale_order_id AND sop.status = '已支付'
            ), 0), 0) >= cfg.threshold)
        )
    )
    SELECT CASE
      WHEN hit_count = 0 THEN '售前一次'
      WHEN hit_count = 1 THEN '售前二次'
      ELSE '售后'
    END AS document_type
    FROM prior_hits
  `)
  const row = (result as Array<{ document_type?: DocumentType }>)[0]
  return row?.document_type ?? DOCUMENT_TYPE_FALLBACK
}
