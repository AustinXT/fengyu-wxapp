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

import { sql } from 'drizzle-orm'
import { db } from '@/db'
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
 * 段 2：customer_type 跃迁（只升不降）。
 *
 * 八处 SQL 镜像副本：五处运行时（staffApi order.js + clientApi order.js + payNotify index.js
 * + admin orders.ts + 本 helper）逐字一致，三个 db/scripts 批量脚本（recalc-all-customer-types.js
 * + recalc-became-member-at.js + backfill-membership-upgrade-doc-type.js）结构对齐。
 * SQL 字面必须与其余七处一致；守护测试：
 * fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js
 */
/**
 * 顾客分类跃迁的订单级金额 CTE（#187）。产出每张已结清销售单的
 * non_trial / trial = 非体验 / 体验行的毛实收合计（received 净额 + 该行逐项退款额）。
 * refund_by_item 的 note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js
 * RECEIVED_REFUNDED_DEDUCT_SQL，根除 22P02。八处副本逐字一致，由 recalc-customer-type-sql.test.js 守护。
 */
const recalcCustomerTypeCte = (clientUserId: string) => sql`WITH refund_by_item AS (
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
       WHERE ro.client_user_id = ${clientUserId}
         AND ro.status IN ('已支付', '已完成')
         AND ro.sale_order_type = '销售单'
         AND sop.change_type = '退款'
         AND sop.status = '已支付'
         AND elem ->> 'refSaleItemId' <> 'OVERPAY'
       -- 序号绑定 SELECT 的前 2 列（sale_order_id, refSaleItemId）；重排 SELECT 列须同步改这里
       GROUP BY 1, 2
     ),
     order_amounts AS (
       SELECT o.sale_order_id,
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
       WHERE o.client_user_id = ${clientUserId}
         AND o.status IN ('已支付', '已完成')
         AND o.sale_order_type = '销售单'
       GROUP BY o.sale_order_id, o.received
     )`

async function recomputeCustomerTypeForUser(
  tx: Tx,
  clientUserId: string,
): Promise<{ from: string | null; to: string | null } | null> {
  const curRes = await tx.execute(sql`
    SELECT customer_type FROM client_wechat_users WHERE user_id = ${clientUserId}
  `)
  const curRows = curRes as unknown as Array<{ customer_type: string }>
  const oldType = curRows[0]?.customer_type ?? null
  if (oldType === '会员客') return null

  const threshold = await getMemberThreshold(db)

  // 八处 SQL 镜像副本，修改时必须同步其余七处（staffApi order.js + clientApi order.js + payNotify index.js
  // + admin orders.ts + 本文件 + db/scripts/recalc-all-customer-types.js + db/scripts/recalc-became-member-at.js）；
  // 一致性由 recalc-customer-type-sql.test.js 守护。
  // #187（2026-09-18）：按单笔订单的非体验部分毛实收判定（received 净额 + 逐项退款额），落地 Q5.2 决策。
  const typeRes = await tx.execute(sql`
    ${recalcCustomerTypeCte(clientUserId)}
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
       AND (CASE customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
         < (CASE ${newType}::customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
     RETURNING customer_type
  `)
  const updRowCount = rowsAffected(updRes)
  const updRows = updRes as unknown as Array<{ customer_type: string }>
  if (updRowCount === 0) return null

  if (updRows[0]?.customer_type === '会员客') {
    // became_member_at 记为确立会员资格的首笔达标单时间（COALESCE(paid_at, created_at)）；
    // 选单子查询与下方 is_membership_upgrade 归因同源、选同一单。
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = COALESCE((
        ${recalcCustomerTypeCte(clientUserId)}
        SELECT COALESCE(o.paid_at, o.created_at) FROM sale_orders o
        JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
        WHERE oa.non_trial >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC
        LIMIT 1
      ), became_member_at) WHERE user_id = ${clientUserId}
    `)
    // 给触发本次首次跃迁的达标销售单打会员升级标记（WHERE 与会员客判定 CASE 同源；八处镜像逐字一致）。
    // 2026-09-18 (#187) 订正：旧注释称「payNotify 端额外含回款单累计分支」已不成立——
    // sale-order-domain-refactor 后该分支即被删除，七处归因段一直是同一口径，现统一为 oa.non_trial >= 阈值。
    await tx.execute(sql`
      UPDATE sale_orders SET is_membership_upgrade = true
      WHERE sale_order_id = (
        ${recalcCustomerTypeCte(clientUserId)}
        SELECT o.sale_order_id FROM sale_orders o
        JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
        WHERE oa.non_trial >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC
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
         SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) AS total
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
    const statusUpdated = await recomputeCustomerStatusForUser(tx, clientUserId)
    const typeChanged = await recomputeCustomerTypeForUser(tx, clientUserId)
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
  const statusUpdated = await recomputeCustomerStatusForUser(tx, clientUserId)
  const typeChanged = await recomputeCustomerTypeForUser(tx, clientUserId)
  const tierUpdated = await recomputeSpendingTierForUser(tx, clientUserId)
  return {
    customerStatusUpdated: statusUpdated,
    customerTypeChanged: typeChanged,
    spendingTierUpdated: tierUpdated,
  }
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
