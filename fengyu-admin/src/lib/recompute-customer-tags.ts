import { retainedRefundFeeSql } from './refund-fee-sql'
/**
 * 单顾客标签重算 helper（legacy 历史订单审核通过时使用）
 *
 * 复用 cron STEP 1/2 的业务口径，但作用域限定到单个 client_user_id：
 *   1. customer_status（cron refresh-customer-status.ts，service_orders 驱动）
 *   2. customer_type（admin orders.ts:137 recalcCustomerType 的 4 端 SQL 之一）
 *   3. spending_tier（admin refunds.ts:1216 refreshSpendingTierTx 的镜像）
 *   4. member_level（cron refresh-member-levels.ts 的 processUpgrade / processDowngrade）
 *
 * 调用方：fengyu-admin/src/actions/legacy-orders.ts approveLegacyOrder
 *
 * 与每日 cron 的关系：本 helper 与 cron 共享 `member-upgrade-${userId}-${toLevel}`
 * 幂等键，即审核通过后 helper 和当晚 03:00 cron 都会跑同一计算，但权益
 * 三件套（消息/积分/优惠券）的 INSERT ON CONFLICT 保证只发一次。
 *
 * SQL 一致性守护：本文件的 customer_type CASE 块加入了 cross-end snapshot 测试
 * （fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js）。
 */

import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { getCustomerTypeThreshold, CUSTOMER_TYPE_THRESHOLD_UNAVAILABLE } from '@/cron/steps/refresh-customer-types'
import { rowsAffected } from '@/lib/pg-rows'
import { getMemberThreshold } from '@/cron/config'
import { loadJsonConfig } from '@/cron/lib/benefits-loader'
import { determineMemberLevel, isUpgrade, isDowngrade } from '@/cron/lib/member-level'
import {
  processUpgrade,
  processDowngrade,
  shouldGrantMemberUpgradeBenefits,
  type BenefitsConfig,
} from '@/cron/steps/refresh-member-levels'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface RecomputeResult {
  customerStatusUpdated: boolean
  customerTypeChanged: { from: string | null; to: string | null } | null
  spendingTierUpdated: boolean
  memberLevelChange: { from: string | null; to: string | null; action: 'upgrade' | 'downgrade' | 'held' } | null
}

/**
 * 段 1：customer_status — 仅会员客有值（流量客/体验客/小美客一律 NULL）。
 *
 * service_orders 驱动；legacy 订单审核通过本身不改 service_orders，
 * 所以本段对单顾客通常 no-op，但保留以保证全套标签一致性。
 */
async function recomputeCustomerStatusForUser(tx: Tx, clientUserId: string): Promise<boolean> {
  await tx.execute(sql`UPDATE client_wechat_users SET customer_status = NULL, updated_at = NOW()
    WHERE user_id = ${clientUserId} AND customer_type IS DISTINCT FROM '会员客'::customer_type
      AND customer_status IS NOT NULL`)
  const res = await tx.execute(sql`
    WITH visit_stats AS (
      SELECT so.client_user_id,
             MAX(so.service_date) AS last_service_date,
             COUNT(DISTINCT so.service_date) AS total_visits,
             COUNT(DISTINCT so.service_date) FILTER (
               WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
             ) AS visits_90d
      FROM service_orders so
      WHERE so.status = '已完成' AND so.client_user_id = ${clientUserId}
      GROUP BY so.client_user_id
    )
    UPDATE client_wechat_users u
       SET customer_status = CASE
             WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
             WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
             WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'::customer_status
             WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
             ELSE '休眠'::customer_status
           END,
           updated_at = NOW()
      FROM visit_stats vs
     WHERE u.user_id = ${clientUserId}
       AND u.user_id = vs.client_user_id
       AND u.customer_type = '会员客'
  `)
  return rowsAffected(res) > 0
}

/**
 * 段 2：customer_type 只升不降（#545，推翻 #257 的双向对齐）。实时四路径同样是只升级。
 *
 * 九处 SQL 镜像副本：五处单客入口 + cron（staffApi order.js + clientApi order.js + payNotify index.js
 * + admin orders.ts + 本 helper）逐字一致，三个 db/scripts 批量脚本（recalc-all-customer-types.js
 * + recalc-became-member-at.js + backfill-membership-upgrade-doc-type.js + admin cron refresh-customer-types.ts）结构对齐。
 * SQL 字面必须与其余八处一致；守护测试：
 * fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js
 */
