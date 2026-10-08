/** #545（推翻 #257）：每日按 #187 单笔非体验毛实收判定，但只升不降（目标 = max(现值, 计算值)）；首次入会归因仍按既有首笔达标单；降档仅由退款审批通道的即时重算产生。 */
import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { rowsAffected } from '@/lib/pg-rows'

type Executor = Pick<Db, 'execute'>
export const CUSTOMER_TYPE_THRESHOLD_UNAVAILABLE = 'INVALID_STATE: 会员门槛配置不可用，停止顾客分类重算'

// 降级不使用缓存/默认阈值；配置不可用时本步骤拒绝写入。
export async function getCustomerTypeThreshold(db: Executor): Promise<number> {
  const rows = await db.execute(sql`SELECT value FROM system_configs WHERE key = 'new_member_threshold'`) as unknown as Array<{ value: string }>
  const raw = rows[0]?.value
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(value) || value <= 0) throw new Error(CUSTOMER_TYPE_THRESHOLD_UNAVAILABLE)
  return value
}

// 本端独立副本；与db离线真实SQL的判定CTE保持相同口径，由snapshot与临时PG守护。
export const CUSTOMER_TYPE_AMOUNTS_SQL = `WITH membership_settings AS (
  SELECT NULL::text AS client_user_id, (SELECT v FROM threshold)::numeric AS threshold
), membership_scope AS (
  SELECT o.* FROM sale_orders o CROSS JOIN membership_settings cfg
  WHERE (cfg.client_user_id IS NULL OR o.client_user_id = cfg.client_user_id)
    AND o.client_user_id IS NOT NULL
    AND o.status IN ('部分支付', '已支付', '已完成')
    AND o.sale_order_type IN ('销售单', '转换单')
), refund_by_item AS (
  SELECT sop.sale_order_id, elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0)) AS refunded
  FROM sale_order_payments sop
  JOIN membership_scope o ON o.sale_order_id = sop.sale_order_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
         THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END
  ) elem
  WHERE o.sale_order_type = '销售单' AND sop.change_type = '退款'
    AND sop.status = '已支付' AND elem ->> 'refSaleItemId' <> 'OVERPAY'
  GROUP BY 1, 2
), membership_sales AS (
  -- #187：销售单继续按行净额加退款、成交额封顶；无明细历史单保留原回退。
  SELECT o.sale_order_id,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_order_id = o.sale_order_id)
              THEN GREATEST(o.received::numeric, 0)
              ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(r.refunded, 0), si.sale_amount::numeric))
                            FILTER (WHERE si.is_experience = false), 0) END AS non_trial,
         COALESCE(SUM(LEAST(si.received::numeric + COALESCE(r.refunded, 0), si.sale_amount::numeric))
                  FILTER (WHERE si.is_experience = true), 0) AS trial
  FROM membership_scope o
  LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id AND si.item_direction = '购买'
  LEFT JOIN refund_by_item r ON r.sale_order_id = o.sale_order_id AND r.sale_item_id = si.sale_item_id
  WHERE o.sale_order_type = '销售单'
  GROUP BY o.sale_order_id, o.received
), membership_receipts AS (
  -- 同场现金+卡的 receipt 已含实际扣卡；只读 receipt 一次，不再另加款项金额。
  SELECT o.sale_order_id, p.id AS payment_id, p.paid_at, r.sale_item_id, r.amount::numeric
  FROM membership_scope o
  JOIN sale_order_payments p ON p.sale_order_id = o.sale_order_id
  JOIN sale_payment_item_receipts r ON r.sale_payment_id = p.id AND r.sale_order_id = o.sale_order_id
  WHERE p.status = '已支付' AND p.change_type IN ('首次支付','回款','储值卡抵扣')
  /* membership-receipt-preview */
), membership_receipt_rows AS (
  SELECT r.*, si.sale_amount::numeric AS cap, si.is_experience, si.item_direction, o.sale_order_type,
         SUM(r.amount) OVER (PARTITION BY r.sale_order_id, r.payment_id) AS event_total,
         SUM(GREATEST(-r.amount, 0)) FILTER (WHERE si.item_direction = '转出')
           OVER (PARTITION BY r.sale_order_id, r.payment_id) AS old_assets,
         SUM(GREATEST(r.amount, 0)) FILTER (WHERE si.item_direction = '转入')
           OVER (PARTITION BY r.sale_order_id, r.payment_id) AS in_total,
         SUM(CASE WHEN si.item_direction = '转入' THEN GREATEST(r.amount, 0) ELSE 0 END)
           OVER (PARTITION BY r.sale_order_id, r.payment_id ORDER BY r.sale_item_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS in_cumulative
  FROM membership_receipts r
  JOIN membership_scope o ON o.sale_order_id = r.sale_order_id
  JOIN sale_items si ON si.sale_item_id = r.sale_item_id AND si.sale_order_id = r.sale_order_id
), membership_normalized AS (
  -- 旧 signed receipt：新增实收按转入权重拆分；旧资产的体验属性不能污染新收款。
  -- 新增量 receipt 保留有符号分币差；不改写历史 receipt/分配/资产。
  SELECT r.*,
         CASE WHEN sale_order_type = '转换单' AND old_assets > 0
              THEN ROUND(GREATEST(event_total, 0) * in_cumulative / NULLIF(in_total, 0), 2)
                 - ROUND(GREATEST(event_total, 0) * (in_cumulative - GREATEST(amount, 0)) / NULLIF(in_total, 0), 2)
              ELSE amount END AS new_receipt
  FROM membership_receipt_rows r
  WHERE (sale_order_type = '销售单' AND item_direction = '购买')
     OR (sale_order_type = '转换单' AND item_direction = '转入')
), membership_item_running AS (
  SELECT r.*,
         LEAST(GREATEST(cap, 0), GREATEST(0, SUM(COALESCE(new_receipt, 0)) OVER (
           PARTITION BY sale_order_id, sale_item_id ORDER BY paid_at ASC NULLS LAST, payment_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))) AS item_gross
  FROM membership_normalized r
), membership_item_deltas AS (
  SELECT r.*, item_gross - LAG(item_gross, 1, 0::numeric) OVER (
    PARTITION BY sale_order_id, sale_item_id ORDER BY paid_at ASC NULLS LAST, payment_id) AS delta
  FROM membership_item_running r
), membership_events AS (
  SELECT sale_order_id, payment_id, paid_at,
         COALESCE(SUM(delta) FILTER (WHERE is_experience = false), 0) AS non_trial,
         COALESCE(SUM(delta) FILTER (WHERE is_experience = true), 0) AS trial
  FROM membership_item_deltas GROUP BY sale_order_id, payment_id, paid_at
), membership_timeline AS (
  SELECT sale_order_id, payment_id, paid_at,
         SUM(non_trial) OVER (PARTITION BY sale_order_id ORDER BY paid_at ASC NULLS LAST, payment_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS non_trial
  FROM membership_events
), membership_receipt_totals AS (
  SELECT sale_order_id, SUM(amount) AS gross FROM membership_receipts GROUP BY sale_order_id
), membership_event_totals AS (
  SELECT sale_order_id, SUM(non_trial) AS non_trial, SUM(trial) AS trial
  FROM membership_events GROUP BY sale_order_id
), membership_amounts AS (
  SELECT o.sale_order_id, o.client_user_id, o.paid_at, o.created_at, o.status, o.sale_order_type,
         CASE WHEN o.sale_order_type = '销售单' THEN s.non_trial
              WHEN r.gross <= o.received::numeric + 0.01 THEN COALESCE(e.non_trial, 0) ELSE 0 END AS non_trial,
         CASE WHEN o.sale_order_type = '销售单' THEN s.trial
              WHEN r.gross <= o.received::numeric + 0.01 THEN COALESCE(e.trial, 0) ELSE 0 END AS trial,
         ABS(COALESCE(r.gross, 0) - o.received::numeric) <= 0.01 AS receipts_complete,
         r.gross IS NOT NULL AS has_receipts
  FROM membership_scope o
  LEFT JOIN membership_sales s ON s.sale_order_id = o.sale_order_id
  LEFT JOIN membership_receipt_totals r ON r.sale_order_id = o.sale_order_id
  LEFT JOIN membership_event_totals e ON e.sale_order_id = o.sale_order_id
), order_amounts AS (
  SELECT a.*,
         CASE WHEN a.non_trial >= cfg.threshold THEN
           COALESCE(
             (SELECT MIN(t.paid_at) FROM membership_timeline t
               WHERE t.sale_order_id = a.sale_order_id AND t.non_trial >= cfg.threshold
                 AND a.receipts_complete),
             CASE WHEN NOT a.has_receipts AND a.sale_order_type = '销售单'
                        AND a.status IN ('已支付','已完成')
                  THEN COALESCE(a.paid_at, a.created_at) END
           ) END AS qualified_at
  FROM membership_amounts a CROSS JOIN membership_settings cfg
)`

