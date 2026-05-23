/**
 * STEP 2 — member_level 重算 + 升降级权益发放
 * 迁自 cronTask/index.js:215-384（refreshMemberLevels / processUpgrade / processDowngrade / grantUpgradeBenefits）
 *
 * 事务模型：
 *   - 外层 refreshMemberLevels 无事务，按用户循环
 *   - processUpgrade / processDowngrade（实际降级路径）各自 db.transaction：
 *     UPDATE + operation_logs + grantUpgradeBenefits 三件套同事务
 *   - 单用户失败 → ROLLBACK 该用户、errorCount++、继续下个用户
 *
 * 不写 became_member_at（仅在 customer_type 跃迁到 '会员客' 时由 staffApi/payNotify 写入）。
 *
 * 幂等键：
 *   消息 idempotency_key  = `member-upgrade-${userId}-${toLevel}`
 *   积分 external_ref     = `member-upgrade-${userId}-${toLevel}`
 *   优惠券 coupon_id      = `cpn-up-${userId}-${toLevel}-${templateId}`
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { determineMemberLevel, isUpgrade, isDowngrade } from '../lib/member-level'
import { loadJsonConfig } from '../lib/benefits-loader'
import { getMemberThreshold } from '../config'
import { type CronContext, nowSqlOf, nowOf } from '../lib/cron-context'

export interface BenefitItem {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}
export type BenefitsConfig = Record<string, BenefitItem>

export interface MemberLevelsResult {
  total: number
  upgradeCount: number
  downgradeCount: number
  heldCount: number
  unchangedCount: number
  errorCount: number
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 支付链路即时升级后，cron 幂等补发礼包的回看窗口（覆盖上次 cron 至今，留余量）。 */
const RECENT_UPGRADE_WINDOW_MS = 36 * 60 * 60 * 1000

/** 该用户的 member_level 是否在近 RECENT_UPGRADE_WINDOW_MS 内被升级过（含支付链路即时升级）。 */
function wasRecentlyUpgraded(
  upgradedAt: Date | string | null,
  ctx?: CronContext,
): boolean {
  if (!upgradedAt) return false
  return nowOf(ctx).getTime() - new Date(upgradedAt).getTime() <= RECENT_UPGRADE_WINDOW_MS
}

