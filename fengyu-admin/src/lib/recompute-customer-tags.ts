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
 * 四端 SQL 镜像副本（admin orders.ts + admin refunds 链路 + staffApi order.js + payNotify index.js
 * + 本 helper）。SQL 字面必须与其它三端一致；守护测试：
 * fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js
 */
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

  // 四端 SQL 镜像副本，修改时必须同步另外三端（admin orders.ts + staffApi order.js + payNotify index.js）；
  // 一致性由 recalc-customer-type-sql.test.js 守护。
  const typeRes = await tx.execute(sql`
    SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM sale_orders o
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND o.total_amount >= ${threshold}
       ) THEN '会员客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = false
       ) THEN '小美客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = true
       ) THEN '体验客'
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
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = ${clientUserId}
    `)
    // 给触发本次首次跃迁的达标销售单打会员升级标记（WHERE 与会员客判定 CASE 同源；四端镜像）。
    await tx.execute(sql`
      UPDATE sale_orders SET is_membership_upgrade = true
      WHERE sale_order_id = (
        SELECT o.sale_order_id FROM sale_orders o
        WHERE o.client_user_id = ${clientUserId}
          AND o.status IN ('已支付', '已完成')
          AND o.sale_order_type = '销售单'
          AND o.total_amount >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
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
      COALESCE(SUM(GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)) FILTER (
        WHERE so.sale_order_type IN ('销售单','转换单')
          AND so.paid_at >= (NOW() - INTERVAL '12 months')
      ), 0) AS spend
    FROM client_wechat_users cwu
    LEFT JOIN sale_orders so ON so.client_user_id = cwu.user_id
    WHERE cwu.user_id = ${clientUserId}
      AND cwu.customer_type = '会员客'
    GROUP BY cwu.user_id, cwu.member_level, cwu.member_level_locked_until
  `)) as Array<{
    user_id: string
    member_level: string | null
    member_level_locked_until: Date | string | null
    spend: string | number
  }>

  const row = rows[0]
  if (!row) return null

  const spend = Number(row.spend ?? 0)
  const newLevel = determineMemberLevel(spend, memberThreshold)
  const oldLevel = row.member_level
  if (newLevel === oldLevel) return null

  if (isUpgrade(oldLevel as never, newLevel)) {
    await processUpgrade(db, row.user_id, oldLevel, newLevel, spend, benefitsConfig)
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