/**
 * 顾客档位序（只升不降的比较基准）：流量客 < 体验客 < 小美客 < 会员客。
 * 与实时四端 UPDATE、cron `CUSTOMER_TYPE_RANK_CASE`、db 离线脚本 `TYPE_RANK_CASE` 同序。
 * 写成同一个表达式插值两次，避免两侧漂移；`<` 比较在任一侧为 NULL 时不命中，
 * 即未知档位 fail closed（不写）。
 */
const rankCase = (expr: SQL) => sql`
  CASE ${expr}
    WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
    WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
  END
`

/**
 * 顾客分类跃迁的订单级金额 CTE（#187）。产出每张已结清销售单的
 * non_trial / trial = 非体验 / 体验行的毛实收合计（received 净额 + 该行逐项退款额）。
 * refund_by_item 的 note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js
 * RECEIVED_REFUNDED_DEDUCT_SQL，根除 22P02。九处副本逐字一致，由 recalc-customer-type-sql.test.js 守护。
 */
const recalcCustomerTypeCte = (clientUserId: string, threshold: number) => sql`WITH membership_settings AS (
  SELECT ${clientUserId}::text AS client_user_id, ${threshold}::numeric AS threshold
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

async function recomputeCustomerTypeForUser(
  tx: Tx,
  clientUserId: string,
  allowDowngrade = false,
): Promise<{ from: string | null; to: string | null } | null> {
  const curRes = await tx.execute(sql`
    SELECT customer_type FROM client_wechat_users WHERE user_id = ${clientUserId}
       AND name IS DISTINCT FROM '谢廷(测试)' FOR NO KEY UPDATE
  `)
  const curRows = curRes as unknown as Array<{ customer_type: string }>
  const oldType = curRows[0]?.customer_type ?? null
  if (!curRows[0]) return null
  // #545（推翻 #257）：只升不降。会员客是档位顶格，max(现值, 计算值) 恒等于现值，
  // 早退既是最廉价的等价表达，也免掉一次金额 CTE。仅退款通道（allowDowngrade=true）例外。
  if (!allowDowngrade && oldType === '会员客') return null

  let threshold: number
  try {
    threshold = await getCustomerTypeThreshold(tx)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== CUSTOMER_TYPE_THRESHOLD_UNAVAILABLE) throw error
    // 配置无效不做分类写入；保留原审核可用性，待修正配置后每日重算补齐。
    console.warn('[customer-tags] skipped classification: invalid member threshold')
    return null
  }

  // 九处 SQL 镜像副本，修改时必须同步其余八处（staffApi order.js + clientApi order.js + payNotify index.js
  // + admin orders.ts + 本文件 + db/scripts/recalc-all-customer-types.js + db/scripts/recalc-became-member-at.js）；
  // 一致性由 recalc-customer-type-sql.test.js 守护。
  // #187（2026-09-18）：按单笔订单的非体验部分毛实收判定（received 净额 + 逐项退款额），落地 Q5.2 决策。
  const typeRes = await tx.execute(sql`
    ${recalcCustomerTypeCte(clientUserId, threshold)}
    SELECT CASE
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial >= ${threshold}) THEN '会员客'
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial > 0)   THEN '小美客'
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE trial > 0)       THEN '体验客'
       ELSE '流量客'
     END AS computed_type
  `)
  const typeRows = typeRes as unknown as Array<{ computed_type: string }>
  const newType = typeRows[0]?.computed_type
  if (!newType || newType === oldType) return null

  const updRes = await tx.execute(sql`
    UPDATE client_wechat_users
       SET customer_type = ${newType}::customer_type, updated_at = NOW()
     WHERE user_id = ${clientUserId}
       AND name IS DISTINCT FROM '谢廷(测试)'
       AND customer_type IS DISTINCT FROM ${newType}::customer_type
       AND (
         (${rankCase(sql`customer_type`)})
         < (${rankCase(sql`${newType}::customer_type`)})
         -- #545：默认只升不降；仅退款审批通道（allowDowngrade=true）允许降到计算档位。
         OR ${allowDowngrade}::boolean
       )
     RETURNING customer_type
  `)
  const updRowCount = rowsAffected(updRes)
  const updRows = updRes as unknown as Array<{ customer_type: string }>
  if (updRowCount === 0) return null

  if (updRows[0]?.customer_type === '会员客') {
    // became_member_at 记为确立会员资格的首笔订单实际跨阈值时间；
    // 选单子查询与下方 is_membership_upgrade 归因同源、选同一单。
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = COALESCE((
        ${recalcCustomerTypeCte(clientUserId, threshold)}
        SELECT oa.qualified_at FROM sale_orders o
        JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
        WHERE oa.non_trial >= ${threshold}
        ORDER BY oa.qualified_at ASC NULLS LAST, o.sale_order_id ASC
        LIMIT 1
      ), became_member_at) WHERE user_id = ${clientUserId}
    `)
    // 给现行首笔达标订单打会员升级标记（再达标归因仍沿用原规则，E另定）（WHERE 与会员客判定 CASE 同源；九处镜像逐字一致）。
    // 2026-09-18 (#187) 订正：旧注释称「payNotify 端额外含回款单累计分支」已不成立——
    // sale-order-domain-refactor 后该分支即被删除，七处归因段一直是同一口径，现统一为 oa.non_trial >= 阈值。
    await tx.execute(sql`
      UPDATE sale_orders SET is_membership_upgrade = true
      WHERE sale_order_id = (
        ${recalcCustomerTypeCte(clientUserId, threshold)}
        SELECT o.sale_order_id FROM sale_orders o
        JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
        WHERE oa.non_trial >= ${threshold}
        ORDER BY oa.qualified_at ASC NULLS LAST, o.sale_order_id ASC
        LIMIT 1
      )
    `)
  }
  return { from: oldType, to: updRows[0]?.customer_type ?? newType }
}