/**
 * 顾客档位序（只升不降的比较基准）：流量客 < 体验客 < 小美客 < 会员客。
 * 与 db 离线脚本的 `TYPE_RANK_CASE` 及实时四端 UPDATE 的 `< (CASE $2 …)` 守卫同序，
 * 一致性由 staffApi `__tests__/routes/recalc-customer-type-sql.test.js` 守护。
 * 列名取自本文件内的闭合联合类型，不构成注入面。
 */
const CUSTOMER_TYPE_RANK_CASE = (column: 'old_type' | 'computed_type') => sql.raw(`
  CASE ${column}
    WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
    WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
  END
`)

export function customerTypeBatchSql(threshold: number) {
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('INVALID_PARAMS: 会员门槛必须为正数')
  return sql`
    WITH threshold AS (SELECT ${threshold}::numeric AS v),
    ${sql.raw(CUSTOMER_TYPE_AMOUNTS_SQL.replace(/^WITH /, ''))},
    classified AS (
      SELECT u.user_id, u.customer_type AS old_type, q.sale_order_id AS first_qualified_order, q.first_qualified_at,
             CASE
               WHEN q.sale_order_id IS NOT NULL THEN '会员客'
               WHEN EXISTS (SELECT 1 FROM order_amounts oa WHERE oa.client_user_id = u.user_id AND oa.non_trial > 0) THEN '小美客'
               WHEN EXISTS (SELECT 1 FROM order_amounts oa WHERE oa.client_user_id = u.user_id AND oa.trial > 0) THEN '体验客'
               ELSE '流量客'
             END::customer_type AS computed_type
        FROM client_wechat_users u
        LEFT JOIN LATERAL (
          SELECT oa.sale_order_id, oa.qualified_at AS first_qualified_at
            FROM order_amounts oa
           WHERE oa.client_user_id = u.user_id AND oa.non_trial >= ${threshold}
           ORDER BY oa.qualified_at ASC NULLS LAST, oa.sale_order_id ASC LIMIT 1
        ) q ON true
       WHERE u.name IS DISTINCT FROM '谢廷(测试)'
    ),
    monotonic AS (
      -- #545（推翻 #257）：只升不降 —— 目标档位 = max(现值, 计算值)，档位序
      -- 流量客 < 体验客 < 小美客 < 会员客。口径/算法修正导致的降档不生效；
      -- 「已退款订单抹掉达标贡献」由退款审批通道即时重算承担，不在本步骤降档。
      --
      -- 写成「计算值严格高于现值才升级」而非「现值 >= 计算值就保留」：后者在 rank 为
      -- NULL（未知档位）时落 ELSE、静默按低档降级；本写法比较结果为 NULL → 保留现值，
      -- fail closed。当前是闭合 4 值 enum、rank 不可能为 NULL，这是给「将来加第 5 档」
      -- 留的安全方向（与 db/scripts/recalc-all-customer-types.js 同口径）。
      SELECT user_id, old_type, first_qualified_order, first_qualified_at,
             CASE
               WHEN (${CUSTOMER_TYPE_RANK_CASE('computed_type')})
                 > (${CUSTOMER_TYPE_RANK_CASE('old_type')})
                 THEN computed_type
               ELSE old_type
             END::customer_type AS new_type
        FROM classified
    ),
    flagged_orders AS (
      -- 标记和分类在同一事务提交；RETURNING依赖不构成其他写入方的全局锁序协议。
      UPDATE sale_orders o SET is_membership_upgrade = true
        FROM monotonic c
       WHERE o.sale_order_id = c.first_qualified_order AND c.new_type = '会员客'
         AND c.old_type IS DISTINCT FROM c.new_type
         AND o.is_membership_upgrade IS DISTINCT FROM true
      RETURNING o.sale_order_id
    )
    UPDATE client_wechat_users u SET customer_type = c.new_type,
      became_member_at = CASE WHEN c.new_type = '会员客' THEN COALESCE(u.became_member_at, c.first_qualified_at) ELSE u.became_member_at END,
      updated_at = NOW()
      FROM monotonic c
     WHERE u.user_id = c.user_id AND u.name IS DISTINCT FROM '谢廷(测试)'
       AND u.customer_type IS DISTINCT FROM c.new_type
       AND (SELECT count(*) FROM flagged_orders) >= 0
  `
}

export async function refreshCustomerTypes(db: Db): Promise<{ updated: number }> {
  return db.transaction(async tx => {
    const threshold = await getCustomerTypeThreshold(tx)
    return { updated: rowsAffected(await tx.execute(customerTypeBatchSql(threshold))) }
  }, { isolationLevel: 'repeatable read' })
}