export async function refreshMemberLevels(
  db: Db,
  ctx?: CronContext,
): Promise<MemberLevelsResult> {
  const benefitsConfig = await loadJsonConfig<BenefitsConfig>(db, 'member_level_benefits')
  const memberThreshold = await getMemberThreshold(db)
  const nowSql = nowSqlOf(ctx)

  // 2026-05-17 perf: 把"每个用户一次 SELECT spend"折叠成单次 JOIN+GROUP BY，
  // 1647 用户 × 142k sale_orders 实测 ~136ms（vs 原 ~210s，~1500× 提速）。
  //
  // 等价口径（保持完全一致）：
  //   - paid_amount 列已 DROP，统一改用 received（unique source of truth）
  //   - saleOrderType 5→3（删除"回款单"/"退款单"），过滤改为正向枚举 IN
  //   - 业绩口径：received - refunded_amount（已含 5 通道退款冲销）；
  //     退款审批通过后会同事务双写 refunded_amount，因此不再需要按 type 过滤退款单
  //   - LEFT JOIN + FILTER 保证无订单/订单全过期的用户 spend=0（与原 COALESCE(SUM,0) 等价）
  const memberClients = (await db.execute(sql`
    SELECT
      cwu.user_id,
      cwu.member_level,
      cwu.member_level_locked_until,
      cwu.member_level_upgraded_at,
      COALESCE(SUM(GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)) FILTER (
        WHERE so.sale_order_type IN ('销售单','转换单')
          AND so.paid_at >= (${nowSql} - INTERVAL '12 months')
      ), 0) AS spend
    FROM client_wechat_users cwu
    LEFT JOIN sale_orders so ON so.client_user_id = cwu.user_id
    WHERE cwu.customer_type = '会员客'
    GROUP BY cwu.user_id, cwu.member_level, cwu.member_level_locked_until, cwu.member_level_upgraded_at
  `)) as Array<{
    user_id: string
    member_level: string | null
    member_level_locked_until: Date | string | null
    member_level_upgraded_at: Date | string | null
    spend: string | number
  }>

  let upgradeCount = 0
  let downgradeCount = 0
  let heldCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const row of memberClients) {
    try {
      const spend = Number(row.spend ?? 0)
      const newLevel = determineMemberLevel(spend, memberThreshold)
      const oldLevel = row.member_level

      if (newLevel === oldLevel) {
        // 支付结算链路（payNotify / staffApi / clientApi）可能已在 cron 之外把等级即时升到位，
        // 但升级礼包（消息/积分/优惠券）仍由本 cron 发放。此时 newLevel === oldLevel 会跳过
        // processUpgrade → 礼包丢失。故对近 36h 内升级过的会员客幂等补发礼包
        // （grantUpgradeBenefits 内 idempotency_key / external_ref / coupon_id 防重复，
        // 旧升级重试即 no-op；窗口限定避免对全部会员客无谓尝试）。
        if (
          newLevel &&
          benefitsConfig?.[newLevel] &&
          wasRecentlyUpgraded(row.member_level_upgraded_at, ctx)
        ) {
          await db.transaction(async (tx) => {
            await grantUpgradeBenefits(tx, row.user_id, newLevel, benefitsConfig[newLevel], ctx)
          })
        }
        unchangedCount++
        continue
      }

      if (isUpgrade(oldLevel as never, newLevel)) {
        await processUpgrade(db, row.user_id, oldLevel, newLevel, spend, benefitsConfig, ctx)
        upgradeCount++
      } else if (isDowngrade(oldLevel as never, newLevel)) {
        const held = await processDowngrade(
          db,
          row.user_id,
          oldLevel,
          newLevel,
          spend,
          row.member_level_locked_until,
          ctx,
        )
        if (held) heldCount++
        else downgradeCount++
      } else {
        unchangedCount++
      }
    } catch (err) {
      console.error(
        `[cron-worker/memberLevel] failed for ${row.user_id}:`,
        (err as Error).message,
      )
      errorCount++
    }
  }

  return {
    total: memberClients.length,
    upgradeCount,
    downgradeCount,
    heldCount,
    unchangedCount,
    errorCount,
  }
}

/**
 * 升级路径：UPDATE 等级 + 写 150 天保级期 + memberLevelChange 日志 + 三件套权益
 * 全在一个事务内；任一步失败 → 全部回滚（包括权益发放）。
 *
 * 2026-05-18：export 给 src/lib/recompute-customer-tags.ts 复用（历史订单审核通过时单顾客触发）。
 */
export async function processUpgrade(
  db: Db,
  userId: string,
  oldLevel: string | null,
  newLevel: string | null,
  spend: number,
  benefitsConfig: BenefitsConfig | null,
  ctx?: CronContext,
): Promise<void> {
  const nowSql = nowSqlOf(ctx)
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE client_wechat_users
         SET old_member_level = member_level,
             member_level = ${newLevel},
             member_level_upgraded_at = ${nowSql},
             member_level_locked_until = ${nowSql} + INTERVAL '150 days',
             updated_at = ${nowSql}
       WHERE user_id = ${userId}
         AND member_level IS DISTINCT FROM ${newLevel}
    `)

    const detail = JSON.stringify({
      _v: 3,
      _t: 'transition',
      from: oldLevel,
      to: newLevel,
      context: {
        rolling12mSpend: spend,
        trigger: 'cronTask',
        direction: 'upgrade',
        lockedUntil: '+150d',
      },
    })
    await tx.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('customer.memberLevelChange', 'customer', ${userId}, ${detail}::jsonb, 'cronTask', NOW())
    `)

    if (newLevel && benefitsConfig?.[newLevel]) {
      await grantUpgradeBenefits(tx, userId, newLevel, benefitsConfig[newLevel], ctx)
    }
  })
}

