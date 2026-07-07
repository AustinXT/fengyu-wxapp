

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { loadJsonConfig } from '../lib/benefits-loader'
import { type CronContext, dateSqlOf, nowOf } from '../lib/cron-context'
import { beijingTs } from '@/lib/db-time'

interface BenefitItem {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}
type BirthdayConfig = Record<string, BenefitItem>

export interface BirthdayResult {
  total: number
  sentCount: number
  skippedNoConfig: number
  errorCount: number
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function grantBirthdayBenefits(
  db: Db,
  ctx?: CronContext,
): Promise<BirthdayResult> {
  const benefitsConfig = await loadJsonConfig<BirthdayConfig>(db, 'birthday_benefits')
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  const dateSql = dateSqlOf(ctx)
  const yearRows = (await db.execute(sql`
    SELECT EXTRACT(YEAR FROM ${dateSql})::int AS year
  `)) as Array<{ year: number }>
  const year = yearRows[0].year

  const rows = (await db.execute(sql`
    SELECT user_id, member_level
    FROM client_wechat_users
    WHERE birthday IS NOT NULL
      AND member_level IS NOT NULL
      AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM ${dateSql})
      AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM ${dateSql})
  `)) as Array<{ user_id: string; member_level: string }>

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    try {
      await db.transaction(async (tx) => {
        await grantOneBirthday(tx, row.user_id, year, cfg, ctx)
        const detail = JSON.stringify({
          _v: 1,
          _t: 'birthday',
          year,
          memberLevel: row.member_level,
          config: {
            points: cfg.points || 0,
            couponTemplateCount: Array.isArray(cfg.couponTemplateIds)
              ? cfg.couponTemplateIds.length
              : 0,
            messageTitle: cfg.messageTitle || null,
          },
        })
        await tx.execute(sql`
          INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
          VALUES ('customer.birthdayBenefits', 'customer', ${row.user_id}, ${detail}::jsonb, 'cronTask', NOW())
        `)
      })
      sentCount++
    } catch (err) {
      console.error(
        `[cron-worker/birthday] failed for ${row.user_id}:`,
        (err as Error).message,
      )
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

async function grantOneBirthday(
  tx: Tx,
  userId: string,
  year: number,
  config: BenefitItem,
  ctx?: CronContext,
): Promise<void> {
  
  if (config.messageTitle) {
    const idem = `birthday-msg-${year}-${userId}`
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody ?? null},
              'system', ${idem}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  
  if (config.points && config.points > 0) {
    const externalRef = `birthday-pts-${year}-${userId}`
    const inserted = (await tx.execute(sql`
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '生日积分', ${config.points}, NULL, ${externalRef}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as Array<{ id: number }>
    if (inserted.length > 0) {
      await tx.execute(sql`
        UPDATE client_wechat_users
           SET points_balance = points_balance + ${config.points},
               points_updated_at = NOW()
         WHERE user_id = ${userId}
      `)
    }
  }

  
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT validity_mode, valid_days, valid_to, is_active
        FROM coupon_templates WHERE template_id = ${templateId}
      `)) as Array<{
        validity_mode: string | null
        valid_days: number | null
        valid_to: Date | string | null
        is_active: boolean | null
      }>
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(
          `[cron-worker/birthday] 跳过优惠券 ${templateId}: 模板不存在或已停用`,
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

      const couponId = `bday-${year}-${userId}-${templateId}`
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
