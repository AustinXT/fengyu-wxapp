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

interface BenefitItem {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}
type BenefitsConfig = Record<string, BenefitItem>

export interface MemberLevelsResult {
  total: number
  upgradeCount: number
  downgradeCount: number
  heldCount: number
  unchangedCount: number
  errorCount: number
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function refreshMemberLevels(db: Db): Promise<MemberLevelsResult> {
  const benefitsConfig = await loadJsonConfig<BenefitsConfig>(db, 'member_level_benefits')
  const memberThreshold = await getMemberThreshold(db)

  const memberClients = (await db.execute(sql`
    SELECT user_id, member_level, member_level_locked_until
    FROM client_wechat_users
    WHERE customer_type = '会员客'
  `)) as Array<{
    user_id: string
    member_level: string | null
    member_level_locked_until: Date | string | null
  }>

  let upgradeCount = 0
  let downgradeCount = 0
  let heldCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const row of memberClients) {
    try {
      // 2026-04-26 sale-order-domain-refactor:
      //   - paid_amount 列已 DROP，统一改用 received（unique source of truth）
      //   - saleOrderType 5→3（删除"回款单"/"退款单"），过滤改为正向枚举 IN
      //   - 业绩口径：received - refunded_amount（已含 5 通道退款冲销）；
      //     退款审批通过后会同事务双写 refunded_amount，因此不再需要按 type 过滤退款单
      const spendRows = (await db.execute(sql`
        SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) AS spend
        FROM sale_orders
        WHERE client_user_id = ${row.user_id}
          AND sale_order_type IN ('销售单','转换单')
          AND paid_at >= (NOW() - INTERVAL '12 months')
      `)) as Array<{ spend: string | number }>

      const spend = Number(spendRows[0]?.spend ?? 0)
      const newLevel = determineMemberLevel(spend, memberThreshold)
      const oldLevel = row.member_level

      if (newLevel === oldLevel) {
        unchangedCount++
        continue
      }

      if (isUpgrade(oldLevel as never, newLevel)) {
        await processUpgrade(db, row.user_id, oldLevel, newLevel, spend, benefitsConfig)
        upgradeCount++
      } else if (isDowngrade(oldLevel as never, newLevel)) {
        const held = await processDowngrade(
          db,
          row.user_id,
          oldLevel,
          newLevel,
          spend,
          row.member_level_locked_until,
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
 */
async function processUpgrade(
  db: Db,
  userId: string,
  oldLevel: string | null,
  newLevel: string | null,
  spend: number,
  benefitsConfig: BenefitsConfig | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE client_wechat_users
         SET old_member_level = member_level,
             member_level = ${newLevel},
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NOW() + INTERVAL '150 days',
             updated_at = NOW()
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
      await grantUpgradeBenefits(tx, userId, newLevel, benefitsConfig[newLevel])
    }
  })
}

/**
 * 降级路径：保级期内只记 memberLevelHeld 日志（无事务，单条 INSERT）；
 * 保级期已过 → UPDATE 等级 + 清 locked_until + memberLevelChange 日志（事务）。
 *
 * @returns true=保级跳过；false=实际降级
 */
async function processDowngrade(
  db: Db,
  userId: string,
  oldLevel: string | null,
  newLevel: string | null,
  spend: number,
  lockedUntil: Date | string | null,
): Promise<boolean> {
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
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

      let expireAt: Date
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(Date.now() + 365 * 86400000)
      }

      const couponId = `cpn-up-${userId}-${toLevel}-${templateId}`
      await tx.execute(sql`
        INSERT INTO user_coupons
          (coupon_id, template_id, user_id, status, expire_at, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireAt}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