/**
 * 段 3：spending_tier 重算。
 *
 * 档位边界固定（不随 system_configs.new_member_threshold），所以无需 threshold 入参。
 * SQL 与 fengyu-admin/src/actions/refunds.ts:1216 refreshSpendingTierTx 等价。
 */
async function recomputeSpendingTierForUser(tx: Tx, clientUserId: string): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE client_wechat_users
       SET spending_tier = CASE
         WHEN t.total >= 100000 THEN '10W+'
         WHEN t.total >= 60000  THEN '6-10W'
         WHEN t.total >= 30000  THEN '3-6W'
         WHEN t.total >= 10000  THEN '1-3W'
         WHEN t.total >= 1990   THEN '1990-1W'
         ELSE '<1990'
       END::spending_tier,
       updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric) - ${sql.raw(retainedRefundFeeSql('sale_orders.sale_order_id'))}, 0)), 0) AS total
         FROM sale_orders
         WHERE client_user_id = ${clientUserId}
           AND status IN ('已支付', '已完成')
           AND sale_order_type IN ('销售单','转换单')
       ) t
     WHERE user_id = ${clientUserId}
  `)
  return rowsAffected(res) > 0
}

/**
 * 段 4：member_level 单顾客重算（仅会员客）。
 *
 * 复用 cron processUpgrade / processDowngrade，幂等键
 * `member-upgrade-${userId}-${toLevel}` 与 cron 共享，避免重复发权益。
 */
async function recomputeMemberLevelForUser(
  clientUserId: string,
): Promise<RecomputeResult['memberLevelChange']> {
  const memberThreshold = await getMemberThreshold(db)
  const benefitsConfig = await loadJsonConfig<BenefitsConfig>(db, 'member_level_benefits')

  const rows = (await db.execute(sql`
    SELECT
      cwu.user_id,
      cwu.member_level,
      cwu.member_level_locked_until,
      cwu.became_member_at,
      COALESCE(SUM(GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)) FILTER (
        WHERE so.sale_order_type IN ('销售单','转换单')
          AND so.paid_at >= (NOW() - INTERVAL '12 months')
      ), 0) AS spend
    FROM client_wechat_users cwu
    LEFT JOIN sale_orders so ON so.client_user_id = cwu.user_id
    WHERE cwu.user_id = ${clientUserId}
      AND cwu.customer_type = '会员客'
    GROUP BY cwu.user_id, cwu.member_level, cwu.member_level_locked_until, cwu.became_member_at
  `)) as Array<{
    user_id: string
    member_level: string | null
    member_level_locked_until: Date | string | null
    became_member_at: Date | string | null
    spend: string | number
  }>

  const row = rows[0]
  if (!row) return null

  const spend = Number(row.spend ?? 0)
  const newLevel = determineMemberLevel(spend, memberThreshold)
  const oldLevel = row.member_level
  if (newLevel === oldLevel) return null

  if (isUpgrade(oldLevel as never, newLevel)) {
    await processUpgrade(db, row.user_id, oldLevel, newLevel, spend, benefitsConfig, undefined, {
      becameMemberAt: row.became_member_at,
      grantBenefits: shouldGrantMemberUpgradeBenefits(oldLevel, row.became_member_at),
    })
    return { from: oldLevel, to: newLevel, action: 'upgrade' }
  }
  if (isDowngrade(oldLevel as never, newLevel)) {
    const held = await processDowngrade(
      db,
      row.user_id,
      oldLevel,
      newLevel,
      spend,
      row.member_level_locked_until,
    )
    return { from: oldLevel, to: newLevel, action: held ? 'held' : 'downgrade' }
  }
  return null
}

/**
 * 主入口：单顾客全套标签重算。
 *
 * 段 1+2+3 在传入的事务（来自 approveLegacyOrder）内执行；段 4 独立事务
 * （processUpgrade/processDowngrade 内含 db.transaction，无法嵌套到外层 tx）。
 *
 * 因此调用方应该先 COMMIT 完订单状态更新 + 1+2+3，再调本函数（或先调本函数再 COMMIT）。
 * 推荐用法：approveLegacyOrder 在事务内调 partial 版（只跑 1+2+3），事务后调 member_level 段。
 *
 * 但为了简单，本函数提供 all-in-one 版：先开 tx 跑 1+2+3，COMMIT 后再跑 member_level。
 * approveLegacyOrder 自己写更细粒度版本。
 */
export async function recomputeCustomerTagsForUser(clientUserId: string): Promise<RecomputeResult> {
  if (!clientUserId) {
    return {
      customerStatusUpdated: false,
      customerTypeChanged: null,
      spendingTierUpdated: false,
      memberLevelChange: null,
    }
  }

  const { statusUpdated, typeChanged, tierUpdated } = await db.transaction(async (tx) => {
    const typeChanged = await recomputeCustomerTypeForUser(tx, clientUserId)
    const statusUpdated = await recomputeCustomerStatusForUser(tx, clientUserId)
    const tierUpdated = await recomputeSpendingTierForUser(tx, clientUserId)
    return { statusUpdated, typeChanged, tierUpdated }
  })

  const memberLevelChange = await recomputeMemberLevelForUser(clientUserId)

  return {
    customerStatusUpdated: statusUpdated,
    customerTypeChanged: typeChanged,
    spendingTierUpdated: tierUpdated,
    memberLevelChange,
  }
}

/**
 * 事务内细粒度版（供 approveLegacyOrder 调用，与订单 UPDATE 同 tx）。
 * 只跑段 1+2+3；member_level 必须在事务外单独调 `recomputeMemberLevelOnly`。
 */
export async function recomputeCustomerTagsInTx(
  tx: Tx,
  clientUserId: string,
): Promise<Omit<RecomputeResult, 'memberLevelChange'>> {
  if (!clientUserId) {
    return {
      customerStatusUpdated: false,
      customerTypeChanged: null,
      spendingTierUpdated: false,
    }
  }
  const typeChanged = await recomputeCustomerTypeForUser(tx, clientUserId)
  const statusUpdated = await recomputeCustomerStatusForUser(tx, clientUserId)
  const tierUpdated = await recomputeSpendingTierForUser(tx, clientUserId)
  return {
    customerStatusUpdated: statusUpdated,
    customerTypeChanged: typeChanged,
    spendingTierUpdated: tierUpdated,
  }
}

/**
 * 退款审批通道专用入口（#524 第 5 条 / #545）。
 *
 * 已退款订单退出达标判定后，须按剩余有效订单重算 customer_type 并**允许降档**——
 * 这是全仓唯一放行降档的通道（每日 cron / 离线 / 历史审核 / 收款一律只升不降）。
 * 与 staffApi `order.approveRefund` 里传 allowDowngrade=true 的 recalcCustomerType 同语义。
 */
export async function recomputeCustomerTypeOnRefund(
  tx: Tx,
  clientUserId: string,
): Promise<{ from: string | null; to: string | null } | null> {
  if (!clientUserId) return null
  return recomputeCustomerTypeForUser(tx, clientUserId, true)
}

/**
 * member_level 单独入口（必须在外层 tx COMMIT 之后调，因内部含独立 db.transaction）。
 */
export async function recomputeMemberLevelOnly(
  clientUserId: string,
): Promise<RecomputeResult['memberLevelChange']> {
  if (!clientUserId) return null
  return await recomputeMemberLevelForUser(clientUserId)
}
