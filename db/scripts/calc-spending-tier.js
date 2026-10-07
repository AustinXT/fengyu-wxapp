#!/usr/bin/env node

/**
 * calc-spending-tier.js — 重算顾客历史消费档位（spending_tier）
 *
 * ⚠️ 已被 cron-worker 取代（2026-05-26）：
 *   fengyu-admin/src/cron/steps/refresh-spending-tier.ts（STEP spendingTier），
 *   每日 03:00 自动跑，随 admin 镜像部署。本脚本仅留作一次性手动补数兜底。
 *
 * 用法：
 *   node scripts/calc-spending-tier.js              # 执行更新
 *   node scripts/calc-spending-tier.js --dry-run     # 预览（不写入）
 *
 * 业务口径：
 *   spending_tier = 顾客**累计（终身）消费额**分档，对所有顾客都有值（默认 '<1990'）。
 *   消费额口径对齐 clientApi/utils/member-level.js（权威）：
 *     净额 = SUM(GREATEST(received - refunded_amount, 0))
 *            FILTER (WHERE sale_order_type IN ('销售单','转换单'))。
 *   **与 member_level 的两点区别**：
 *     1. member_level 限滚动 12 个月（paid_at >= NOW()-12m）；spending_tier 是终身累计，
 *        **不加时间过滤**——这样 WorkFine 同步的历史已完成单（paid_at 全为 NULL）也计入，
 *        正符合「历史消费档位」语义。
 *     2. spending_tier 最低非 '<1990' 档下界取枚举字面量 1990。（member_level 自 #545 起
 *        下限为「初钻」、不再引用 new_member_threshold，两者的下界口径已解耦。）
 *
 *   分档阈值（上四档下界 1w/3w/6w/10w 与 member_level 数值一致；最低非 '<1990' 档下界固定 1990，
 *   与 member_level 已解耦 —— #545 起会员客等级下限为初钻，不再引用 new_member_threshold）：
 *     >= 100000 → '10W+'
 *     >= 60000  → '6-10W'
 *     >= 30000  → '3-6W'
 *     >= 10000  → '1-3W'
 *     >= 1990   → '1990-1W'
 *     其余      → '<1990'（含无任何已支付订单的顾客）
 *
 * 幂等、可重入：仅更新档位发生变化的行（IS DISTINCT FROM），避免无谓 updated_at churn。
 * 每次全量重新计算。
 */

function retainedRefundFeeSql(orderExpression, itemExpression = null, includeDeduction = false, excludePaymentExpression = null) {
  for (const expr of [orderExpression, itemExpression, excludePaymentExpression].filter(Boolean)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(expr)) throw new Error('INVALID_PARAMS: 非法退款余额引用')
  }
  const modern = `COALESCE((SELECT SUM(GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'handlingFee'), 0))
    ${includeDeduction ? "+ GREATEST(0, COALESCE(public.try_numeric(rfi ->> 'overdraftDeduction'), 0))" : ''})
    FROM sale_order_payments rfp CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(rfp.note) -> 'items') = 'array'
      THEN public.try_jsonb(rfp.note) -> 'items' ELSE '[]'::jsonb END) rfi
    WHERE rfp.sale_order_id = ${orderExpression} AND rfp.status = '已支付' AND rfp.change_type = '退款'
      AND public.try_numeric(public.try_jsonb(rfp.note) ->> 'refundAccountingVersion') = 2
      ${excludePaymentExpression ? `AND rfp.id <> ${excludePaymentExpression}` : ''}
      ${itemExpression ? `AND rfi ->> 'refSaleItemId' = ${itemExpression}` : ''}), 0)`
  // 旧审批按毛额冲销商品receipt，权益侧已扣手续费；订单消费口径仍须扣其明确的顶层手续费。
  if (itemExpression) return modern
  return `(${modern} + COALESCE((SELECT SUM(GREATEST(0, COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'handlingFee'), 0))
    ${includeDeduction ? "+ GREATEST(0, COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'overdraftDeduction'), 0))" : ''})
    FROM sale_order_payments rfp
    WHERE rfp.sale_order_id = ${orderExpression} AND rfp.status = '已支付' AND rfp.change_type = '退款'
      AND COALESCE(public.try_numeric(public.try_jsonb(rfp.note) ->> 'refundAccountingVersion'), 0) <> 2
      ${excludePaymentExpression ? `AND rfp.id <> ${excludePaymentExpression}` : ''}), 0))`
}

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[SPENDING-TIER] ${new Date().toISOString()} ${msg}`)
}

// 全量重算：累计 paid_amount → 档位，仅写变更行
const UPDATE_SQL = `
WITH spend AS (
  SELECT u.user_id,
         COALESCE(SUM(GREATEST((o.received::numeric) - (o.refunded_amount::numeric) - ${retainedRefundFeeSql('o.sale_order_id')}, 0)) FILTER (
                    WHERE o.sale_order_type IN ('销售单', '转换单')
                  ), 0) AS total
    FROM client_wechat_users u
    LEFT JOIN sale_orders o
      ON o.client_user_id = u.user_id
   GROUP BY u.user_id
),
tiered AS (
  SELECT user_id,
         (CASE
            WHEN total >= 100000 THEN '10W+'
            WHEN total >= 60000  THEN '6-10W'
            WHEN total >= 30000  THEN '3-6W'
            WHEN total >= 10000  THEN '1-3W'
            WHEN total >= 1990   THEN '1990-1W'
            ELSE '<1990'
          END)::spending_tier AS tier
    FROM spend
)
UPDATE client_wechat_users u
   SET spending_tier = t.tier,
       updated_at = NOW()
  FROM tiered t
 WHERE u.user_id = t.user_id
   AND u.spending_tier IS DISTINCT FROM t.tier
`

const STATS_SQL = `
SELECT spending_tier, COUNT(*) AS cnt
FROM client_wechat_users
GROUP BY spending_tier
ORDER BY spending_tier
`

async function main() {
  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const { rowCount: updatedCount } = await client.query(UPDATE_SQL)
    log(`spending_tier 已更新（仅变更行）: ${updatedCount}`)

    // 输出分布
    const { rows: stats } = await client.query(STATS_SQL)
    log('--- 档位分布 ---')
    for (const r of stats) {
      log(`  ${r.spending_tier}: ${r.cnt}`)
    }

    if (dryRun) {
      await client.query('ROLLBACK')
      log('DRY RUN: 已回滚')
    } else {
      await client.query('COMMIT')
      log('已提交')
    }
  } catch (err) {
    await client.query('ROLLBACK')
    log(`ERROR: ${err.message}`)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
