

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { determineMemberLevel, isUpgrade, isDowngrade } from '../lib/member-level'
import { loadJsonConfig } from '../lib/benefits-loader'
import { getMemberThreshold } from '../config'
import { type CronContext, nowSqlOf, nowOf } from '../lib/cron-context'
import { beijingTs } from '@/lib/db-time'

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


const RECENT_UPGRADE_WINDOW_MS = 36 * 60 * 60 * 1000


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


async function grantUpgradeBenefits(
  tx: Tx,
  userId: string,
  toLevel: string,
  config: BenefitItem,
  ctx?: CronContext,
): Promise<void> {
  const idemKey = `member-upgrade-${userId}-${toLevel}`

  
  if (config.messageTitle) {
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody ?? null},
              'system', ${idemKey}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  
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
      const externalRef = couponId  
      await tx.execute(sql`
        INSERT INTO user_coupons
          (coupon_id, template_id, user_id, status, expire_at, external_ref, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${beijingTs(expireAt)}, ${externalRef}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
