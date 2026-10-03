/** #257 C：每日按#187单笔非体验毛实收双向对齐；只修改分类，历史归因留E。 */
import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { rowsAffected } from '@/lib/pg-rows'

type Executor = Pick<Db, 'execute'>

// 降级不使用缓存/默认阈值；配置不可用时本步骤拒绝写入。
export async function getCustomerTypeThreshold(db: Executor): Promise<number> {
  const rows = await db.execute(sql`SELECT value FROM system_configs WHERE key = 'new_member_threshold'`) as unknown as Array<{ value: string }>
  const raw = rows[0]?.value
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(value) || value <= 0) throw new Error('INVALID_STATE: 会员门槛配置不可用，停止顾客分类重算')
  return value
}

// 本端独立副本；与db离线真实SQL的判定CTE保持相同口径，由snapshot与临时PG守护。
export const CUSTOMER_TYPE_AMOUNTS_SQL = `WITH
refund_by_item AS (
  -- note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js RECEIVED_REFUNDED_DEDUCT_SQL：
  -- ① 仅退款+已支付流水；② public.try_jsonb 安全转换（非法 JSON 降级 NULL）；③ jsonb_typeof 兜 items 非数组。
  SELECT sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0)) AS refunded
    FROM sale_order_payments sop
    JOIN sale_orders ro ON ro.sale_order_id = sop.sale_order_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
           THEN public.try_jsonb(sop.note) -> 'items'
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE ro.status IN ('已支付', '已完成')
     AND ro.sale_order_type = '销售单'
     AND sop.change_type = '退款'
     AND sop.status = '已支付'
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
   -- 序号绑定 SELECT 的前 2 列（sale_order_id, refSaleItemId）；重排 SELECT 列须同步改这里
   GROUP BY 1, 2
),
order_amounts AS (
  -- LEAST(…, sale_amount) 封顶：加回 note 原始退款额并非扣减的严格逆运算，
  -- refunded > 实际扣减额时会高估；已结清订单的行级毛额上限就是 sale_amount，故以此封顶，
  -- 把「不可逆误升会员客」压成「最多漏升」（漏升可由后续订单或再跑一次本脚本自愈）。
  -- 无明细行订单（WorkFine 历史单只建 sale_orders）回退订单级 received，全额计入 non_trial。
  SELECT o.sale_order_id, o.client_user_id, o.paid_at, o.created_at,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
              THEN GREATEST(o.received::numeric, 0)
              ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),
                                      si.sale_amount::numeric))
                            FILTER (WHERE si.is_experience = false), 0)
         END AS non_trial,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
              THEN 0
              ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),
                                      si.sale_amount::numeric))
                            FILTER (WHERE si.is_experience = true), 0)
         END AS trial
    FROM sale_orders o
    LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                           AND si.item_direction = '购买'
    LEFT JOIN refund_by_item rbi ON rbi.sale_order_id = o.sale_order_id
                                AND rbi.sale_item_id = si.sale_item_id
    -- 2026-04-26 sale-order-domain-refactor 后，回款下沉到
    -- sale_order_payments.change_type='回款'，sale_order_type 枚举已不含“回款单”。
   WHERE o.status IN ('已支付', '已完成')
     AND o.sale_order_type = '销售单'
     AND o.client_user_id IS NOT NULL
   GROUP BY o.sale_order_id, o.client_user_id, o.paid_at, o.created_at, o.received
)
`

export function customerTypeBatchSql(threshold: number) {
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('INVALID_PARAMS: 会员门槛必须为正数')
  return sql`
    ${sql.raw(CUSTOMER_TYPE_AMOUNTS_SQL)},
    classified AS (
      SELECT u.user_id,
             CASE
               WHEN EXISTS (SELECT 1 FROM order_amounts oa WHERE oa.client_user_id = u.user_id AND oa.non_trial >= ${threshold}) THEN '会员客'
               WHEN EXISTS (SELECT 1 FROM order_amounts oa WHERE oa.client_user_id = u.user_id AND oa.non_trial > 0) THEN '小美客'
               WHEN EXISTS (SELECT 1 FROM order_amounts oa WHERE oa.client_user_id = u.user_id AND oa.trial > 0) THEN '体验客'
               ELSE '流量客'
             END::customer_type AS new_type
        FROM client_wechat_users u
       WHERE u.name IS DISTINCT FROM '谢廷(测试)'
    )
    UPDATE client_wechat_users u SET customer_type = c.new_type, updated_at = NOW()
      FROM classified c
     WHERE u.user_id = c.user_id AND u.name IS DISTINCT FROM '谢廷(测试)'
       AND u.customer_type IS DISTINCT FROM c.new_type
  `
}

export async function refreshCustomerTypes(db: Db): Promise<{ updated: number }> {
  return db.transaction(async tx => {
    const threshold = await getCustomerTypeThreshold(tx)
    return { updated: rowsAffected(await tx.execute(customerTypeBatchSql(threshold))) }
  })
}