/**
 * 降级路径：保级期内只记 memberLevelHeld 日志（无事务，单条 INSERT）；
 * 保级期已过 → UPDATE 等级 + 清 locked_until + memberLevelChange 日志（事务）。
 *
 * @returns true=保级跳过；false=实际降级
 */
export async function processDowngrade(
  db: Db,
  userId: string,
  oldLevel: string | null,
  newLevel: string | null,
  spend: number,
  lockedUntil: Date | string | null,
  ctx?: CronContext,
): Promise<boolean> {
  if (lockedUntil && new Date(lockedUntil) > nowOf(ctx)) {
    const detail = JSON.stringify({
      _v: 3,
      _t: 'hold',
      currentLevel: oldLevel,
      recomputedLevel: newLevel,
      context: { rolling12mSpend: spend, lockedUntil, reason: '150d_lock' },
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('customer.memberLevelHeld', 'customer', ${userId}, ${detail}::jsonb, 'cronTask', NOW())
    `)
    return true
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE client_wechat_users
         SET old_member_level = member_level,
             member_level = ${newLevel},
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NULL,
             updated_at = NOW()
       WHERE user_id = ${userId}
         AND member_level IS DISTINCT FROM ${newLevel}
    `)
    const detail = JSON.stringify({
      _v: 3,
      _t: 'transition',
      from: oldLevel,
      to: newLevel,
      context: { rolling12mSpend: spend, trigger: 'cronTask', direction: 'downgrade' },
    })
    await tx.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('customer.memberLevelChange', 'customer', ${userId}, ${detail}::jsonb, 'cronTask', NOW())
    `)
  })
  return false
}

/**
 * 升级三件套：消息 / 积分 / 优惠券。
 *
 * 积分规则（与原 cronTask 一致）：流水插入成功（未发生幂等冲突）时才累加 points_balance，
 * 避免幂等冲突情况下重复增加余额。
 */
async function grantUpgradeBenefits(
  tx: Tx,
  userId: string,
  toLevel: string,
  config: BenefitItem,
  ctx?: CronContext,
): Promise<void> {
  const idemKey = `member-upgrade-${userId}-${toLevel}`

  // 1) 消息
  if (config.messageTitle) {
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody ?? null},
              'system', ${idemKey}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  // 2) 积分
  if (config.points && config.points > 0) {
    const inserted = (await tx.execute(sql`
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '等级升级奖励', ${config.points}, NULL, ${idemKey}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as Array<{ id: number }>
    if (inserted.length > 0) {
      await tx.execute(sql`
        UPDATE client_wechat_users
           SET points_balance = COALESCE(points_balance, 0) + ${config.points},
               points_updated_at = NOW()
         WHERE user_id = ${userId}
      `)
    }
  }

  // 3) 优惠券
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT validity_mode, valid_days, valid_to, is_active
        FROM coupon_templates
        WHERE template_id = ${templateId}
      `)) as Array<{
        validity_mode: string | null
        valid_days: number | null
        valid_to: Date | string | null
        is_active: boolean | null
      }>
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(
          `[cron-worker/upgrade] 跳过优惠券 ${templateId}: 模板不存在或已停用`,
        )
        continue
      }

      const baseMs = nowOf(ctx).getTime()
      let expireAt: Date
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(baseMs + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(baseMs + 365 * 86400000)
      }

      const couponId = `cpn-up-${userId}-${toLevel}-${templateId}`
      const externalRef = couponId  // 双写 external_ref：DB 层 uq_user_coupons_external_ref 兜底
      await tx.execute(sql`
        INSERT INTO user_coupons
          (coupon_id, template_id, user_id, status, expire_at, external_ref, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireAt.toISOString()}, ${externalRef}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
